// client/js/core/registration-rules.ts
//
// Kayıt formunun kuralları — SUNUCUNUN kurallarının aynası (server/routes/auth.ts `/register`).
//
// Final21 Faz 18: form "min. 6 karakter" diyordu, sunucu 8'in altını reddediyordu. İpucuna
// uyan kişi "Kayıt bilgileri geçersiz" gibi genel bir hata alıyor ve NEDENİNİ öğrenemiyordu.
// Kurallar burada TEK yerde durur; `tests/registration-rules.test.ts` bu değerleri sunucu
// kaynağıyla karşılaştırır, biri değişip diğeri kalırsa test düşer.
//
// Bu bir GÜVENLİK sınırı değildir — sunucu yine doğrular. Amaç, kişiye neyin yanlış
// olduğunu istek atmadan ve kendi dilinde söylemektir.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const USERNAME_CHARS = /^[a-zA-Z0-9_]+$/;

export type RegistrationProblem =
  | 'username_length'
  | 'username_chars'
  | 'password_short'
  | 'password_long';

/** İlk ihlal edilen kural, ya da hepsi uygunsa `null`. Sıra sunucununkiyle aynıdır. */
export function registrationProblem(username: string, password: string): RegistrationProblem | null {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return 'username_length';
  if (!USERNAME_CHARS.test(username)) return 'username_chars';
  if (password.length < PASSWORD_MIN) return 'password_short';
  if (password.length > PASSWORD_MAX) return 'password_long';
  return null;
}
