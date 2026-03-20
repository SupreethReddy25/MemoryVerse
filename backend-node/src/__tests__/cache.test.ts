import { computeQueryClusterHash } from '../services/cache.service';

// Mock Redis for unit tests — we test the hash logic directly
// and use a simple in-memory map for get/set tests.

describe('Cache Service', () => {
  // ── Test 1: Same vector → same hash ─────────────────────────────
  it('should produce the same hash for the same vector', () => {
    const vector = Array(384).fill(0.123456);
    const hash1 = computeQueryClusterHash(vector);
    const hash2 = computeQueryClusterHash(vector);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex = 64 chars
  });

  // ── Test 2: Slightly different vector (2nd decimal) → same hash ──
  it('should produce the same hash for vectors differing only at 2nd decimal', () => {
    // After rounding to 1dp:
    // vectorA: [0.11→0.1, 0.23→0.2, 0.34→0.3, 0.43→0.4, 0.52→0.5]
    // vectorB: [0.13→0.1, 0.24→0.2, 0.31→0.3, 0.44→0.4, 0.54→0.5]
    // Both round to [0.1, 0.2, 0.3, 0.4, 0.5]
    const vectorA = [0.11, 0.23, 0.34, 0.43, 0.52];
    const vectorB = [0.13, 0.24, 0.31, 0.44, 0.54];
    const hashA = computeQueryClusterHash(vectorA);
    const hashB = computeQueryClusterHash(vectorB);
    expect(hashA).toBe(hashB);
  });

  // ── Test 3: Very different vector → different hash ───────────────
  it('should produce different hashes for very different vectors', () => {
    const vector1 = Array(384).fill(0.1);
    const vector2 = Array(384).fill(0.9);
    const hash1 = computeQueryClusterHash(vector1);
    const hash2 = computeQueryClusterHash(vector2);
    expect(hash1).not.toBe(hash2);
  });

  // ── Test 4: getCachedResponse returns null on miss ───────────────
  it('getCachedResponse should return null on cache miss', async () => {
    // Import dynamically to mock Redis
    jest.resetModules();

    // Mock ioredis to return null (cache miss)
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        quit: jest.fn().mockResolvedValue(undefined),
      }));
    });

    const { getCachedResponse } = require('../services/cache.service');
    const result = await getCachedResponse('tenant-123', [0.1, 0.2, 0.3]);
    expect(result).toBeNull();
  });

  // ── Test 5: setCachedResponse then getCachedResponse returns value ─
  it('should return cached value after setCachedResponse', async () => {
    jest.resetModules();

    const store: Record<string, string> = {};
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockImplementation((key: string) =>
          Promise.resolve(store[key] || null)
        ),
        set: jest.fn().mockImplementation((key: string, value: string) => {
          store[key] = value;
          return Promise.resolve('OK');
        }),
        quit: jest.fn().mockResolvedValue(undefined),
      }));
    });

    const { getCachedResponse, setCachedResponse } = require('../services/cache.service');

    const tenantId = 'tenant-abc';
    const vector = [0.1, 0.2, 0.3];
    const sseContent = 'data: {"token": "Hello"}\n\ndata: {"done": true}\n\n';

    await setCachedResponse(tenantId, vector, sseContent);
    const result = await getCachedResponse(tenantId, vector);
    expect(result).toBe(sseContent);
  });

  // ── Test 6: Cross-tenant isolation — different tenants get different cache keys ─
  it('should NOT return tenant A cache for tenant B with same vector', async () => {
    jest.resetModules();

    const store: Record<string, string> = {};
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockImplementation((key: string) =>
          Promise.resolve(store[key] || null)
        ),
        set: jest.fn().mockImplementation((key: string, value: string) => {
          store[key] = value;
          return Promise.resolve('OK');
        }),
        quit: jest.fn().mockResolvedValue(undefined),
      }));
    });

    const { getCachedResponse, setCachedResponse } = require('../services/cache.service');

    const vector = [0.1, 0.2, 0.3];
    const tenantA = 'tenant-A';
    const tenantB = 'tenant-B';

    // Store for tenant A
    await setCachedResponse(tenantA, vector, 'data: {"token": "A response"}\n\n');

    // Tenant B should NOT get tenant A's response
    const resultB = await getCachedResponse(tenantB, vector);
    expect(resultB).toBeNull();

    // Tenant A should still get their own response
    const resultA = await getCachedResponse(tenantA, vector);
    expect(resultA).toBe('data: {"token": "A response"}\n\n');
  });
});
