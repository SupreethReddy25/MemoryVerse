import crypto from 'crypto';
import Redis from 'ioredis';

// Singleton Redis client
let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    redisClient.connect().catch((err) => {
      console.error('Redis connection failed:', err);
    });
  }
  return redisClient;
}

/**
 * Round each vector dimension to 1 decimal place, stringify, SHA256 hash.
 * This buckets semantically similar queries into the same cache key.
 */
export function computeQueryClusterHash(queryVector: number[]): string {
  const rounded = queryVector.map((v) => Math.round(v * 10) / 10);
  const serialized = JSON.stringify(rounded);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Check Redis for a cached SSE response.
 * Returns the cached SSE string if present, null on miss.
 */
export async function getCachedResponse(
  tenantId: string,
  queryVector: number[]
): Promise<string | null> {
  const hash = computeQueryClusterHash(queryVector);
  const key = `cache:${tenantId}:${hash}`;
  try {
    return await getRedisClient().get(key);
  } catch {
    // Redis errors should not break the request — treat as cache miss
    return null;
  }
}

/**
 * Store an SSE response string in Redis with a 1-hour TTL.
 */
export async function setCachedResponse(
  tenantId: string,
  queryVector: number[],
  sseContent: string
): Promise<void> {
  const hash = computeQueryClusterHash(queryVector);
  const key = `cache:${tenantId}:${hash}`;
  try {
    await getRedisClient().set(key, sseContent, 'EX', 3600);
  } catch {
    // Swallow — cache writes must never break the response
    console.error('Redis cache write failed');
  }
}

/**
 * Disconnect the Redis client (useful for tests / graceful shutdown).
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
