import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import http from 'http';
import { app } from '../index';
import { User } from '../models/user.model';
import { DocumentModel } from '../models/document.model';

let mongoServer: MongoMemoryServer;
let mockPythonServer: http.Server;

// Mock Python service that handles /ingest and DELETE /namespace
function createMockPythonServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/ingest' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', vectors_upserted: 3 }));
        } else if (req.url === '/namespace' && req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    server.listen(0, () => {
      resolve(server);
    });
  });
}

// Helper: register and get token
async function getAuthToken(email = 'doctest@example.com'): Promise<{ accessToken: string; tenantId: string }> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email, password: 'securePassword123' });
  return { accessToken: res.body.accessToken, tenantId: res.body.tenantId };
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-32-bytes!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-bytes!!!';
  process.env.NODE_ENV = 'test';

  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  mockPythonServer = await createMockPythonServer();
  const addr = mockPythonServer.address() as { port: number };
  process.env.PYTHON_SERVICE_URL = `http://localhost:${addr.port}`;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  mockPythonServer.close();
});

afterEach(async () => {
  await User.deleteMany({});
  await DocumentModel.deleteMany({});
});

describe('Documents Router', () => {
  // ── Test 1: POST /documents/upload without auth → 401 ───────────
  it('should return 401 without authentication', async () => {
    const res = await request(app)
      .post('/documents/upload')
      .attach('file', Buffer.from('test content'), 'test.txt')
      .expect(401);

    expect(res.body).toHaveProperty('code', 'UNAUTHORIZED');
  });

  // ── Test 2: POST /documents/upload with invalid file type → 400 ──
  it('should return 400 for unsupported file type', async () => {
    const { accessToken } = await getAuthToken();

    const res = await request(app)
      .post('/documents/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('test content'), 'test.csv')
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
    expect(res.body.error).toContain('Unsupported file type');
  });

  // ── Test 3: GET /documents returns only own documents ────────────
  it('should return only documents belonging to the authenticated tenant', async () => {
    const { accessToken: tokenA, tenantId: tenantA } = await getAuthToken('userA@example.com');
    const { tenantId: tenantB } = await getAuthToken('userB@example.com');

    // Seed documents for both tenants
    await DocumentModel.create([
      {
        tenantId: tenantA,
        originalFilename: 'a_file.txt',
        fileType: 'whatsapp',
        status: 'ready',
        chunkCount: 5,
        pineconeNamespace: `user_${tenantA}`,
      },
      {
        tenantId: tenantB,
        originalFilename: 'b_file.txt',
        fileType: 'whatsapp',
        status: 'ready',
        chunkCount: 3,
        pineconeNamespace: `user_${tenantB}`,
      },
    ]);

    const res = await request(app)
      .get('/documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].originalFilename).toBe('a_file.txt');
    expect(res.body[0].tenantId).toBe(tenantA);
  });

  // ── Test 4: DELETE /documents/:id owned by requester → 204 ──────
  it('should delete own document and return 204', async () => {
    const { accessToken, tenantId } = await getAuthToken('deletetest@example.com');

    const doc = await DocumentModel.create({
      tenantId,
      originalFilename: 'to_delete.txt',
      fileType: 'whatsapp',
      status: 'ready',
      chunkCount: 2,
      pineconeNamespace: `user_${tenantId}`,
    });

    await request(app)
      .delete(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    // Verify it's actually gone
    const found = await DocumentModel.findById(doc._id);
    expect(found).toBeNull();
  });

  // ── Test 5: DELETE /documents/:id owned by different tenant → 403 ─
  it('should return 403 when trying to delete another tenant\'s document', async () => {
    const { accessToken: tokenA } = await getAuthToken('tenantA@example.com');
    const { tenantId: tenantB } = await getAuthToken('tenantB@example.com');

    // Create a document owned by tenant B
    const doc = await DocumentModel.create({
      tenantId: tenantB,
      originalFilename: 'b_secret.txt',
      fileType: 'whatsapp',
      status: 'ready',
      chunkCount: 1,
      pineconeNamespace: `user_${tenantB}`,
    });

    // Tenant A tries to delete tenant B's document
    const res = await request(app)
      .delete(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);

    expect(res.body).toHaveProperty('code', 'FORBIDDEN');

    // Verify document still exists
    const found = await DocumentModel.findById(doc._id);
    expect(found).not.toBeNull();
  });
});
