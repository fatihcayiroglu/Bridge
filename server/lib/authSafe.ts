import type { Request } from 'express';
import { castAuthed as authCastAuthed } from '../middleware/auth';

type RequestUserLike = ReturnType<typeof authCastAuthed>['user'] & {
  _id?: string;
  [key: string]: unknown;
};

export function safeCastAuthed(req: Request): ReturnType<typeof authCastAuthed> {
  const maybeCast = authCastAuthed as unknown;
  if (typeof maybeCast === 'function') return (maybeCast as typeof authCastAuthed)(req);
  const user = (req as Request & { user?: Partial<RequestUserLike> }).user ?? {};
  const id = String(user.id ?? user._id ?? '');
  return { user: { ...user, id } as RequestUserLike } as unknown as ReturnType<typeof authCastAuthed>;
}
