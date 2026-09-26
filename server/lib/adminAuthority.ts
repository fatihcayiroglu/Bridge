import type { NextFunction, Request, Response } from 'express';
import { Users } from '../db/repositories';
import { safeCastAuthed } from './authSafe';

/**
 * Canonical platform-admin authority.
 *
 * Admin status is mutable authorization state. JWT claims are deliberately not
 * authoritative here: a previously-issued token may still contain stale
 * `isAdmin` / `role` / `flags` values after the account has been demoted.
 */
export async function isDatabaseAdmin(userId: unknown): Promise<boolean> {
  if (typeof userId !== 'string' || !userId.trim()) return false;
  const user = await Users.findById(userId.trim());
  return user?.isAdmin === true;
}

/** Express guard for endpoints that require a current site-admin grant. */
export async function databaseAdminOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
  let id: string | undefined;
  try {
    id = safeCastAuthed(req).user.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || !id.trim()) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    if (!(await isDatabaseAdmin(id))) {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    next();
  } catch {
    // Authorization state that cannot be read must never become an allow.
    res.status(403).json({ error: 'Admin only' });
  }
}
