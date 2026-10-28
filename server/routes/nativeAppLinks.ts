/**
 * @openapi
 * /.well-known/assetlinks.json:
 *   get: { tags: [Auth], summary: Android App Links association for the native sign-in callback host, security: [], responses: { '200': { description: Digital Asset Links statements }, '404': { description: Not a configured callback host } } }
 * /.well-known/apple-app-site-association:
 *   get: { tags: [Auth], summary: iOS Universal Links association for the native sign-in callback host, security: [], responses: { '200': { description: apple-app-site-association }, '404': { description: Not a configured callback host } } }
 * /apple-app-site-association:
 *   get: { tags: [Auth], summary: iOS Universal Links association (legacy root location), security: [], responses: { '200': { description: apple-app-site-association }, '404': { description: Not a configured callback host } } }
 */
// server/routes/nativeAppLinks.ts
//
// Serves the App Links / Universal Links association files and an inert landing
// page for the native sign-in callback, ONLY on a configured https callback
// host (see lib/nativeAppLinks.ts). Requests for any other host fall through
// unchanged, so the Bridge web origin's behaviour does not change.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { appleAssociationDocument, assetLinksDocument, loadNativeAppLinksConfig } from '../lib/nativeAppLinks';

// Shown if the OS did not hand the callback to the app (app missing, or link
// verification failed). It never echoes the URL: the query carries the code.
const LANDING_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
  + '<title>Bridge sign-in</title></head><body><p>Return to the Bridge app to finish signing in.</p>'
  + '<p>If the app did not open, install or update it, then start the sign-in again from the app.</p></body></html>';

function hostOf(req: Request): string {
  return (req.get('host') ?? '').toLowerCase();
}

export function createNativeAppLinksRouter(env: NodeJS.ProcessEnv = process.env): express.Router {
  const router = express.Router();
  const cfg = loadNativeAppLinksConfig(env);
  if (!cfg.enabled) return router;

  const onCallbackHost = (req: Request): boolean => cfg.callbacks.has(hostOf(req));
  const json = (res: Response, body: unknown) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/json').send(JSON.stringify(body));
  };

  router.get('/.well-known/assetlinks.json', (req: Request, res: Response, next: NextFunction) => {
    const doc = onCallbackHost(req) ? assetLinksDocument(cfg) : null;
    return doc ? json(res, doc) : next();
  });
  router.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'],
    (req: Request, res: Response, next: NextFunction) => {
      const doc = onCallbackHost(req) ? appleAssociationDocument(cfg, hostOf(req)) : null;
      return doc ? json(res, doc) : next();
    });
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const paths = cfg.callbacks.get(hostOf(req));
    if (!paths || !paths.includes(req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(LANDING_HTML);
  });
  return router;
}
