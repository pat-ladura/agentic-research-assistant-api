import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

export interface ApiError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

export function errorHandler(err: ApiError, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error({ error: err, status, message }, 'Request error');

  res.status(status).json({
    error: {
      status,
      message,
      ...(err.body && { body: err.body }),
    },
  });
}
