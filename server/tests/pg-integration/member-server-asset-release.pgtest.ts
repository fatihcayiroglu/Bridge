// server/tests/pg-integration/member-server-asset-release.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL: SAHİBİ SİLİNEN KALICI DOSYALAR BIRAKILIR (Final21 Faz 19)
// ════════════════════════════════════════════════════════════════════════════
// Günlük temizlik işi alt dizinlerdeki kalıcı varlıklara BİLEREK dokunmaz. Sahibinin
// kaydı silindiğinde onları bırakan tek yol, kaydı silen koddur — ve hiçbiri yoktu:
//   · sunucudan ayrılan/atılan üyenin sunucu profili avatarı/afişi
//   · silinen sunucunun simgesi, afişi, emojileri, GIF'leri, sesleri, üye profilleri
// Bu süit gerçek repository kodunu gerçek veritabanına ve geçici bir yükleme köküne
// karşı çalıştırır; her silinen dosyanın yanında DOKUNULMAMASI gereken bir KONTROL vardır.

import fs from 'fs';
import os from 'os';
import path from 'path';

const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-'));
process.env.BRIDGE_UPLOAD_ROOT = UPLOAD_ROOT;
delete process.env.CDN_PROVIDER;

const db = require('../../db/loader').default;
const { Members, Servers } = require('../../db/repositories');

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-rel';
const U1 = `${P}-u1`;
const U2 = `${P}-u2`;
const OWNER = `${P}-owner`;
const f = (sub: string, name: string) => path.join(UPLOAD_ROOT, sub, name);
const u = (sub: string, name: string) => `/uploads/${sub}/${name}`;
const put = (sub: string, name: string) => {
  fs.mkdirSync(path.join(UPLOAD_ROOT, sub), { recursive: true });
  fs.writeFileSync(f(sub, name), 'x');
};

RUN('gerçek PostgreSQL — sahibi silinen kalıcı dosyalar', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    const like = `${P}-%`;
    for (const t of ['server_emojis', 'server_gifs', 'soundboard', 'channels']) await q(`DELETE FROM ${t} WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM members WHERE "serverId" LIKE $1`, [like]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [like]);
  };
  const user = (id: string, avatar: string | null = null) =>
    q(`INSERT INTO users (_id, username, "displayName", password, "createdAt", "avatarUrl") VALUES ($1, $1, $1, 'x', 1, $2)`, [id, avatar]);
  const server = (id: string, icon: string | null = null, banner: string | null = null) =>
    q(`INSERT INTO servers (_id, name, "ownerId", "createdAt", "iconUrl", "bannerUrl") VALUES ($1, $1, $2, 1, $3, $4)`, [id, OWNER, icon, banner]);
  const member = (userId: string, serverId: string, profile: Record<string, unknown> | null) =>
    q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt", "serverProfile") VALUES ($1, $2, '[]', 1, $3)`,
      [userId, serverId, profile === null ? null : JSON.stringify(profile)]);

  beforeAll(async () => {
    await cleanup();
    await user(OWNER); await user(U1, u('avatars', `avatar_${P}-u1.png`)); await user(U2);
    put('avatars', `avatar_${P}-u1.png`);
  });
  afterAll(async () => {
    await cleanup();
    fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  });

  it('üye sunucudan AYRILINCA sunucu profili avatarı ve afişi bırakılır', async () => {
    await server(`${P}-s1`);
    for (const n of ['mp_av_leave.webp', 'mp_bn_leave.webp']) put('member-profiles', n);
    await member(U1, `${P}-s1`, { avatarUrl: u('member-profiles', 'mp_av_leave.webp'), bannerUrl: u('member-profiles', 'mp_bn_leave.webp'), bio: 'b' });

    await Members.remove(U1, `${P}-s1`);

    expect(await q(`SELECT 1 FROM members WHERE "userId"=$1 AND "serverId"=$2`, [U1, `${P}-s1`])).toHaveLength(0);
    expect(fs.existsSync(f('member-profiles', 'mp_av_leave.webp'))).toBe(false);
    expect(fs.existsSync(f('member-profiles', 'mp_bn_leave.webp'))).toBe(false);
    // KONTROL: kişinin HESAP avatarı üyelikle ilgili değildir, kalır.
    expect(fs.existsSync(f('avatars', `avatar_${P}-u1.png`))).toBe(true);
  });

  it('KONTROL: başka bir kaydın hâlâ başvurduğu profil görseli BIRAKILMAZ', async () => {
    await server(`${P}-s2`);
    put('member-profiles', 'mp_av_shared.webp');
    await member(U1, `${P}-s2`, { avatarUrl: u('member-profiles', 'mp_av_shared.webp') });
    await member(U2, `${P}-s2`, { avatarUrl: u('member-profiles', 'mp_av_shared.webp') });

    await Members.remove(U1, `${P}-s2`);

    expect(fs.existsSync(f('member-profiles', 'mp_av_shared.webp'))).toBe(true);
  });

  it('yasak KALDIRILINCA (satır silinir) profil görseli bırakılır; yasak sürerken KALIR', async () => {
    await server(`${P}-s3`);
    put('member-profiles', 'mp_av_banned.webp');
    await member(U2, `${P}-s3`, { avatarUrl: u('member-profiles', 'mp_av_banned.webp') });
    await Members.banMember(`${P}-s3`, U2, 'spam');
    expect(fs.existsSync(f('member-profiles', 'mp_av_banned.webp'))).toBe(true);

    await Members.unbanMember(`${P}-s3`, U2);
    expect(fs.existsSync(f('member-profiles', 'mp_av_banned.webp'))).toBe(false);
  });

  it('SUNUCU silinince simge, afiş, emoji, GIF, ses ve üye profilleri bırakılır', async () => {
    const S = `${P}-s4`;
    const files: Array<[string, string]> = [
      ['server-assets', `sa_icon_${P}.png`], ['server-assets', `sa_banner_${P}.png`],
      ['emojis', `emoji_${P}.png`], ['server-gifs', `gif_${P}.gif`], ['soundboard', `sb_${P}.mp3`],
      ['member-profiles', `mp_av_${P}-s4.webp`],
    ];
    for (const [sub, n] of files) put(sub, n);
    await server(S, u('server-assets', `sa_icon_${P}.png`), u('server-assets', `sa_banner_${P}.png`));
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'c', 1)`, [`${P}-c4`, S]);
    await q(`INSERT INTO server_emojis (_id, "serverId", name, url, "uploadedBy", "createdAt") VALUES ($1, $2, 'e', $3, $4, 1)`, [`${P}-e4`, S, u('emojis', `emoji_${P}.png`), OWNER]);
    await q(`INSERT INTO server_gifs (_id, "serverId", name, url, "uploadedBy", "createdAt") VALUES ($1, $2, 'g', $3, $4, 1)`, [`${P}-g4`, S, u('server-gifs', `gif_${P}.gif`), OWNER]);
    await q(`INSERT INTO soundboard (_id, "serverId", name, url, "uploadedBy", "createdAt") VALUES ($1, $2, 's', $3, $4, 1)`, [`${P}-b4`, S, u('soundboard', `sb_${P}.mp3`), OWNER]);
    await member(U2, S, { avatarUrl: u('member-profiles', `mp_av_${P}-s4.webp`) });
    // KONTROL: BAŞKA bir sunucunun emojisi.
    put('emojis', `emoji_${P}-other.png`);
    await server(`${P}-s5`);
    await q(`INSERT INTO server_emojis (_id, "serverId", name, url, "uploadedBy", "createdAt") VALUES ($1, $2, 'e', $3, $4, 1)`, [`${P}-e5`, `${P}-s5`, u('emojis', `emoji_${P}-other.png`), OWNER]);

    await expect(Servers.deleteGraphAtomic(S)).resolves.toBe('deleted');

    for (const [sub, n] of files) expect({ file: `${sub}/${n}`, exists: fs.existsSync(f(sub, n)) }).toEqual({ file: `${sub}/${n}`, exists: false });
    expect(fs.existsSync(f('emojis', `emoji_${P}-other.png`))).toBe(true);
    expect(fs.existsSync(f('avatars', `avatar_${P}-u1.png`))).toBe(true);
  });

  it('tanınmayan yollar (kök ekler, çıkartmalar, dış URL) ASLA silinmez', async () => {
    put('stickers', `st_${P}.png`);
    fs.writeFileSync(path.join(UPLOAD_ROOT, `attachment_${P}.png`), 'x');
    const S = `${P}-s6`;
    await server(S, u('stickers', `st_${P}.png`), `/uploads/attachment_${P}.png`);
    await expect(Servers.deleteGraphAtomic(S)).resolves.toBe('deleted');
    expect(fs.existsSync(f('stickers', `st_${P}.png`))).toBe(true);
    expect(fs.existsSync(path.join(UPLOAD_ROOT, `attachment_${P}.png`))).toBe(true);
  });
});
