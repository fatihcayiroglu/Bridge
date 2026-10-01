import { t } from './i18n/index';

/**
 * getUserMedia hatasını kullanıcıya gösterilebilir güvenli metne çevirir.
 * Ham `DOMException` mesajı (cihaz adı, iç hata dizesi) dışarı sızmaz.
 *
 * P2P ve SFU sesli katılımı AYNI eşlemeyi kullanır. P4 (ÖLÇÜLDÜ, Android 14 emülatörü):
 * SFU yolu her hatayı "Mikrofon bulunamadı" diye gösteriyordu; izni reddeden kullanıcıya
 * donanım yok deniyor, izni nereden açacağı söylenmiyordu.
 */
export function micErrorMessage(err: unknown): string {
  switch ((err as { name?: string } | null)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return t('mic_permission_denied', 'Mikrofon izni verilmedi — sesli kanala sessiz olarak katıldın.');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return t('mic_not_found', 'Kullanılabilir mikrofon bulunamadı — sessiz katıldın.');
    case 'NotReadableError':
      return t('mic_in_use', 'Mikrofona erişilemiyor. Başka bir uygulama kullanıyor olabilir.');
    default:
      return t('mic_open_failed', 'Mikrofon açılamadı — sesli kanala sessiz olarak katıldın.');
  }
}
