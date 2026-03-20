import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import http from 'http';
import { app } from '../index';
import { User } from '../models/user.model';

let mongoServer: MongoMemoryServer;
let mockPythonServer: http.Server;

// Set up a mock Python service that responds to /embed and /rag
function createMockPythonServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url === '/embed') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ vector: Array(384).fill(0.1) }));
        } else if (req.url === '/rag') {
          const parsed = JSON.parse(body);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          // Store the tenant_id for verification
          res.write(`data: {"token": "Answer from tenant ${parsed.tenant_id}"}\n\n`);
          res.write('data: {"done": true}\n\n');
          res.end();
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

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-32-bytes!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-bytes!!!';
  process.env.NODE_ENV = 'test';

  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);

  // Start mock Python service
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
});

// ─── Helper to register and get token ──────────────────────────────
async function getAuthToken(): Promise<{ accessToken: string; tenantId: string }> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: 'test@example.com', password: 'securePassword123' });
  return { accessToken: res.body.accessToken, tenantId: res.body.tenantId };
}

describe('Query Router - POST /query/suggest', () => {
  // ── Test 1: Without auth → 401 ──────────────────────────────────
  it('should return 401 without authentication', async () => {
    const res = await request(app)
      .post('/query/suggest')
      .send({ text: 'when is the exam?' })
      .expect(401);

    expect(res.body).toHaveProperty('code', 'UNAUTHORIZED');
  });

  // ── Test 2: Empty text → 400 ────────────────────────────────────
  it('should return 400 for empty text', async () => {
    const { accessToken } = await getAuthToken();

    const res = await request(app)
      .post('/query/suggest')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: '' })
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  // ── Test 3: Text > 500 chars → 400 ─────────────────────────────
  it('should return 400 for text exceeding 500 characters', async () => {
    const { accessToken } = await getAuthToken();

    const res = await request(app)
      .post('/query/suggest')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: 'a'.repeat(501) })
      .expect(400);

    expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
  });

  // ── Test 4: Valid auth + text → 200, SSE content-type ───────────
  it('should return 200 with text/event-stream Content-Type', async () => {
    const { accessToken } = await getAuthToken();

    const res = await request(app)
      .post('/query/suggest')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ text: 'when is the OS exam?' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
  });

  // ── Test 5: tenant_id sent to Python must equal JWT tenantId ────
  it('should send JWT tenantId to Python service, not body value', async () => {
    const { accessToken, tenantId: jwtTenantId } = await getAuthToken();

    const res = await request(app)
      .post('/query/suggest')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        text: 'test query',
        tenant_id: 'fake-tenant-should-be-ignored',
      });

    expect(res.status).toBe(200);

    // The mock Python server embeds the tenant_id in the response
    // Verify the response contains the JWT tenantId, not the fake one
    const responseText = res.text;
    expect(responseText).toContain(jwtTenantId);
    expect(responseText).not.toContain('fake-tenant-should-be-ignored');
  });
});
