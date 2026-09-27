// client/tests/registration-rules.test.ts
//
// Final21 Faz 18 — kayıt formu "min. 6 karakter" diyordu; sunucu 8'in altını reddediyordu.
// İpucuna uyan kişi (7 karakter) yalnızca "Kayıt bilgileri geçersiz" görüyordu (canlı
// doğrulandı). Kurallar artık tek yerde ve SUNUCU KAYNAĞIYLA karşılaştırılıyor.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, registrationProblem,
} from '../js/core/registration-rules.ts';

const SERVER_AUTH = readFileSync(resolve(__dirname, '../../server/routes/auth.ts'), 'utf8');
const INDEX_HTML = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

describe('registrationProblem — sunucuyla aynı sıra ve sınırlar', () => {
  it.each([
    ['ab', 'uzunparola1', 'username_length'],
    ['a'.repeat(33), 'uzunparola1', 'username_length'],
    ['ayşe', 'uzunparola1', 'username_chars'],
    ['ali veli', 'uzunparola1', 'username_chars'],
    ['ali_veli', 'abc1234', 'password_short'],          // formun eski ipucuna UYAN 7 karakter
    ['ali_veli', 'x'.repeat(129), 'password_long'],
    ['ali_veli', 'abcd1234', null],                     // tam 8: kabul
    ['abc', 'x'.repeat(128), null],                     // alt/üst sınırlar dahil
  ])('%s / %s → %s', (u, p, expected) => {
    expect(registrationProblem(u, p)).toBe(expected);
  });
});

describe('istemci kuralları sunucu kaynağından SAPMAZ', () => {
  it('parola alt/üst sınırı sunucunun kontrolüyle aynı', () => {
    expect(SERVER_AUTH).toContain(`password.length < ${PASSWORD_MIN}`);
    expect(SERVER_AUTH).toContain(`password.length > ${PASSWORD_MAX}`);
  });

  it('kullanıcı adı sınırları ve karakter kümesi sunucununkiyle aynı', () => {
    expect(SERVER_AUTH).toContain(`username.length < ${USERNAME_MIN} || username.length > ${USERNAME_MAX}`);
    expect(SERVER_AUTH).toContain('/^[a-zA-Z0-9_]+$/.test(username)');
  });
});

describe('kayıt ekranı işaretlemesi', () => {
  const registerForm = INDEX_HTML.slice(INDEX_HTML.indexOf('id="register-form"'), INDEX_HTML.indexOf('<!-- MAIN APP -->'));

  it('ipucu ve yer tutucu çevrilir; sabit "6 characters" metni kalmadı', () => {
    expect(registerForm).toContain('data-i18n="password_hint"');
    expect(registerForm).toContain('data-i18n-placeholder="password_placeholder_min"');
    expect(INDEX_HTML).not.toMatch(/6 characters/i);
  });

  it('her kayıt girdisinin bir <label for> ile ERİŞİLEBİLİR adı var', () => {
    for (const id of ['r-displayname', 'r-username', 'r-password']) {
      expect(registerForm).toContain(`for="${id}"`);
    }
  });

  it('çevrilmiş görünür metni ezen sabit Türkçe aria-label kalmadı', () => {
    const auth = INDEX_HTML.slice(INDEX_HTML.indexOf('id="auth-screen"'), INDEX_HTML.indexOf('<!-- MAIN APP -->'));
    for (const hardcoded of ['aria-label="Giriş yap"', 'aria-label="Hesap oluştur"', 'aria-label="Kullanıcı adı"', 'aria-label="Şifre"', 'aria-label="Passkey ile']) {
      expect(auth).not.toContain(hardcoded);
    }
  });
});
