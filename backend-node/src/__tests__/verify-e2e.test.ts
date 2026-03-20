import request from 'supertest';
import { app } from '../index';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import http from 'http';
import { AuditLog } from '../models/audit-log.model';

// Mock Redis
jest.mock('ioredis', () => {
  const store: Record<string, string> = {};
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockImplementation((key: string) => Promise.resolve(store[key] || null)),
    set: jest.fn().mockImplementation((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve('OK');
    }),
    quit: jest.fn().mockResolvedValue(undefined),
  }));
});

// Mock Python Service
const mockPythonServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/embed') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ vector: Array(384).fill(0.1) }));
    } else if (req.url === '/rag') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write('data: {"token": "Simulated answer"}\n\n');
      res.write('data: {"done": true}\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-32-bytes!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-bytes!!!';
  process.env.PYTHON_SERVICE_URL = 'http://localhost:8000';
  process.env.NODE_ENV = 'test';

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  await new Promise<void>((resolve) => mockPythonServer.listen(8000, resolve));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  mockPythonServer.close();
});

async function getAuthToken() {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `test-${Date.now()}@example.com`, password: 'securePassword123' });
  return res.body.accessToken;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Manual E2E Verifications', () => {
  it('Cache hit verified: same query sent twice, second returns instantly, audit_logs shows a cache_hit event', async () => {
    const token = await getAuthToken();
    const queryPayload = { text: 'what is the exact required manual e2e caching test?' };

    // Request 1: Cache Miss
    const t0 = performance.now();
    await request(app)
      .post('/query/suggest')
      .set('Authorization', `Bearer ${token}`)
      .send(queryPayload)
      .expect(200);
    const time1 = performance.now() - t0;

    await sleep(200);

    // Request 2: Cache Hit
    const t1 = performance.now();
    await request(app)
      .post('/query/suggest')
      .set('Authorization', `Bearer ${token}`)
      .send(queryPayload)
      .expect(200);
    const time2 = performance.now() - t1;

    console.log(`\n=> First query took ${time1.toFixed(2)}ms`);
    console.log(`=> Second query took ${time2.toFixed(2)}ms`);
    
    expect(time2).toBeLessThan(time1);

    await sleep(200);
    // Check audit logs
    const cacheHitLogs = await AuditLog.find({ eventType: 'cache_hit' });
    console.log(`=> Found ${cacheHitLogs.length} cache_hit event(s) in audit logs!`);
    expect(cacheHitLogs.length).toBeGreaterThan(0);
  });

  it('Rate limiter verified: 31 requests in 1 minute -> 31st gets 429', async () => {
    const token = await getAuthToken();
    const queryPayload = { text: 'rate limit test' };

    let code429Count = 0;
    
    // Fire 31 requests
    for (let i = 1; i <= 31; i++) {
      const res = await request(app)
        .post('/query/suggest')
        .set('Authorization', `Bearer ${token}`)
        .send(queryPayload);
        
      if (res.status === 429) {
        code429Count++;
        console.log(`=> Request ${i} got 429 Rate Limit Exceeded`);
      }
    }

    expect(code429Count).toBe(1);
  });
});
