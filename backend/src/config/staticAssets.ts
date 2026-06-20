import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../public');
const indexHtml = join(publicDir, 'index.html');

export function shouldServeStatic(): boolean {
  if (process.env.SERVE_STATIC === 'true') return true;
  if (process.env.SERVE_STATIC === 'false') return false;
  return process.env.NODE_ENV === 'production' && existsSync(indexHtml);
}

export function registerStaticAssets(app: Express): void {
  if (!shouldServeStatic()) return;

  app.use(express.static(publicDir, { index: false, maxAge: '1d' }));

  const spaRoutes = ['/', '/links'];
  for (const route of spaRoutes) {
    app.get(route, (_req: Request, res: Response) => {
      res.sendFile(indexHtml);
    });
  }

  app.get('/analytics/:shortCode', (_req: Request, res: Response) => {
    res.sendFile(indexHtml);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/health') {
      return next();
    }
    if (req.path.match(/^\/[a-zA-Z0-9_-]{3,12}$/)) {
      return next();
    }
    res.sendFile(indexHtml);
  });
}
