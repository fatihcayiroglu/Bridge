// client/js/core/composer/emoji-insert.ts
//
// FAZ K/4 — EMOJIYI COMPOSER'A YERLESTIRME.
//
// Saf hesap ile DOM etkisi AYRILIR: yerlestirme kurallari (nereye, hangi
// bosluklarla, imlec nereye gider) test edilebilir bir fonksiyonda; textarea
// ile konusan kisim ise ince bir sarmalayicidadir.
//
// ── NEDEN OLAY YAYINLANIR ───────────────────────────────────────────────────
// `MessageInputPanel` taslak kaydini, otomatik buyumeyi ve gonder dugmesinin
// etkinligini `input` OLAYINA baglar. Degeri programatik olarak yazmak bu
// olayi TETIKLEMEZ: emoji gorunur, ama taslak kaydedilmez ve kutu buyumez.
// Bu yuzden yerlestirmeden sonra olay elle yayilir.

export interface InsertionResult {
  /** Yeni tam metin. */
  value: string;
  /** Imlecin yeni konumu (emojiden sonrasi). */
  caret: number;
}

/**
 * Metne imlec konumunda emoji yerlestirir.
 *
 * BOSLUK KURALI: emoji komsu kelimelere YAPISMAZ ama bosluk DA COGALTMAZ.
 * "merhaba" + "👍" → "merhaba 👍" olur, "merhaba👍" degil — ikincisi hem
 * okunmaz hem de bazi istemcilerde emojinin ayristirilmasini bozar.
 *
 * Her iki yan da AYRI AYRI kontrol edilir. Sondaki boslugu kosulsuz eklemek
 * metnin ortasina yerlestirmede "ab 🔥  cd" gibi CIFT bosluk uretiyordu;
 * kullanici bunu gormez, alici gorur.
 */
export function insertEmoji(
  text: string, start: number, end: number, emoji: string,
): InsertionResult {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));

  const before = text.slice(0, from);
  const after = text.slice(to);

  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  // Sonrasi zaten bosluklaysa ikincisi eklenmez; metnin SONUNDAYSA eklenir ki
  // kullanici arka arkaya yazmaya devam edebilsin.
  const needsTrailingSpace = !/^\s/.test(after);
  const insert = `${needsLeadingSpace ? ' ' : ''}${emoji}${needsTrailingSpace ? ' ' : ''}`;

  return {
    value: before + insert + after,
    caret: before.length + insert.length,
  };
}

/**
 * Yerlestirmeyi gercek textarea uzerinde uygular.
 *
 * Basarisiz olursa `false` doner — cagiran kullaniciya sessiz bir "hicbir sey
 * olmadi" yerine gercek durumu gosterebilir.
 */
export function applyEmojiToInput(input: HTMLTextAreaElement | HTMLInputElement | null, emoji: string): boolean {
  if (!input) return false;

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const { value, caret } = insertEmoji(input.value, start, end, emoji);

  input.value = value;
  // Odak once verilir; aksi halde `setSelectionRange` bazi tarayicilarda
  // yok sayilir ve imlec metnin sonuna kacar.
  input.focus();
  input.setSelectionRange?.(caret, caret);

  // Taslak kaydi / otomatik buyume / gonder dugmesi bu olaya baglidir.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
