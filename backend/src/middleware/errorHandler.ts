import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../types/index.js';
import { logger } from '../config/logger.js';

function buildErrorBody(code: string, message: string, requestId?: string) {
  return {
    error: true,
    code,
    message,
    ...(requestId && { requestId }),
  };
}

function mapDatabaseError(err: Error & { code?: string }): AppError | null {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is temporarily unavailable');
  }
  if (err.code === '57P01' || err.code === '08006' || err.code === '08001') {
    return new AppError(503, 'DATABASE_UNAVAILABLE', 'Database connection lost');
  }
  if (err.code === '23505') {
    return new AppError(409, 'DUPLICATE_ENTRY', 'Resource already exists');
  }
  return null;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    res.status(err.statusCode).json(buildErrorBody(err.code, err.message, requestId));
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json(
      buildErrorBody('VALIDATION_ERROR', err.errors.map((e) => e.message).join(', '), requestId)
    );
    return;
  }

  const dbErr = mapDatabaseError(err as Error & { code?: string });
  if (dbErr) {
    logger.error({ err, requestId }, 'Database error');
    res.status(dbErr.statusCode).json(buildErrorBody(dbErr.code, dbErr.message, requestId));
    return;
  }

  logger.error({ err, requestId }, 'Unhandled error');
  res.status(500).json(
    buildErrorBody('INTERNAL_ERROR', 'An unexpected error occurred', requestId)
  );
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    buildErrorBody('NOT_FOUND', 'Endpoint not found', req.requestId)
  );
}
