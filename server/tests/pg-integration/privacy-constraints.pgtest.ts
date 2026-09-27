// server/tests/pg-integration/privacy-constraints.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL: users GİZLİLİK ALAN KISITLARI (migrations_pg/044)
// ════════════════════════════════════════════════════════════════════════════
// Bu dosya bir MOCK ile kanıtlanamaz — ölçtüğü şey PostgreSQL'in bir yazmayı
// gerçekten reddedip reddetmediğidir.
//
// ÖLÇÜLEN KUSUR: `017` ve `026` migration'ları CHECK kısıtı tanımlıyordu ama
// sütunları `db/postgres/schema.ts` daha önce oluşturduğu için
// `ADD COLUMN IF NOT EXISTS` dalı hiç çalışmıyor, kısıt HİÇ oluşmuyordu. Hem
// taze kurulum hem tam dağıtım `dmPrivacy='nobody'` yazmayı kabul ediyordu.
//
// `044` bunu `NOT VALID` + koşullu `VALIDATE` desenine göre düzeltir:
// mevcut kullanıcı verisi ASLA sessizce yeniden yazılmaz.

import { Client } from 'pg';

const PG_URL = process.env.PG_TEST_URL;
const d = PG_URL ? describe : describe.skip;

let c: Client;
const made: string[] = [];

async function insertUser(col: string, value: string): Promise<'ACCEPTED' | 'REJECTED'> {
  const id = `pgc_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await c.query(
      `INSERT INTO users (_id, username, "displayName", password, "createdAt", "${col}")
       VALUES ($1, $1, $1, 'x', 0, $2)`, [id, value]);
    made.push(id);
    return 'ACCEPTED';
  } catch {
    return 'REJECTED';
  }
}

async function constraintState(name: string): Promise<{ exists: boolean; validated: boolean }> {
  const r = await c.query(
    `SELECT c.convalidated FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'users' AND c.conname = $1`, [name]);
  return { exists: r.rowCount === 1, validated: r.rows[0]?.convalidated === true };
}

d('users gizlilik alan kısıtları (gerçek PostgreSQL)', () => {
  beforeAll(async () => {
    c = new Client({ connectionString: PG_URL });
    await c.connect();
  });

  afterAll(async () => {
    if (made.length) await c.query('DELETE FROM users WHERE _id = ANY($1)', [made]);
    await c.end();
  });

  it('her iki kısıt da MEVCUT ve DOĞRULANMIŞ', async () => {
    // Kısıt yalnızca "var" değil, VALIDATED olmalı: NOT VALID kalmışsa
    // mevcut satırlar hiç denetlenmemiş demektir.
    expect(await constraintState('users_dmPrivacy_check')).toEqual({ exists: true, validated: true });
    expect(await constraintState('users_presenceVisibility_check')).toEqual({ exists: true, validated: true });
  });

  it.each(['everyone', 'friends', 'none'])('dmPrivacy=%s KABUL edilir', async (v) => {
    expect(await insertUser('dmPrivacy', v)).toBe('ACCEPTED');
  });

  it.each(['nobody', 'None', 'NONE', 'contacts', '', 'everyone '])(
    'dmPrivacy=%p REDDEDİLİR', async (v) => {
      // ── ANA İDDİA ────────────────────────────────────────────────────────
      // Bu yazmalar eskiden kabul ediliyordu ve DM gizlilik kontrolünün
      // sessizce atlanmasına yol açıyordu.
      expect(await insertUser('dmPrivacy', v)).toBe('REJECTED');
    });

  it.each(['visible', 'hidden'])('presenceVisibility=%s KABUL edilir', async (v) => {
    expect(await insertUser('presenceVisibility', v)).toBe('ACCEPTED');
  });

  it.each(['Hidden', 'HIDDEN', 'invisible', 'hide', ''])(
    'presenceVisibility=%p REDDEDİLİR', async (v) => {
      expect(await insertUser('presenceVisibility', v)).toBe('REJECTED');
    });

  it('UPDATE ile de alan dışına çıkılamaz', async () => {
    // Kısıt yalnızca INSERT'te değil, güncellemede de uygulanmalı — aksi
    // hâlde bir hesap sonradan alan dışına taşınabilirdi.
    const id = `pgc_upd_${Math.random().toString(36).slice(2, 8)}`;
    await c.query(
      `INSERT INTO users (_id, username, "displayName", password, "createdAt")
       VALUES ($1,$1,$1,'x',0)`, [id]);
    made.push(id);
    await expect(
      c.query('UPDATE users SET "dmPrivacy" = $2 WHERE _id = $1', [id, 'nobody']),
    ).rejects.toThrow();
  });

  it('varsayılanlar alan içindedir', async () => {
    const id = `pgc_def_${Math.random().toString(36).slice(2, 8)}`;
    await c.query(
      `INSERT INTO users (_id, username, "displayName", password, "createdAt")
       VALUES ($1,$1,$1,'x',0)`, [id]);
    made.push(id);
    const r = await c.query('SELECT "dmPrivacy", "presenceVisibility" FROM users WHERE _id = $1', [id]);
    expect(r.rows[0].dmPrivacy).toBe('everyone');
    expect(r.rows[0].presenceVisibility).toBe('visible');
  });
});
