import type { Request, Response } from 'express';
import { checkDatabaseHealth } from '../config/database.js';
import { checkRedisHealth, redis } from '../config/redis.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const healthController = asyncHandler(async (_req: Request, res: Response) => {
  const [dbOk, redisOk] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);

  const status = dbOk ? (redisOk ? 'healthy' : 'degraded') : 'unhealthy';
  const statusCode = dbOk ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'up' : 'down',
      redis: redisOk ? 'up' : 'down',
    },
    cache: {
      strategy: 'cache-aside',
      policy: 'allkeys-lru',
      ttlSeconds: Number(process.env.REDIS_TTL_SECONDS ?? 86400),
    },
  });
});

export const redisStatsController = asyncHandler(async (_req: Request, res: Response) => {
  try {
    if (redis.status !== 'ready') await redis.connect();
    const info = await redis.info('memory');
    const maxmemory = info.match(/maxmemory_human:(.+)/)?.[1]?.trim() ?? 'unknown';
    const used = info.match(/used_memory_human:(.+)/)?.[1]?.trim() ?? 'unknown';
    const policy = info.match(/maxmemory_policy:(.+)/)?.[1]?.trim() ?? 'unknown';

    res.json({
      strategy: 'cache-aside',
      evictionPolicy: policy,
      maxMemory: maxmemory,
      usedMemory: used,
      keyPattern: 'url:{shortCode}',
      ttlSeconds: Number(process.env.REDIS_TTL_SECONDS ?? 86400),
    });
  } catch {
    res.status(503).json({
      error: true,
      code: 'REDIS_UNAVAILABLE',
      message: 'Redis is not available',
    });
  }
});
