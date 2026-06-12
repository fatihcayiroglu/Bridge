// client/js/core/ui/styles.ts
// Bridge Design System — tüm DUI CSS token'larını tek seferinde inject eder
// İki kez çalışmaz (id kontrolü sayesinde)

'use strict';

export function injectDUIStyles(): void {
  if (document.getElementById('dui-styles')) return;
  const style = document.createElement('style');
  style.id = 'dui-styles';
  style.textContent = `
    /* ─── BUTON ─────────────────────────────────────── */
    .dui-btn {
      display: inline-flex; align-items: center; justify-content: center;
      border: none; border-radius: 4px; cursor: pointer; font-family: inherit;
      font-weight: 500; line-height: 1; position: relative; overflow: hidden;
      transition: background .15s, opacity .15s, transform .1s;
      user-select: none; white-space: nowrap; text-decoration: none;
    }
    .dui-btn:active:not(:disabled) { transform: scale(0.97); }
    .dui-btn:disabled { opacity: .4; cursor: not-allowed; }
    .dui-btn__inner { display: flex; align-items: center; gap: 6px; }
    .dui-btn__emoji { font-size: 1.1em; line-height: 1; }

    /* Boyutlar */
    .dui-btn--sm  { padding: 4px 12px; font-size: 12px; height: 28px; }
    .dui-btn--md  { padding: 8px 16px; font-size: 14px; height: 38px; }
    .dui-btn--lg  { padding: 10px 20px; font-size: 15px; height: 44px; }

    /* Stiller */
    .dui-btn--primary   { background: var(--brand, #2d9cdb); color: #fff; }
    .dui-btn--primary:hover:not(:disabled)   { background: hsl(235, 85%, 64%); }
    .dui-btn--secondary { background: var(--bg-3, #4f545c); color: var(--text-primary, #fff); }
    .dui-btn--secondary:hover:not(:disabled) { background: var(--bg-4, #5d6269); }
    .dui-btn--danger    { background: var(--red, #ed4245); color: #fff; }
    .dui-btn--danger:hover:not(:disabled)    { background: #c0282a; }
    .dui-btn--success   { background: var(--green, #43b581); color: #fff; }
    .dui-btn--success:hover:not(:disabled)   { background: #3aa06f; }
    .dui-btn--link      { background: none; color: var(--brand, #2d9cdb); padding-left: 4px; padding-right: 4px; }
    .dui-btn--link:hover:not(:disabled)      { text-decoration: underline; }
    .dui-btn--ghost     { background: none; color: var(--text-primary, #fff); border: 1.5px solid var(--border, #40444b); }
    .dui-btn--ghost:hover:not(:disabled)     { background: var(--bg-3, #4f545c); }

    /* Ripple */
    .dui-btn__ripple {
      position: absolute; border-radius: 50%;
      background: rgba(255,255,255,.25);
      transform: scale(0); animation: duiBtnRipple .5s linear;
      pointer-events: none;
    }
    @keyframes duiBtnRipple { to { transform: scale(4); opacity: 0; } }

    /* ─── ACTION ROW ────────────────────────────────── */
    .dui-action-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }

    /* ─── SELECT ─────────────────────────────────────── */
    .dui-select { position: relative; width: 100%; }
    .dui-select__trigger {
      width: 100%; display: flex; align-items: center; justify-content: space-between;
      background: var(--bg-3, #40444b); border: 1px solid var(--border, #202225);
      border-radius: 4px; color: var(--text-primary, #dcddde);
      cursor: pointer; font-family: inherit; font-size: 14px;
      padding: 8px 12px; transition: border-color .15s;
    }
    .dui-select__trigger:hover, .dui-select--open .dui-select__trigger {
      border-color: var(--brand, #2d9cdb);
    }
    .dui-select--disabled .dui-select__trigger { opacity: .4; cursor: not-allowed; }
    .dui-select__value { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dui-select__value:not(.dui-select__value--filled) { color: var(--text-muted, #72767d); }
    .dui-select__arrow { flex-shrink: 0; color: var(--text-muted, #72767d); transition: transform .2s; }
    .dui-select--open .dui-select__arrow { transform: rotate(180deg); }
    .dui-select__dropdown {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0;
      background: var(--bg-2, #2f3136); border: 1px solid var(--border, #202225);
      border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
      max-height: 280px; overflow-y: auto; z-index: 1000;
      animation: duiDropdownIn .12s ease;
    }
    .dui-select__dropdown--up { top: auto; bottom: calc(100% + 4px); animation: duiDropdownInUp .12s ease; }
    @keyframes duiDropdownIn   { from { opacity:0; transform: translateY(-6px); } }
    @keyframes duiDropdownInUp { from { opacity:0; transform: translateY(6px); } }
    .dui-select__option {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; cursor: pointer;
      transition: background .1s; border-radius: 4px; margin: 2px 4px;
    }
    .dui-select__option:hover, .dui-select__option--focused {
      background: var(--brand, #2d9cdb);
    }
    .dui-select__option:hover .dui-select__opt-desc,
    .dui-select__option--focused .dui-select__opt-desc { color: rgba(255,255,255,.7); }
    .dui-select__option--selected { background: rgba(45,156,219,.3); }
    .dui-select__option--selected:hover { background: var(--brand, #2d9cdb); }
    .dui-select__option--disabled { opacity: .4; cursor: not-allowed; }
    .dui-select__opt-emoji { font-size: 20px; flex-shrink: 0; }
    .dui-select__opt-text { flex: 1; min-width: 0; }
    .dui-select__opt-label { display: block; font-size: 14px; font-weight: 500; color: var(--text-primary, #dcddde); }
    .dui-select__opt-desc  { display: block; font-size: 11px; color: var(--text-muted, #72767d); margin-top: 2px; }
    .dui-select__opt-check { color: var(--green, #43b581); font-weight: 700; flex-shrink: 0; }
    .dui-select__divider {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 4px; margin-top: 4px;
    }
    .dui-select__divider::before, .dui-select__divider::after {
      content: ''; flex: 1; height: 1px; background: var(--border, #40444b);
    }
    .dui-select__divider span { font-size: 10px; font-weight: 700; color: var(--text-muted, #72767d); text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }

    /* ─── BADGE ──────────────────────────────────────── */
    .dui-badge {
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 999px; font-weight: 700; white-space: nowrap; flex-shrink: 0;
    }
    .dui-badge--xs  { font-size: 9px; padding: 1px 5px; min-width: 14px; height: 14px; }
    .dui-badge--sm  { font-size: 10px; padding: 2px 6px; min-width: 16px; height: 16px; }
    .dui-badge--md  { font-size: 12px; padding: 3px 8px; min-width: 20px; height: 20px; }
    .dui-badge--blurple { background: var(--brand, #2d9cdb); color: #fff; }
    .dui-badge--green   { background: var(--green, #43b581); color: #fff; }
    .dui-badge--red     { background: var(--red, #ed4245); color: #fff; }
    .dui-badge--yellow  { background: var(--yellow, #faa61a); color: #000; }
    .dui-badge--gray    { background: var(--bg-3, #4f545c); color: var(--text-muted, #72767d); }
    .dui-badge--dot { width: 8px; height: 8px; min-width: 8px; padding: 0; border-radius: 50%; }

    /* ─── TOOLTIP ────────────────────────────────────── */
    .dui-tooltip {
      position: absolute; z-index: 9999; padding: 6px 10px;
      background: var(--bg-1, #18191c); color: var(--text-primary, #dcddde);
      border-radius: 6px; font-size: 13px; font-weight: 500;
      pointer-events: none; box-shadow: 0 4px 16px rgba(0,0,0,.5);
      opacity: 0; transform: scale(.95); transition: opacity .12s, transform .12s;
      max-width: 240px; text-align: center; white-space: nowrap;
    }
    .dui-tooltip--visible { opacity: 1; transform: scale(1); }

    /* ─── DİVİDER ────────────────────────────────────── */
    .dui-divider {
      display: flex; align-items: center; gap: 8px;
      color: var(--text-muted, #72767d);
    }
    .dui-divider::before, .dui-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--border, #40444b);
    }
    .dui-divider--sm  { margin: 8px 0; }
    .dui-divider--md  { margin: 16px 0; }
    .dui-divider--lg  { margin: 24px 0; }
    .dui-divider__label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }

    /* ─── SWITCH ─────────────────────────────────────── */
    .dui-switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
    .dui-switch--disabled { opacity: .4; cursor: not-allowed; }
    .dui-switch__input { position: absolute; opacity: 0; width: 0; height: 0; }
    .dui-switch__track {
      position: relative; width: 44px; height: 24px;
      background: var(--bg-3, #4f545c); border-radius: 24px;
      transition: background .2s; flex-shrink: 0;
    }
    .dui-switch__thumb {
      position: absolute; width: 18px; height: 18px;
      background: #fff; border-radius: 50%; top: 3px; left: 3px;
      transition: transform .2s; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .dui-switch__label { font-size: 14px; color: var(--text-primary, #dcddde); }

    /* ─── CONFIRM MODAL ──────────────────────────────── */
    .dui-confirm-overlay { animation: duiFadeIn .15s ease; }
    @keyframes duiFadeIn { from { opacity:0; } }
    .dui-confirm-card { animation: duiSlideUp .18s ease; }
    @keyframes duiSlideUp { from { opacity:0; transform: translateY(20px) scale(.97); } }
    .dui-confirm-header { margin-bottom: 12px; }
    .dui-confirm-title { font-size: 18px; font-weight: 700; margin: 0; }
    .dui-confirm-desc { color: var(--text-muted, #72767d); font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
    .dui-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `;
  document.head.appendChild(style);
}
