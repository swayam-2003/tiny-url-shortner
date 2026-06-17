import type { Request, Response, NextFunction } from 'express';

export function serverIdMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Server-Id', process.env.SERVER_ID ?? 'api-local');
  next();
}
