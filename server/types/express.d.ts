/**
 * Bridge — Express.js Global Type Augmentation
 * server/types/express.d.ts
 *
 * Express.Request'e Bridge-spesifik alanlar eklenir.
 * Bu dosya sayesinde tüm route handler'larında req.user,
 * req.userId gibi alanlara tip güvencesiyle erişilebilir.
 *
 * Strateji:
 *   - Express.User → authMiddleware sonrası JWT payload'ı
 *   - AuthedRequest → korumalı route'larda user garantisi
 *   - OptionalAuthRequest → opsiyonel auth (public + auth birlikte)
 */

import type { JwtPayload } from '../middleware/auth';

// ── Global Express namespace augmentation ──────────────────────
declare global {
  namespace Express {
    /**
     * Express.User arayüzü — req.user tipini global olarak tanımlar.
     * authMiddleware çalıştıktan sonra bu alan dolu olur.
     */
    interface User extends JwtPayload {}
  }
}

// ── Bridge-spesifik Request tipleri ───────────────────────────
import { Request } from 'express';

/**
 * AuthedRequest — authMiddleware korumalı route'lar için.
 * user alanının kesinlikle dolu olduğunu garanti eder.
 *
 * Kullanım:
 *   router.get('/me', authMiddleware, async (req: AuthedRequest, res) => {
 *     const userId = req.user.id; // null check gereksiz
 *   });
 */
export interface AuthedRequest extends Request {
  user: JwtPayload; // non-optional: authMiddleware garantisi
  userId?: string;
}

/**
 * OptionalAuthRequest — bazı endpoint'ler hem anonim hem auth
 * kullanıcıya hizmet verir (örn. public server profilleri).
 */
export interface OptionalAuthRequest extends Request {
  user?: JwtPayload;
}

/**
 * assertAuthed — runtime'da req.user'ın dolu olduğunu doğrular.
 * authMiddleware kullanılmayan ama user bekleyen durumlarda.
 *
 * @throws {Error} user yoksa 500 fırlatır (programcı hatası)
 */
export function assertAuthed(req: Request): asserts req is AuthedRequest {
  if (!req.user) {
    throw new Error('[Bridge] assertAuthed: req.user is undefined — authMiddleware eksik?');
  }
}
