import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import http from 'http';
import { app } from './src/index';

const PORT = 3001;

// 1. Mock Redis
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

// 2. Mock Python Service
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

async function start() {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-32-bytes!';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-bytes!!!';
  process.env.PYTHON_SERVICE_URL = 'http://localhost:8000';
  process.env.NODE_ENV = 'test';

  const mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  console.log('Mock MongoDB started');

  mockPythonServer.listen(8000, () => {
    console.log('Mock Python server listening on port 8000');
  });

  app.listen(PORT, () => {
    console.log(`Mock Node API listening on port ${PORT}`);
  });
}

start().catch(console.error);
