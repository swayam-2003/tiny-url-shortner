import { CACHE_PREFIX, redis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import type { CacheStatus } from '../types/redirect.js';

const TTL = Number(process.env.REDIS_TTL_SECONDS ?? 86400);

async function withRedis<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    if (redis.status !== 'ready') await redis.connect();
    return { ok: true, data: await fn() };
  } catch (err) {
    logger.warn({ err }, 'Redis operation failed — bypassing cache');
    return { ok: false };
  }
}

export const cacheRepository = {
  async get(shortCode: string): Promise<{ value: string | null; status: CacheStatus }> {
    const result = await withRedis(() => redis.get(`${CACHE_PREFIX}${shortCode}`));
    if (!result.ok) return { value: null, status: 'BYPASS' };

    const status: CacheStatus = result.data ? 'HIT' : 'MISS';
    if (result.data) logger.debug({ shortCode }, 'Cache hit');
    return { value: result.data, status };
  },

  async set(shortCode: string, longUrl: string): Promise<void> {
    await withRedis(() => redis.setex(`${CACHE_PREFIX}${shortCode}`, TTL, longUrl));
  },

  async invalidate(shortCode: string): Promise<void> {
    await withRedis(() => redis.del(`${CACHE_PREFIX}${shortCode}`));
  },
};
