import type { Request, Response } from 'express';
import { checkDatabaseHealth } from '../config/database.js';
import { checkRedisHealth } from '../config/redis.js';

export async function healthController(_req: Request, res: Response): Promise<void> {
  const [dbOk, redisOk] = await Promise.all([checkDatabaseHealth(), checkRedisHealth()]);

  const status = dbOk && redisOk ? 'healthy' : 'degraded';
  const statusCode = dbOk ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: dbOk ? 'up' : 'down',
      redis: redisOk ? 'up' : 'down',
    },
  });
}
