import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getCachedResponse, setCachedResponse } from '../services/cache.service';
import { logEvent } from '../services/audit.service';

const router = Router();

// Zod validation
const suggestSchema = z.object({
  text: z.string().min(1, 'Text is required').max(500, 'Text must be 500 characters or less'),
});

// POST /query/suggest
router.post('/suggest', async (req: Request, res: Response): Promise<void> => {
  // Read at request time so tests can set the env var dynamically
  const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';
  const startTime = Date.now();

  try {
    // Validate input
    const validation = suggestSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: validation.error.errors[0].message,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const { text } = validation.data;

    // tenantId comes from JWT middleware — NEVER from req.body
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({
        error: 'Missing tenant context',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    // Step 1: Get embedding from Python service
    const embedResponse = await fetch(`${PYTHON_SERVICE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!embedResponse.ok) {
      res.status(503).json({
        error: 'Embedding service unavailable',
        code: 'SERVICE_UNAVAILABLE',
      });
      return;
    }

    const embedData = await embedResponse.json() as { vector: number[] };

    // Step 2: Check cache
    const cached = await getCachedResponse(tenantId, embedData.vector);
    if (cached) {
      // CACHE HIT — stream cached SSE directly
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(cached);
      res.end();

      // Fire-and-forget audit log
      const elapsed = Date.now() - startTime;
      logEvent(tenantId, 'cache_hit', text, elapsed).catch(() => {});
      return;
    }

    // Step 3: Cache miss — call RAG service
    const ragResponse = await fetch(`${PYTHON_SERVICE_URL}/rag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,  // from JWT, never from req.body
        query_vector: embedData.vector,
        query_text: text,
      }),
    });

    if (!ragResponse.ok || !ragResponse.body) {
      res.status(503).json({
        error: 'RAG service unavailable',
        code: 'SERVICE_UNAVAILABLE',
      });
      return;
    }

    // Step 4: Set SSE headers, stream to client WHILE collecting buffer
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = ragResponse.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);      // Stream to client immediately
        sseBuffer += chunk;    // Also collect for cache
      }
    } catch {
      res.write('data: {"error": "Service unavailable", "done": true}\n\n');
    }

    res.end();

    // Step 5: Store in cache (fire-and-forget)
    setCachedResponse(tenantId, embedData.vector, sseBuffer).catch(() => {});

    // Step 6: Audit log (fire-and-forget)
    const elapsed = Date.now() - startTime;
    logEvent(tenantId, 'rag_query', text, elapsed).catch(() => {});

  } catch (err: unknown) {
    // If headers haven't been sent, return JSON error
    if (!res.headersSent) {
      res.status(503).json({
        error: 'Service unavailable',
        code: 'SERVICE_UNAVAILABLE',
      });
    } else {
      // If we're mid-stream, send SSE error and close
      res.write('data: {"error": "Service unavailable", "done": true}\n\n');
      res.end();
    }
  }
});

export default router;
