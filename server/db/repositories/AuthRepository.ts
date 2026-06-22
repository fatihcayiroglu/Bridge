// server/db/repositories/AuthRepository.ts
// Kimlik doğrulama nesneleri (refresh token, WebAuthn, audit log) sorgularını toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class AuthRepository {
  // ── Refresh Tokens ─────────────────────────────────────────

  async findRefreshToken(token: string) {
    return db.refreshTokens?.findOne({ token });
  }

  async insertRefreshToken(userId: string, token: string, expiresAt: number) {
    return db.refreshTokens?.insert({ userId, token, expiresAt, createdAt: Date.now() });
  }

  async revokeRefreshToken(token: string) {
    return db.refreshTokens?.remove({ token });
  }

  async revokeAllForUser(userId: string) {
    return db.refreshTokens?.remove({ userId });
  }

  /**
   * Token ailesi saldırısı tespitinde tüm aile token'larını iptal eder.
   * Bir token iki kez kullanıldığında (reuse), aynı family değerine sahip
   * tüm token'lar silinir — meşru oturum da kapatılmış olur.
   * Bu, token çalınması durumunda saldırganı sistemden atar.
   */
  async revokeByFamily(family: string) {
    if (!family) return;
    return db.refreshTokens?.remove({ family });
  }

  async findByFamily(family: string) {
    if (!family) return [];
    try {
      const result = await db.refreshTokens?.find({ family });
      return Array.isArray(result) ? result : [];
    } catch { return []; }
  }

  async updateRefreshTokenWhere(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.refreshTokens?.update(filter, modifier);
  }

  async removeRefreshTokensWhere(filter: Record<string, unknown>) {
    try {
      return await db.refreshTokens?.remove(filter);
    } catch {
      return null;
    }
  }

  /** Tam satır ekleme (rotation / family alanları dahil). */
  async insertRefreshTokenRow(row: Record<string, unknown>) {
    return db.refreshTokens?.insert({
      createdAt: Date.now(),
      used: false,
      ...row,
    });
  }

  // ── WebAuthn Credentials ───────────────────────────────────

  /** Tablo yoksa credential'lar users dokümanında gömülü tutulur. */
  hasWebauthnCollection() {
    return !!db.webauthnCredentials;
  }

  async findCredential(credentialId: string) {
    return db.webauthnCredentials?.findOne({ credentialId });
  }

  async findCredentialByDocId(id: string, userId?: string) {
    const query: Record<string, unknown> = { _id: id };
    if (userId) query.userId = userId;
    return db.webauthnCredentials?.findOne(query);
  }

  async findCredentialsByUser(userId: string) {
    return db.webauthnCredentials?.find({ userId }) ?? [];
  }

  async insertCredential(data: Record<string, unknown>) {
    return db.webauthnCredentials?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateCredential(credentialId: string, fields: Record<string, unknown>) {
    return db.webauthnCredentials?.update({ credentialId }, { $set: fields });
  }

  async updateCredentialByDocId(id: string, fields: Record<string, unknown>) {
    return db.webauthnCredentials?.update({ _id: id }, { $set: fields });
  }

  async deleteCredential(id: string, userId: string) {
    return db.webauthnCredentials?.remove({ _id: id, userId });
  }

  // ── Admin / Audit Logs ─────────────────────────────────────

  async insertAdminLog(data: Record<string, unknown>) {
    return db.adminLogs?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findAdminLogs(query: Record<string, unknown> = {}, limit = 100) {
    return db.adminLogs?.find(query).sort({ createdAt: -1 }).limit(limit) ?? [];
  }

  async insertAuditLog(data: Record<string, unknown>) {
    return db.auditLogs?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findAuditLogs(serverId: string, limit = 50) {
    return db.auditLogs?.find({ serverId }).sort({ createdAt: -1 }).limit(limit) ?? [];
  }

  async getAuditLog(serverId: string, opts: number | { limit?: number; offset?: number; action?: string } = 50) {
    const limit = typeof opts === 'number' ? opts : (opts.limit ?? 50);
    const offset = typeof opts === 'number' ? 0 : (opts.offset ?? 0);
    const action = typeof opts === 'number' ? undefined : opts.action;
    const query: Record<string, unknown> = { serverId };
    if (action) query.action = action;
    const entries = await db.auditLogs?.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit) ?? [];
    const total = await db.auditLogs?.count(query) ?? entries.length;
    return { entries, total };
  }

  async findAuditLogsWhere(query: Record<string, unknown>) {
    return db.auditLogs?.find(query).sort({ createdAt: -1 }) ?? [];
  }

  auditLogsFind(query: Record<string, unknown>) {
    return db.auditLogs?.find(query);
  }
}

const authRepository = new AuthRepository();
export default authRepository;

// CommonJS compatibility for legacy test suites/importers.
module.exports = authRepository;
module.exports.default = authRepository;

