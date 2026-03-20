import { Router, Request, Response } from 'express';
import multer from 'multer';
import { DocumentModel } from '../models/document.model';
import { logEvent } from '../services/audit.service';

const router = Router();

// Multer config: in-memory storage, 10 MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Map file extensions to supported file types
function getFileType(filename: string): 'whatsapp' | 'pdf' | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'txt') return 'whatsapp';
  if (ext === 'pdf') return 'pdf';
  return null;
}

// POST /documents/upload
router.post('/upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Missing tenant context', code: 'UNAUTHORIZED' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file provided', code: 'VALIDATION_ERROR' });
      return;
    }

    const fileType = getFileType(req.file.originalname);
    if (!fileType) {
      res.status(400).json({
        error: 'Unsupported file type. Only .txt and .pdf files are allowed',
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    // Create document record with status: processing
    const doc = await DocumentModel.create({
      tenantId,
      originalFilename: req.file.originalname,
      fileType,
      status: 'processing',
      pineconeNamespace: `user_${tenantId}`,
    });

    try {
      // Prepare content for Python service
      let content: string;
      if (fileType === 'pdf') {
        content = req.file.buffer.toString('base64');
      } else {
        content = req.file.buffer.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }

      // Call Python ingest endpoint
      const ingestResponse = await fetch(`${PYTHON_SERVICE_URL}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          document_id: doc._id!.toString(),
          file_type: fileType,
          content,
        }),
      });

      if (!ingestResponse.ok) {
        const errorData = await ingestResponse.json() as { detail?: { error?: string } };
        await DocumentModel.findByIdAndUpdate(doc._id, { status: 'error' });
        res.status(502).json({
          error: errorData?.detail?.error || 'Ingestion service failed',
          code: 'INGESTION_ERROR',
        });
        return;
      }

      const ingestData = await ingestResponse.json() as { vectors_upserted: number };

      // Update document to ready
      await DocumentModel.findByIdAndUpdate(doc._id, {
        status: 'ready',
        chunkCount: ingestData.vectors_upserted,
      });

      const updatedDoc = await DocumentModel.findById(doc._id);

      // Fire-and-forget audit log
      logEvent(tenantId, 'upload', req.file.originalname, 0).catch(() => {});

      res.status(201).json(updatedDoc);
    } catch {
      await DocumentModel.findByIdAndUpdate(doc._id, { status: 'error' });
      res.status(503).json({ error: 'Ingestion service unavailable', code: 'SERVICE_UNAVAILABLE' });
    }
  } catch {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// GET /documents
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Missing tenant context', code: 'UNAUTHORIZED' });
      return;
    }

    // ALWAYS filter by tenantId — never return other tenants' docs
    const docs = await DocumentModel.find({ tenantId }).sort({ createdAt: -1 });
    res.status(200).json(docs);
  } catch {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// DELETE /documents/:id
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Missing tenant context', code: 'UNAUTHORIZED' });
      return;
    }

    const doc = await DocumentModel.findById(req.params.id);

    if (!doc) {
      res.status(404).json({ error: 'Document not found', code: 'NOT_FOUND' });
      return;
    }

    // Extra safety: verify tenantId matches
    if (doc.tenantId !== tenantId) {
      res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      return;
    }

    // Delete vectors from Pinecone via Python service
    try {
      await fetch(`${PYTHON_SERVICE_URL}/namespace`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
      });
    } catch {
      // Log error but proceed with MongoDB deletion
      console.error('Pinecone namespace deletion failed');
    }

    // Delete document from MongoDB
    await DocumentModel.findByIdAndDelete(doc._id);

    // Fire-and-forget audit log
    logEvent(tenantId, 'delete', doc.originalFilename, 0).catch(() => {});

    res.status(204).send();
  } catch {
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

export default router;
