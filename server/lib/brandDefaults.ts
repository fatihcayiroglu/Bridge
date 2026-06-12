/**
 * Bridge marka renkleri — tek kaynak.
 * Discord moru (#2d9cdb) kasıtlı olarak kullanılmaz.
 * CSS: client/css/tokens.css (--brand-h: 210)
 */
export const BRAND_HEX = '#2d9cdb';
export const BRAND_HEX_ALT = '#1bc8a8';
export const ACCENT_HEX = '#f5a623';

export const DEFAULT_AVATAR_COLOR = BRAND_HEX;

export const AVATAR_COLORS = [
  BRAND_HEX,
  '#e05260',
  '#2ecc9a',
  ACCENT_HEX,
  '#a67ee8',
  '#00aff4',
  BRAND_HEX_ALT,
  '#1abc9c',
] as const;
