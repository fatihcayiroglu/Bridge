// server/middleware/federationAuth.ts
// ADR-0006 Faz 3 — HMAC fallback kaldırıldı, RSA-only middleware
//
// Faz 2 (Sprint 108): verifyFederationRequest (RSA öncelikli + HMAC fallback)
// Faz 3 (Sprint 113): verifyFederationRequestV3 (RSA-only, HMAC yok)
//
// Önemli: İmza doğrulaması ham (raw) body üzerinden yapılır.
// createApp.ts'de express.json() ÖNCE rawBody capture middleware eklendi (Sprint 113):
//
//   app.use((req, _res, next) => {
//     let raw = '';
//     req.on('data', chunk => (raw += chunk.toString()));
//     req.on('end', () => { (req as any).rawBody = raw; next(); });
//   });
//
// Bu middleware sayesinde JSON/text isteklerinde req.rawBody her zaman dolu gelir;
// multipart/form-data isteklerinde req.rawBody boş olur ancak federasyon
// endpoint'leri zaten JSON kullandığından bu durum sorun teşkil etmez.
// Sprint 113

import type { Request, Response, NextFunction } from 'express';
import { verifyFederationRequestV3 } from '../lib/httpSignatureV3';
import logger from '../lib/logger';

declare global {
  namespace Express {
    interface Request {
      federationPeerId?:  string | number;
      federationMethod?:  'rsa';
      federationPeerUrl?: string;
      rawBody?:           string;
    }
  }
}

/**
 * Ham body'yi güvenli biçimde alır.
 * Öncelik: req.rawBody → req.body string → JSON.stringify(req.body)
 * createApp.ts'deki rawBody middleware sayesinde her istekte req.rawBody dolu olmalıdır.
 * Tüm durumlarda string döner.
 */
function _extractRawBody(req: Request): string {
  // En iyi: rawBody middleware tarafından set edilmiş ham string
  if (typeof req.rawBody === 'string') return req.rawBody;
  // body zaten string (text/plain veya pre-parse edilmiş)
  if (typeof req.body === 'string') return req.body;
  // Son çare: parse edilmiş body'yi tekrar serialize et
  // Not: bu durum imza uyuşmazlığına yol açabilir; rawBody middleware önerilir
  if (req.body !== undefined && req.body !== null) {
    return JSON.stringify(req.body);
  }
  return '';
}

/**
 * Federation isteğini RSA-only olarak doğrular (ADR-0006 Faz 3).
 * HMAC header'ı (x-bridge-sig) varsa yok sayılır.
 */
export async function federationAuth(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  const peerUrl: string =
    (req.headers['x-bridge-instance-url'] as string) ||
    (typeof req.body === 'object' && req.body !== null
      ? ((req.body as Record<string, unknown>).instanceUrl as string) ||
        ((req.body as Record<string, unknown>).url as string) || ''
      : '') ||
    '';

  if (!peerUrl) {
    res.status(400).json({ error: 'x-bridge-instance-url header or body.url required' });
    return;
  }

  const payload = _extractRawBody(req);

  const result = await verifyFederationRequestV3(peerUrl, payload, {
    'x-bridge-rsa-sig': req.headers['x-bridge-rsa-sig'] as string | undefined,
    'x-bridge-ts':      req.headers['x-bridge-ts']      as string | undefined,
    'x-bridge-keyid':   req.headers['x-bridge-keyid']   as string | undefined,
    // x-bridge-sig (HMAC) kasıtlı olarak okunmuyor
  });

  if (!result.ok) {
    logger.warn(`[federationAuth] Reddedildi peer=${peerUrl} neden=${result.reason}`);
    res.status(401).json({
      error:  'Federation authentication failed',
      reason: result.reason,
    });
    return;
  }

  req.federationPeerId  = result.peerId;
  req.federationMethod  = 'rsa';
  req.federationPeerUrl = peerUrl;

  logger.info(`[federationAuth] ✅ peer=${peerUrl} yöntem=rsa id=${result.peerId}`);
  next();
}

/**
 * Geriye dönük uyumluluk için korundu — aynı davranış.
 */
export async function federationAuthRsaRequired(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  return federationAuth(req, res, next);
}

