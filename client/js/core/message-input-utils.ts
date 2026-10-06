import { t } from './i18n/index.ts';
// Pure, reusable helpers for MessageInputPanel. Keeping payload validation and
// user-facing error mapping outside the Svelte lifecycle owner reduces stateful
// surface complexity and makes these rules independently testable.

export interface ScheduledMessageRow {
  _id: string;
  channelId: string;
  content: string;
  sendAt: number;
}

export function safeMutationError(code?: string): string {
  if (code === 'AUTOMOD_BLOCKED') return t('mutation_moderation_blocked', 'Bu düzenleme sunucu moderasyon kuralları tarafından engellendi.');
  if (code === 'AUTOMOD_UNAVAILABLE') return t('mutation_moderation_unavailable', 'Moderasyon denetimi şu anda tamamlanamadı. Düzenleme uygulanmadı.');
  if (code === 'CONFLICT') return t('error_conflict', 'Bu içerik başka bir yerde değişmiş. Sayfayı yenile.');
  if (code === 'FORBIDDEN' || code === 'NOT_VISIBLE') return t('error_forbidden', 'Bu işlem için yetkiniz yok.');
  if (code === 'NOT_FOUND') return t('error_not_found', 'İstenen içerik bulunamadı.');
  return t('mutation_connection_failed', 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.');
}

export function newAckId(): string {
  const c = globalThis.crypto;
  return typeof c?.randomUUID === 'function'
    ? c.randomUUID()
    : `ack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export function safeScheduledRow(value: unknown): ScheduledMessageRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row._id === 'string' ? row._id : '';
  const channelId = typeof row.channelId === 'string' ? row.channelId : '';
  const content = typeof row.content === 'string' ? row.content : '';
  const sendAt = typeof row.sendAt === 'number' ? row.sendAt : Number(row.sendAt);
  if (!id || !channelId || !content || !Number.isFinite(sendAt)) return null;
  return { _id: id, channelId, content, sendAt };
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function uploadErrorText(status: number): string {
  if (status === 415) return t('upload_type_unsupported', 'Bu dosya türü desteklenmiyor.');
  if (status === 413) return t('error_upload_size', 'Dosya çok büyük.');
  if (status === 422) return t('upload_security_failed', 'Dosya güvenlik taramasından geçemedi.');
  if (status === 403) return t('upload_forbidden', 'Bu kanala dosya gönderme yetkiniz yok.');
  if (status === 400) return t('upload_rejected', 'Dosya kabul edilmedi.');
  if (status === 429) return t('upload_rate_limit', 'Çok hızlı dosya gönderiyorsun. Biraz bekleyip tekrar dene.');
  return t('upload_failed', 'Yükleme başarısız. Lütfen tekrar dene.');
}
