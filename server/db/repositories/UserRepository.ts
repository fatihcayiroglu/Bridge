// server/db/repositories/UserRepository.ts
// SECURITY: apPrivateKey artık users tablosunda değil — user_ap_keys tablosunda.
// Özel anahtara erişmek için yalnızca getApPrivateKey(userId) kullanın.
// Tüm findById / findByUsername vb. metotlar özel anahtarı DÖNDÜRMEZ.
//
// Şifreleme: apPrivateKey DB'de AES-256-GCM ile şifreli saklanır (apPrivateKeyEnc).
// Uygulama katmanı şifreleme: DB sızıntısında bile private key okunamaz.

import db from '../loader';
import type { UserStatus } from './types/entities';
import { encryptApPrivateKey, decryptApPrivateKey } from '../../lib/apKeyEncryption';

class UserRepository {
  async findById(id: string) {
    return db.users.findOne({ _id: id });
  }

  async findByUsername(username: string) {
    return db.users.findOne({ username: username.toLowerCase() });
  }

  /**
   * ActivityPub actor URL → yerel kullanıcı (federation DM routing).
   *
   * Desteklenen formatlar:
   *   /api/federation/users/:username          — kendi instance'ımız
   *   /users/:username                         — yaygın AP sunucu paterni
   *   /u/:username  |  /accounts/:username     — Misskey / Pleroma varyantları
   *
   * Hiçbiri eşleşmezse null döner; uzun vadede webfinger lookup gerekebilir.
   */
  async findByApUrl(apUrl: string) {
    const url = String(apUrl);

    // 1) Kendi instance paterni (önce dene — en spesifik)
    const ownMatch = url.match(/\/api\/federation\/users\/([^/?#]+)/i);
    if (ownMatch?.[1]) return this.findByUsername(ownMatch[1]);

    // 2) Yaygın AP aktor path kalıpları
    const genericMatch = url.match(/\/(?:users|u|accounts)\/([^/?#]+)/i);
    if (genericMatch?.[1]) return this.findByUsername(genericMatch[1]);

    // 3) Eşleşme yok — webfinger lookup için yer tutucu
    return null;
  }

  async findByEmail(email: string) {
    if (!email) return null;
    return db.users.findOne({ email: String(email).toLowerCase() });
  }

  async findByEmailToken(token: string) {
    return db.users.findOne({ emailToken: token });
  }

  async create(data: Record<string, unknown>) {
    return db.users.insert(data);
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.users.update({ _id: id }, { $set: fields });
  }

  async updateWhere(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.users.update(filter, modifier);
  }

  async setStatus(id: string, status: UserStatus) {
    return db.users.update({ _id: id }, { $set: { status } });
  }

  async incrementTokenVersion(id: string) {
    return db.users.update({ _id: id }, { $inc: { tokenVersion: 1 } });
  }

  async findByIds(ids: string[]) {
    return db.users.find({ _id: { $in: ids } });
  }

  async findByUsernames(usernames: string[]) {
    const lower = usernames.map((u: string) => u.toLowerCase());
    return db.users.find({ username: { $in: lower } });
  }

  async count(query: Record<string, unknown> = {}) {
    return db.users.count(query);
  }

  async delete(id: string) {
    return db.users.remove({ _id: id });
  }

  async searchPaginated(query: Record<string, unknown>, { skip = 0, limit = 50 } = {}) {
    return db.users.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit);
  }

  async findWhere(query: Record<string, unknown>) {
    return db.users.find(query);
  }

  // ── ActivityPub özel anahtar — AYRI TABLO + ŞİFRELİ ─────────────────────
  // apPrivateKey users tablosunda bulunmaz; SELECT * sorgularına dahil olmaz.
  // DB'de AES-256-GCM şifreli saklanır (apPrivateKeyEnc).
  // Yalnızca federation imzalama operasyonları bu metodu çağırmalıdır.

  async getApPrivateKey(userId: string): Promise<string | null> {
    const row = await db.userApKeys?.findOne({ userId });
    const encrypted = row?.apPrivateKeyEnc;
    if (typeof encrypted !== 'string') return null;
    return decryptApPrivateKey(encrypted);
  }

  async saveApKeys(userId: string, apPublicKey: string, apPrivateKey: string): Promise<void> {
    const now = Date.now();
    const apPrivateKeyEnc = encryptApPrivateKey(apPrivateKey);
    await db.users.update({ _id: userId }, { $set: { apPublicKey } });
    if (db.userApKeys) {
      const existing = await db.userApKeys.findOne({ userId });
      if (existing) {
        await db.userApKeys.update({ userId }, { $set: { apPrivateKeyEnc, updatedAt: now } });
      } else {
        await db.userApKeys.insert({ userId, apPrivateKeyEnc, keyVersion: 1, createdAt: now, updatedAt: now });
      }
    }
  }

  async deleteApKeys(userId: string): Promise<void> {
    if (db.userApKeys) {
      await db.userApKeys.remove({ userId });
    }
  }
}

export default new UserRepository();
