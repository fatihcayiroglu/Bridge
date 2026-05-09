/**
 * Bridge Server — Global Type Declarations
 * tsc --noEmit hataları için tip genişletmeleri. Runtime davranışı değişmez.
 */
declare namespace Express {
  interface Request {
    user?:   any;
    authed?: any;
  }
}
interface Error {
  data?: Record<string, any>;
}
