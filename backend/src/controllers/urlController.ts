import type { Request, Response } from 'express';
import { urlService } from '../services/urlService.js';
import { shortenSchema, shortCodeParamSchema } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export const shortenUrl = asyncHandler(async (req: Request, res: Response) => {
  const body = shortenSchema.parse(req.body);
  const result = await urlService.shorten(body);
  res.status(201).json({ success: true, data: result });
});

export const getUrlMetadata = asyncHandler(async (req: Request, res: Response) => {
  const { shortCode } = shortCodeParamSchema.parse(req.params);
  const result = await urlService.getMetadata(shortCode);
  res.json({ success: true, data: result });
});

export const getAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const { shortCode } = shortCodeParamSchema.parse(req.params);
  const result = await urlService.getAnalytics(shortCode);
  res.json({ success: true, data: result });
});

export const deactivateUrl = asyncHandler(async (req: Request, res: Response) => {
  const { shortCode } = shortCodeParamSchema.parse(req.params);
  const result = await urlService.deactivate(shortCode);
  res.json({ success: true, data: result });
});
