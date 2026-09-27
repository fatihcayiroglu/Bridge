// client/js/core/voice/input-sensitivity.ts
//
// GIRIS HASSASIYETI — ses etkinlestirme esigi.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUK
// ════════════════════════════════════════════════════════════════════════════
// VAD esikleri SABIT kodlanmisti (`VAD_TUNING.openRms = 0.020`). Gurultulu bir
// odada mikrofon surekli aciliyor, sessiz bir mikrofonda ise konusma hic
// algilanmiyordu — kullanicinin yapabilecegi HICBIR SEY yoktu. Gunluk
// kullanimda bu, "beni duymuyorlar" ya da "arka planimi herkes duyuyor"
// olarak yasanir.
//
// ── TASARIM ───────────────────────────────────────────────────────────────
// IKINCI bir ses hatti KURULMAZ. Mevcut VAD zaten `tuning` parametresi
// aliyordu; burada yalnizca o parametre TURETILIR. Boylece tek bir olcum
// yolu, tek bir dogru kalir.
//
//   • otomatik (varsayilan) : urunun kalibre edilmis esikleri
//   • manuel                : kullanicinin sectigi esik
//
// PTT BAGIMSIZDIR: bas-konus etkinken esik hic kullanilmaz, cunku konusma
// niyeti tusla bildirilir. Ikisini birbirine baglamak, PTT kullanicisini
// anlamsizca esige tabi kilardi.
//
// GIZLILIK: yalnizca TEK bir sayi (RMS) olculur ve yerelde kalir. Ses ornegi
// ne saklanir ne de gonderilir.

import { VAD_TUNING, type VadTuning } from '../voice-activity-detector.js';

const STORAGE_KEY = 'bridge:voice-sensitivity';

export type SensitivityMode = 'auto' | 'manual';

export interface SensitivitySetting {
  mode: SensitivityMode;
  /** Manuel modda konusmanin BASLADIGI RMS esigi. */
  threshold: number;
}

/** Kullanilabilir esik araligi. Ust sinir, normal konusmanin ustunde kalir. */
export const SENSITIVITY_RANGE = { min: 0.002, max: 0.120 } as const;

export const DEFAULT_SENSITIVITY: SensitivitySetting = {
  mode: 'auto',
  threshold: VAD_TUNING.openRms,
};

/**
 * Kapanis esigi ACILIS esiginin ALTINDA olmalidir (histerezis).
 *
 * Tek esik kullanmak, sesin esik civarinda titremesi durumunda gostergeyi
 * saniyede onlarca kez actirip kapatirdi. Oran, urunun kalibre edilmis
 * varsayilanindan alinir ki manuel mod da ayni "his"te kalsin.
 */
const CLOSE_RATIO = VAD_TUNING.closeRms / VAD_TUNING.openRms;

export function clampThreshold(value: unknown): number {
  // `Number(null)` === 0 ve `Number('')` === 0'dir. Ciplak `Number()` ile
  // kelepçelemek, sayi OLMAYAN bir girdiyi sessizce EN HASSAS ayara
  // cevirirdi (0 → alt sinir) — mikrofonu asiri duyarli yapan, kullanicinin
  // istemedigi bir sonuc. Tur ONCE dogrulanir, sonra kelepçelenir.
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
  if (!Number.isFinite(numeric)) return DEFAULT_SENSITIVITY.threshold;
  return Math.min(SENSITIVITY_RANGE.max, Math.max(SENSITIVITY_RANGE.min, numeric));
}

/** Ayardan VAD ayar nesnesi turetir. Otomatik mod urunun varsayilanidir. */
export function tuningFor(setting: SensitivitySetting): VadTuning {
  if (setting.mode !== 'manual') return VAD_TUNING;
  const openRms = clampThreshold(setting.threshold);
  return {
    ...VAD_TUNING,
    openRms,
    // Histerezis korunur; asla acilis esigine esit/ustu olamaz.
    closeRms: Math.max(SENSITIVITY_RANGE.min / 2, openRms * CLOSE_RATIO),
  };
}

// ── Kalicilik ──────────────────────────────────────────────────────────────
//
// Ayar CIHAZ BAZLIDIR: ayni hesap sessiz bir dizustunde ve gurultulu bir
// masaustunde farkli esik ister. Bu yuzden sunucuya degil, yerel depolamaya
// yazilir. Depolama hatasi ses ozelligini BOZMAZ.

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

export function parseSensitivity(raw: unknown): SensitivitySetting {
  if (typeof raw !== 'string' || !raw) return { ...DEFAULT_SENSITIVITY };
  try {
    const parsed = JSON.parse(raw) as Partial<SensitivitySetting>;
    const mode: SensitivityMode = parsed?.mode === 'manual' ? 'manual' : 'auto';
    return { mode, threshold: clampThreshold(parsed?.threshold) };
  } catch {
    return { ...DEFAULT_SENSITIVITY };
  }
}

export function loadSensitivity(storage: StorageLike | null = defaultStorage()): SensitivitySetting {
  if (!storage) return { ...DEFAULT_SENSITIVITY };
  try { return parseSensitivity(storage.getItem(STORAGE_KEY)); }
  catch { return { ...DEFAULT_SENSITIVITY }; }
}

export function saveSensitivity(
  setting: SensitivitySetting,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      mode: setting.mode === 'manual' ? 'manual' : 'auto',
      threshold: clampThreshold(setting.threshold),
    }));
  } catch { /* kota / ozel mod — ses calismaya devam eder */ }
}

/**
 * Olculen RMS'i olcege oturtur (0..1).
 *
 * Ses seviyeleri logaritmik algilanir; dogrusal cizim, normal konusmayi
 * olcegin en solunda sikistirip gostergeyi okunmaz yapardi.
 */
export function levelToPercent(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const ratio = Math.log10(1 + (rms / SENSITIVITY_RANGE.max) * 9);   // log1p tabanli
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
