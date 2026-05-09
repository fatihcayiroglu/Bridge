// server/middleware/csrf.ts — Bridge CSRF Protection Middleware
// Applies to all state-mutating requests (POST, PATCH, PUT, DELETE)
// from browser clients. API clients using bearer tokens are exempt.
//
// Usage in route files:
//   import { csrfMiddleware } from '../middleware/csrf';
//   router.post('/endpoint', authMiddleware, csrfMiddleware, handler);
//
// Client must:
//   1. GET /api/auth/csrf-token  → { token }
//   2. Send header X-CSRF-Token: <token> on state-changing requests

import { Request, Response, NextFunction } from 'express';
import { verifyCsrfToken } from '../lib/security';
import { verifyToken } from './auth';

// Safe methods never need CSRF protection
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = new Set([
  '/login',
  '/register',
  '/refresh',
  '/captcha-config',
  '/health',
  '/health/live',
  '/health/ready',
  '/e2e',
]);

/**
 * Middleware: verify X-CSRF-Token header for mutating requests.
 * Skips verification if the request carries a bot API key (X-Bot-Token).
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Safe methods pass through
  if (SAFE_METHODS.has(req.method)) { next(); return; }

  // Bot/API key requests are exempt (non-browser clients)
  if (req.headers['x-bot-token'] || req.headers['x-api-key']) { next(); return; }

  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!token) {
    res.status(403).json({ error: 'CSRF token missing' });
    return;
  }

  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!verifyCsrfToken(userId, token)) {
    res.status(403).json({ error: 'CSRF token invalid or expired' });
    return;
  }

  next();
}

/**
 * Global /api middleware:
 * - Enforces CSRF for mutating browser requests that carry Bearer token.
 * - Keeps auth-free endpoints (login/register/refresh etc.) exempt.
 */
export function enforceApiCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) { next(); return; }
  if (req.headers['x-bot-token'] || req.headers['x-api-key']) { next(); return; }
  if (EXEMPT_PATHS.has(req.path)) { next(); return; }

  const auth = (req.headers.authorization as string) || '';
  if (!auth.startsWith('Bearer ')) { next(); return; }
  const decoded = verifyToken(auth.slice(7));
  if (!(decoded as unknown as Record<string, unknown> | null)?.id) { next(); return; }

  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!token) { res.status(403).json({ error: 'CSRF token missing' }); return; }
  if (!verifyCsrfToken((decoded as { id: string }).id, token)) {
    res.status(403).json({ error: 'CSRF token invalid or expired' });
    return;
  }
  next();
}
