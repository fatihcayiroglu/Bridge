// server/lib/rateLimitDefaults.ts
//
// Default for `RL_GLOBAL_MAX`, the `/api` request budget per minute.
//
// Final21 Phase 11: `app/createApp.ts` enforced 200 while `middleware/rateLimit.ts`
// DEFAULTS, `lib/limitsReport.ts`, `.env.example` and the deployment guide all
// said 300, so the operator limits report showed a looser limit than the one in
// force. The value that was actually enforced (200) is kept; every reader
// imports it from here. Kept dependency-free so the limits report can import it
// without loading the Redis-backed limiter.
export const RL_GLOBAL_MAX_DEFAULT = 200;
