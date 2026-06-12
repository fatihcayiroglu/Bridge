// client/js/admin/utils.ts
// Paylaşılan yardımcı fonksiyonlar: formatlama, UI bileşenleri, API erişimi
// Tüm admin modülleri tarafından import edilir.

export const _adminCard = (content: string, extra = '') =>
  `<div style="background:#161627;border-radius:12px;padding:20px;border:1px solid #1e1e38;${extra}">${content}</div>`;

export const _statCard = (icon: string, label: string, value: number | string | null, color = '#8892f8') => `
  <div style="background:#161627;border-radius:12px;padding:18px 20px;border:1px solid #1e1e38;">
    <div style="color:#555;font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
      <span>${icon}</span><span>${label}</span>
    </div>
    <div style="color:${color};font-size:26px;font-weight:700;">
      ${typeof value === 'number' ? value.toLocaleString('tr-TR') : (value ?? '—')}
    </div>
  </div>`;

export const _sectionTitle = (text: string) =>
  `<h2 style="color:#d0d0f0;margin:0 0 20px;font-size:18px;font-weight:700;">${text}</h2>`;

export const _emptyState = (msg: string) =>
  `<div style="color:#444;padding:40px;text-align:center;font-size:14px;">${msg}</div>`;

export function _fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function _fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('tr-TR');
}
