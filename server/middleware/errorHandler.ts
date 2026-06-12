// server/middleware/errorHandler.ts
// Global Express error handler — 500 yanıtlarında iç detay sızıntısını önler.

import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

export interface HttpError extends Error {
  status?: number;
  expose?: boolean;
}

export function errorHandler(
  err: HttpError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const isServerError = status >= 500;

  if (isServerError) {
    logger.error(
      {
        event: 'http.error',
        status,
        method: req.method,
        path: req.originalUrl,
        err: err.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
      },
      'Unhandled route error',
    );
  }

  const message = !isServerError && err.expose !== false
    ? err.message
    : isServerError
      ? 'Internal server error'
      : err.message || 'Request failed';

  res.status(status).json({ error: message });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}
