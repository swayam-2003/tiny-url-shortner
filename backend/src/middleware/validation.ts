import { z } from 'zod';

export const shortenSchema = z.object({
  longUrl: z.string().min(1, 'URL is required'),
  customAlias: z.string().min(3).max(12).optional(),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

export const shortCodeParamSchema = z.object({
  shortCode: z.string().min(3).max(12),
});
