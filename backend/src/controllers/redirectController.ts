import type { Request, Response, NextFunction } from 'express';
import { redirectService } from '../services/redirectService.js';

const RESERVED_PATHS = new Set([
  'api', 'health', 'favicon.ico', 'robots.txt',
]);

export async function redirectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const code = req.params.shortCode;
    if (!code || Array.isArray(code) || RESERVED_PATHS.has(code.toLowerCase())) {
      return next();
    }

    const longUrl = await redirectService.resolve(code);
    redirectService.trackClick(code, req);
    res.redirect(301, longUrl);
  } catch (err) {
    next(err);
  }
}
