import { CACHE_PREFIX, redis } from '../config/redis.js';
import { logger } from '../config/logger.js';

const TTL = Number(process.env.REDIS_TTL_SECONDS ?? 86400);

async function ensureRedis(): Promise<void> {
  if (redis.status !== 'ready') await redis.connect();
}

export const cacheRepository = {
  async get(shortCode: string): Promise<string | null> {
    try {
      await ensureRedis();
      const value = await redis.get(`${CACHE_PREFIX}${shortCode}`);
      if (value) logger.debug({ shortCode }, 'Cache hit');
      return value;
    } catch (err) {
      logger.warn({ err, shortCode }, 'Redis get failed');
      return null;
    }
  },

  async set(shortCode: string, longUrl: string): Promise<void> {
    try {
      await ensureRedis();
      await redis.setex(`${CACHE_PREFIX}${shortCode}`, TTL, longUrl);
    } catch (err) {
      logger.warn({ err, shortCode }, 'Redis set failed');
    }
  },

  async invalidate(shortCode: string): Promise<void> {
    try {
      await ensureRedis();
      await redis.del(`${CACHE_PREFIX}${shortCode}`);
    } catch (err) {
      logger.warn({ err, shortCode }, 'Redis invalidate failed');
    }
  },
};
