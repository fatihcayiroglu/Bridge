import { t } from './i18n/index.ts';
/**
 * Stable product copy for DM/GDM delivery failures.
 *
 * Socket payloads are a trust boundary: the server may include diagnostic or
 * deployment-specific text, but production UI must render only known product
 * copy selected by a bounded error code. Unknown codes fall back safely.
 */
export function messageDeliveryError(code: unknown, kind: 'channel' | 'dm' | 'gdm'): string {
  switch (typeof code === 'string' ? code : '') {
    case 'EMPTY_MESSAGE':
      return t('delivery_empty', 'Boş mesaj gönderilemez.');
    case 'MESSAGE_TOO_LONG':
      return t('delivery_too_long', 'Mesaj çok uzun. Kısaltıp yeniden deneyin.');
    case 'USER_NOT_FOUND':
      return t('delivery_user_unavailable', 'Bu kullanıcı artık kullanılamıyor.');
    case 'INVALID_FILE_REFERENCE':
      return t('delivery_file_unavailable', 'Dosya artık kullanılamıyor. Eki yeniden seçip gönderin.');
    case 'CHANNEL_NOT_FOUND':
      return t('delivery_channel_unavailable', 'Bu kanal artık kullanılamıyor.');
    case 'MISSING_PERMISSION':
    case 'PERMISSION_DENIED':
      return kind === 'channel'
        ? t('delivery_channel_permission', 'Bu kanala mesaj gönderme yetkiniz yok.')
        : t('delivery_permission_generic', 'Bu işlemi yapma yetkiniz yok.');
    case 'DM_POLICY_DENIED':
      return t('delivery_dm_blocked', 'Bu kullanıcıyla şu anda mesajlaşamazsınız.');
    case 'NOT_A_MEMBER':
      return t('delivery_group_forbidden', 'Bu grup konuşmasına artık erişiminiz yok.');
    case 'RATE_LIMITED':
      return t('delivery_rate_limit', 'Çok hızlı mesaj gönderiyorsunuz. Biraz sonra yeniden deneyin.');
    case 'NONCE_CONFLICT':
      return t('delivery_idempotency_failed', 'Bu gönderim güvenli biçimde yeniden kullanılamadı. Mesajı yeniden gönderin.');
    case 'INVALID_PAYLOAD':
      return t('delivery_invalid_request', 'Mesaj gönderme isteği geçersizdi. Yeniden deneyin.');
    default:
      return kind === 'gdm'
        ? t('delivery_group_failed', 'Grup mesajı gönderilemedi. Yeniden deneyin.')
        : kind === 'channel'
          ? t('delivery_send_failed', 'Mesaj gönderilemedi. Yeniden deneyin.')
          : t('delivery_send_failed', 'Mesaj gönderilemedi. Yeniden deneyin.');
  }
}

export function connectionLostDeliveryError(): string {
  return t('delivery_connection_lost', 'Bağlantı kesildi. Mesajın durumunu doğrulamak için yeniden deneyin.');
}
