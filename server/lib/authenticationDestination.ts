import type { Request, Response } from 'express';
import type { Users } from '../db/repositories';

export type VerifiedLoginUser = NonNullable<Awaited<ReturnType<typeof Users.findById>>>;

/** Selected by a server route, never by a body flag or a browser access token. */
export interface AuthenticationDestination {
  factorPending(req: Request, res: Response, user: VerifiedLoginUser, challenge: string): Promise<unknown>;
  authenticated(req: Request, res: Response, user: VerifiedLoginUser): Promise<unknown>;
}
