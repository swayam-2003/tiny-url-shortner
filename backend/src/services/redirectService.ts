import type { Request } from 'express';
import { urlRepository } from '../repositories/urlRepository.js';
import { cacheRepository } from '../repositories/cacheRepository.js';
import { enqueueClick } from '../workers/analyticsWorker.js';
import { validateShortCode } from '../utils/urlValidator.js';
import { hashIp } from '../utils/hashIp.js';
import { AppError } from '../types/index.js';
import { logger } from '../config/logger.js';

export const redirectService = {
  async resolve(shortCode: string): Promise<string> {
    const code = validateShortCode(shortCode);

    const cached = await cacheRepository.get(code);
    if (cached) return cached;

    logger.debug({ shortCode: code }, 'Cache miss');

    const record = await urlRepository.findByShortCode(code);
    if (!record) throw new AppError(404, 'NOT_FOUND', 'Short link not found');
    if (!record.is_active) throw new AppError(410, 'LINK_INACTIVE', 'This short link has been deactivated');
    if (record.expires_at && record.expires_at < new Date()) {
      throw new AppError(410, 'LINK_EXPIRED', 'This short link has expired');
    }

    await cacheRepository.set(code, record.long_url);
    return record.long_url;
  },

  trackClick(shortCode: string, req: Request): void {
    void urlRepository.findByShortCode(shortCode).then((record) => {
      if (!record) return;
      enqueueClick({
        urlId: record.id,
        shortCode,
        ipHash: hashIp(req.ip ?? req.socket.remoteAddress ?? 'unknown'),
        userAgent: req.get('user-agent') ?? null,
        referer: req.get('referer') ?? null,
      });
    });
  },
};
