import type { Request, Response, NextFunction } from 'express';
import { urlService } from '../services/urlService.js';
import { shortenSchema, shortCodeParamSchema } from '../middleware/validation.js';

export async function shortenUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = shortenSchema.parse(req.body);
    const result = await urlService.shorten(body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getUrlMetadata(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { shortCode } = shortCodeParamSchema.parse(req.params);
    const result = await urlService.getMetadata(shortCode);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { shortCode } = shortCodeParamSchema.parse(req.params);
    const result = await urlService.getAnalytics(shortCode);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function deactivateUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { shortCode } = shortCodeParamSchema.parse(req.params);
    const result = await urlService.deactivate(shortCode);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
