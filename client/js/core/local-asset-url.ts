/**
 * Resolve a persisted server-owned asset path against the configured API base.
 * Discovery/profile metadata is untrusted database state, so reject absolute,
 * protocol-relative and non-HTTP(S) values rather than feeding them to HTML/CSS
 * URL contexts.
 */
export function resolveLocalAssetUrl(value: unknown, apiBase: string, origin: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '';
  if (/[\u0000-\u001f\u007f\\"'<>;&()]/.test(value) || /javascript:/i.test(value)) return '';
  try {
    const base = new URL(apiBase || '/', origin);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return '';
    const resolved = new URL(value, base);
    if ((resolved.protocol !== 'http:' && resolved.protocol !== 'https:') || resolved.origin !== base.origin) return '';
    return resolved.href;
  } catch {
    return '';
  }
}
