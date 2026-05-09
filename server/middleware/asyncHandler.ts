// server/middleware/asyncHandler.ts — Wraps an async route handler and
// forwards any thrown error to Express's next() so a central error
// handler can deal with it. Eliminates the repetitive try/catch boilerplate
// in every route file.
//
// Usage:
//   router.get('/path', asyncHandler(async (req, res) => {
//     const data = await someDbCall();
//     res.json(data);
//   }));

import { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;
