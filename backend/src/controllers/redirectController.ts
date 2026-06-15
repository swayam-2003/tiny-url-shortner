import type { Request, Response, NextFunction } from 'express';
import { redirectService } from '../services/redirectService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const RESERVED_PATHS = new Set(['api', 'health', 'favicon.ico', 'robots.txt']);

export const redirectHandler = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const code = req.params.shortCode;
  if (!code || Array.isArray(code) || RESERVED_PATHS.has(code.toLowerCase())) {
    return next();
  }

  const { longUrl, cacheStatus, latencyMs } = await redirectService.resolve(code);
  redirectService.trackClick(code, req);

  res.setHeader('X-Cache', cacheStatus);
  res.setHeader('X-Response-Time', `${latencyMs.toFixed(2)}ms`);
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(301, longUrl);
});
