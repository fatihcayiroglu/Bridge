import type { NextFunction, Request, RequestHandler, Response } from 'express';

export default function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  fn: (req: Req, res: Res, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as Req, res as Res, next)).catch(next);
  };
}

module.exports = asyncHandler;
module.exports.default = asyncHandler;
