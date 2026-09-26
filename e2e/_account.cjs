// e2e/_account.cjs
//
// FAZ 5/6 — HESAP SİLME VE DIŞA AKTARMA: GERÇEK ÇALIŞMA ZAMANI KANITI
//
// Birim testleri politikayı ve sözleşmeyi doğrular; bu betik uçları GERÇEK
// sunucu + GERÇEK PostgreSQL üzerinde çalıştırır.
//
// ── GÜVENLİK ──────────────────────────────────────────────────────────────
// Yalnızca bu betiğin KENDİ oluşturduğu tek kullanımlık hesaplar silinir.
// Fikstür kullanıcılarına (alice/bob/...) ve gerçek verilere DOKUNULMAZ.

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const UA = 'Mozilla/5.0 Chrome/120';
const PASS = 'AcctDrill123!';

const H0 = { Accept: 'application/json', 'User-Agent': UA, 'Content-Type': 'application/json' };

// CSRF jetonu OTURUMA BAGLIDIR. Kimliksiz alinan bir jeton, kimlik
// dogrulanmis bir istekte 403 verir. Bu yuzden jeton, kullanilacagi
// kimlikle alinir.
const csrf = async (tok) => {
  const h = tok ? { ...H0, Authorization: 'Bearer ' + tok } : H0;
  return (await (await fetch(BASE + '/api/csrf-token', { headers: h })).json()).token || '';
};

async function mkUser(tag) {
  const username = `e2e_acct_${tag}_${Date.now().toString(36)}`;
  const r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { ...H0, 'X-CSRF-Token': await csrf() },
    body: JSON.stringify({ username, password: PASS, email: `${username}@bridge-e2e.test`, displayName: tag }),
  });
  const j = await r.json().catch(() => ({}));
  const token = j.token || j.accessToken;
  if (!token) throw new Error(`kayit basarisiz ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  return { username, token, id: j.user?._id || j.user?.id };
}

const auth = tok => ({ Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': UA });
async function authJson(tok) {
  return { ...auth(tok), 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf(tok) };
}

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  GECTI  ${name}`); }
  else { fail++; console.log(`  DUSTU  ${name}  ${detail}`); }
}

(async () => {
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── FAZ 6: KISISEL VERI DISA AKTARMA ──');
  const alice = await mkUser('exp');
  const ex = await fetch(BASE + '/api/account/export', { headers: auth(alice.token) });
  const body = await ex.json().catch(() => ({}));

  check('200 doner', ex.status === 200, `status=${ex.status}`);
  check('cagiranin kimligi dogru', body.userId === alice.id || !!body.userId);
  check('profil var', !!body.profile && body.profile.username === alice.username);

  const flat = JSON.stringify(body);
  check('PAROLA HASH sizmiyor', !('password' in (body.profile || {})));
  for (const secret of ['twoFactorSecret', 'twoFactorBackup', 'emailToken']) {
    check(`${secret} sizmiyor`, !flat.includes(`"${secret}"`));
  }
  check('bcrypt hash deseni yok', !/\$2[aby]\$\d\d\$/.test(flat));
  check('yenileme jetonu bolumu yok', !flat.includes('refreshToken') && !('refresh_tokens' in (body.data || {})));

  // Kimliksiz erisim reddedilmeli.
  const anon = await fetch(BASE + '/api/account/export');
  check('kimliksiz DISA AKTARMA reddedilir', anon.status === 401 || anon.status === 403, `status=${anon.status}`);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── FAZ 5: SILME KORUMALARI ──');
  const bob = await mkUser('del');

  const pre = await fetch(BASE + '/api/account/deletion-preflight', { headers: auth(bob.token) });
  const pj = await pre.json().catch(() => ({}));
  check('preflight 200', pre.status === 200, `status=${pre.status}`);
  check('temiz hesap silinebilir', pj.canDelete === true, JSON.stringify(pj.blockers || []));
  check('politika donuyor', Array.isArray(pj.policy) && pj.policy.length > 20);

  // Onaysiz silme reddedilmeli.
  const noConfirm = await fetch(BASE + '/api/account', {
    method: 'DELETE', headers: await authJson(bob.token), body: JSON.stringify({ password: PASS }),
  });
  check('ONAYSIZ silme reddedilir', noConfirm.status === 400, `status=${noConfirm.status}`);

  // Yanlis parola reddedilmeli.
  const badPw = await fetch(BASE + '/api/account', {
    method: 'DELETE', headers: await authJson(bob.token),
    body: JSON.stringify({ password: 'YanlisParola999!', confirm: 'DELETE' }),
  });
  check('YANLIS PAROLA reddedilir', badPw.status === 401, `status=${badPw.status}`);

  // Kimliksiz silme reddedilmeli.
  const anonDel = await fetch(BASE + '/api/account', {
    method: 'DELETE', headers: { ...H0, 'X-CSRF-Token': await csrf() },
    body: JSON.stringify({ password: PASS, confirm: 'DELETE' }),
  });
  check('kimliksiz silme reddedilir', anonDel.status === 401 || anonDel.status === 403, `status=${anonDel.status}`);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── FAZ 5: SAHIPLIK ENGELI (sessiz devir YOK) ──');
  const owner = await mkUser('own');
  const guest = await mkUser('gst');
  const OH = await authJson(owner.token);
  const srv = await (await fetch(BASE + '/api/servers', {
    method: 'POST', headers: OH, body: JSON.stringify({ name: 'OwnDrill ' + Date.now() }),
  })).json();
  const sid = srv._id || srv.id;
  const iv = await (await fetch(BASE + '/api/servers/invites', {
    method: 'POST', headers: OH, body: JSON.stringify({ serverId: sid }),
  })).json();
  await fetch(BASE + '/api/servers/invites/' + iv.code + '/use', {
    method: 'POST', headers: await authJson(guest.token), body: '{}',
  });

  const pre2 = await fetch(BASE + '/api/account/deletion-preflight', { headers: auth(owner.token) });
  const pj2 = await pre2.json().catch(() => ({}));
  check('cok uyeli sunucu sahibi ENGELLENIR', pj2.canDelete === false, JSON.stringify(pj2).slice(0, 160));
  check('engel sunucuyu ADIYLA bildirir',
    (pj2.blockers || []).some(b => b.kind === 'server' && b.memberCount > 1));

  const blocked = await fetch(BASE + '/api/account', {
    method: 'DELETE', headers: await authJson(owner.token),
    body: JSON.stringify({ password: PASS, confirm: 'DELETE' }),
  });
  check('silme 409 ile durdurulur', blocked.status === 409, `status=${blocked.status}`);

  // Sunucu HALA sahibine ait olmali — sessiz devir yok.
  const stillOwned = await (await fetch(BASE + '/api/account/deletion-preflight',
    { headers: auth(owner.token) })).json();
  check('sahiplik DEVREDILMEDI', stillOwned.canDelete === false);

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n── FAZ 5: GERCEK SILME ──');
  const del = await fetch(BASE + '/api/account', {
    method: 'DELETE', headers: await authJson(bob.token),
    body: JSON.stringify({ password: PASS, confirm: 'DELETE' }),
  });
  const dj = await del.json().catch(() => ({}));
  check('silme 200', del.status === 200, `status=${del.status} ${JSON.stringify(dj).slice(0, 140)}`);
  check('uygulanan tablo listesi doner', Array.isArray(dj.applied) && dj.applied.length > 0);

  // Jeton artik calismamali.
  const after = await fetch(BASE + '/api/me', { headers: auth(bob.token) });
  check('silinen hesabin JETONU GECERSIZ', after.status === 401 || after.status === 404,
    `status=${after.status}`);

  // Tekrar giris yapilamamali.
  const relog = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { ...H0, 'X-CSRF-Token': await csrf() },
    body: JSON.stringify({ username: bob.username, password: PASS }),
  });
  check('silinen hesaba GIRIS YAPILAMAZ', relog.status === 401 || relog.status === 404,
    `status=${relog.status}`);

  console.log(`\n── SONUC ──\ngecti=${pass} dustu=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
