import type { Request, Response, NextFunction } from 'express';

const BLOCKED_PATHS = /\/(etc|proc|sys|admin|internal|localhost)/i;
const PRIVATE_IP =
  /^(https?:\/\/)(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|localhost|\[::1\])/i;

export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Reject oversized query strings (DoS)
  if (req.url.length > 2048) {
    res.status(414).json({ error: true, code: 'URI_TOO_LONG', message: 'Request URI too long' });
    return;
  }

  // Block suspicious scanner paths
  if (BLOCKED_PATHS.test(req.path)) {
    res.status(403).json({ error: true, code: 'FORBIDDEN', message: 'Access denied' });
    return;
  }

  next();
}

export function isPrivateOrLocalUrl(url: string): boolean {
  return PRIVATE_IP.test(url) || /^https?:\/\/localhost/i.test(url);
}
