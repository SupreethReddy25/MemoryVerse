import request from 'supertest';
import { app } from '../index';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import http from 'http';
import { exec } from 'child_process';
import path from 'path';

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
let nodeServer: http.Server;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-32-bytes!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-bytes!!!';
  process.env.PYTHON_SERVICE_URL = 'http://localhost:8000';
  process.env.NODE_ENV = 'test';

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  await new Promise<void>((resolve) => mockPythonServer.listen(8000, resolve));

  nodeServer = app.listen(3001);
});

afterAll(async () => {
  nodeServer.close();
  await mongoose.disconnect();
  await mongoServer.stop();
  mockPythonServer.close();
});

async function getAuthToken() {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `k6-${Date.now()}@example.com`, password: 'securePassword123' });
  return res.body.accessToken;
}

// Ensure jest leaves ample time for load test
jest.setTimeout(60000);

describe('k6 Load Test Execution', () => {
  it('should run k6 load test and report p50, p95, p99 latency', async () => {
    const token = await getAuthToken();
    const k6ExePath = path.resolve(__dirname, '../../../../k6.exe');
    const scriptPath = path.resolve(__dirname, '../../../../load-test/query.js');

    await new Promise<void>((resolve, reject) => {
      const child = exec(`"${k6ExePath}" run "${scriptPath}" -e TEST_TOKEN="${token}"`);
      
      child.stdout?.on('data', (data) => console.log(data));
      child.stderr?.on('data', (data) => console.error(data));
      
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`k6 exited with code ${code}`));
      });
    });
  });
});
