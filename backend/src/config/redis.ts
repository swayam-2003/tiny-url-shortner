import { Redis } from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err: Error) => console.error('Redis error:', err.message));

export const CACHE_PREFIX = 'url:';
export const COUNTER_KEY = 'url:counter';

export async function checkRedisHealth(): Promise<boolean> {
  try {
    if (redis.status !== 'ready') await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
