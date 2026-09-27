// client/js/core/voice/ptt-settings.ts
//
// BAS-KONUŞ AYARLARI — TEK KALICILIK SAHİBİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR MODÜL
// ════════════════════════════════════════════════════════════════════════════
// PTT durumu yalnızca `VoicePTTController` içinde yaşıyordu ve o bileşen
// SADECE ses sahnesi açıldığında mount ediliyor. Sonuç: kullanıcı bas-konuşu
// ancak ZATEN bir aramadayken yapılandırabilirdi — ayarları açıp hazırlamak
// mümkün değildi.
//
// Çözüm, ikinci bir PTT sahibi yaratmak DEĞİLDİR. Projede bunun kanonik
// örneği zaten var: `input-sensitivity.ts` eşiği tutar, `InputSensitivityControl`
// yazar, VAD okur. Aynı desen burada uygulanır:
//
//   · DAVRANIŞ sahibi   → VoicePTTController (tuş dinleme, mute çağrıları)
//   · KALICILIK sahibi  → bu modül
//
// Böylece ayarlar arayüzü denetleyici mount edilmemişken de çalışır; denetleyici
// mount edildiğinde aynı kaydı okur.
//
// Depolama anahtarı DEĞİŞMEDİ (`bridgePTT`): mevcut kullanıcı tercihleri korunur.

/** Kayıtlı tuş — `code` eşleştirme için, `label` gösterim için. */
export interface PTTKey {
  code: string;
  label: string;
}

export interface PTTSettings {
  enabled: boolean;
  mode: 'hold' | 'toggle';
  key: PTTKey | null;
  /** Konuşma bittikten sonra mikrofonun kapanması için gecikme (ms). */
  releaseDelay: number;
}

export const PTT_STORAGE_KEY = 'bridgePTT';

export const PTT_DEFAULTS: PTTSettings = {
  enabled: false,
  mode: 'hold',
  key: null,
  releaseDelay: 200,
};

/** Değişiklik sinyali — ayrı bileşen ağaçları aynı kaydı yeniden okur. */
export const PTT_CHANGED_EVENT = 'bridge:ptt-changed';

function isKey(v: unknown): v is PTTKey {
  if (!v || typeof v !== 'object') return false;
  const k = v as Partial<PTTKey>;
  return typeof k.code === 'string' && typeof k.label === 'string';
}

/**
 * Kayıtlı ayarları okur.
 *
 * FAIL-SAFE: bozuk/eksik kayıt varsayılana düşer. Bas-konuş yanlış yapılandırma
 * yüzünden mikrofonu AÇIK bırakmamalıdır; bu yüzden `enabled` yalnızca gerçek
 * `true` değerinde açılır.
 */
export function loadPttSettings(): PTTSettings {
  if (typeof localStorage === 'undefined') return { ...PTT_DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(PTT_STORAGE_KEY) ?? '{}') as Partial<PTTSettings>;
    return {
      enabled: raw.enabled === true,
      mode: raw.mode === 'toggle' ? 'toggle' : 'hold',
      key: isKey(raw.key) ? { code: raw.key.code, label: raw.key.label } : null,
      releaseDelay: Number.isFinite(raw.releaseDelay) ? Number(raw.releaseDelay) : PTT_DEFAULTS.releaseDelay,
    };
  } catch {
    return { ...PTT_DEFAULTS };
  }
}

/**
 * Ayarları yazar ve dinleyicileri uyarır.
 *
 * GEÇİCİ durum (`active` — "şu an basılı") KASITLI OLARAK saklanmaz: yeniden
 * yüklendiğinde mikrofonun açık kalmasına yol açardı.
 */
export function savePttSettings(settings: PTTSettings): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(PTT_STORAGE_KEY, JSON.stringify({
        enabled: settings.enabled,
        mode: settings.mode,
        key: settings.key,
        releaseDelay: settings.releaseDelay,
      }));
    } catch { /* kota dolu olabilir — ayar uçucu kalır, ürün çalışmayı sürdürür */ }
  }
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(PTT_CHANGED_EVENT));
  }
}

/** Bas-konuş gerçekten kullanılabilir mi (açık VE tuş atanmış)? */
export function isPttUsable(s: PTTSettings): boolean {
  return s.enabled && s.key !== null;
}
