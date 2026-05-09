// server/db/repositories/AuthRepository.js
// Kimlik doğrulama nesneleri (refresh token, WebAuthn, audit log) sorgularını toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class AuthRepository {
  // ── Refresh Tokens ─────────────────────────────────────────

  async findRefreshToken(token) {
    return db.refreshTokens?.findOne({ token });
  }

  async insertRefreshToken(userId, token, expiresAt) {
    return db.refreshTokens?.insert({ _id: uuidv4(), userId, token, expiresAt, createdAt: Date.now() });
  }

  async revokeRefreshToken(token) {
    return db.refreshTokens?.remove({ token });
  }

  async revokeAllForUser(userId) {
    return db.refreshTokens?.remove({ userId });
  }

  /**
   * Token ailesi saldırısı tespitinde tüm aile token'larını iptal eder.
   * Bir token iki kez kullanıldığında (reuse), aynı family değerine sahip
   * tüm token'lar silinir — meşru oturum da kapatılmış olur.
   * Bu, token çalınması durumunda saldırganı sistemden atar.
   */
  async revokeByFamily(family) {
    if (!family) return;
    return db.refreshTokens?.remove({ family });
  }

  async findByFamily(family) {
    if (!family) return [];
    try {
      const result = await db.refreshTokens?.find({ family });
      return Array.isArray(result) ? result : [];
    } catch { return []; }
  }

  async updateRefreshTokenWhere(filter, modifier) {
    return db.refreshTokens?.update(filter, modifier);
  }

  async removeRefreshTokensWhere(filter) {
    try {
      return await db.refreshTokens?.remove(filter);
    } catch {
      return null;
    }
  }

  /** Tam satır ekleme (rotation / family alanları dahil). */
  async insertRefreshTokenRow(row) {
    return db.refreshTokens?.insert({
      _id: uuidv4(),
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

  async findCredential(credentialId) {
    return db.webauthnCredentials?.findOne({ credentialId });
  }

  async findCredentialsByUser(userId) {
    return db.webauthnCredentials?.find({ userId }) ?? [];
  }

  async insertCredential(data) {
    return db.webauthnCredentials?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async updateCredential(credentialId, fields) {
    return db.webauthnCredentials?.update({ credentialId }, { $set: fields });
  }

  async updateCredentialByDocId(id, fields) {
    return db.webauthnCredentials?.update({ _id: id }, { $set: fields });
  }

  async deleteCredential(id, userId) {
    return db.webauthnCredentials?.remove({ _id: id, userId });
  }

  // ── Admin / Audit Logs ─────────────────────────────────────

  async insertAdminLog(data) {
    return db.adminLogs?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findAdminLogs(query = {}, limit = 100) {
    return db.adminLogs?.find(query).sort({ createdAt: -1 }).limit(limit) ?? [];
  }

  async insertAuditLog(data) {
    return db.auditLogs?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findAuditLogs(serverId, limit = 50) {
    return db.auditLogs?.find({ serverId }).sort({ createdAt: -1 }).limit(limit) ?? [];
  }

  async findAuditLogsWhere(query) {
    return db.auditLogs?.find(query).sort({ createdAt: -1 }) ?? [];
  }

  auditLogsFind(query) {
    return db.auditLogs?.find(query);
  }
}

module.exports = new AuthRepository();
export {};
