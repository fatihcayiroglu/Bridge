// client/js/core/v44/styles.js
// ModÃ¼l: v44 CSS enjeksiyonu + baÅŸlangÄ±Ã§ logu
'use strict';

(function injectV44CSS() {
  const style = document.createElement('style');
  style.textContent = `
    /* â”€â”€ Voice Volume Panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    .bvv-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .bvv-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
    }
    .bvv-close:hover { color: var(--text-primary); }
    .bvv-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .bvv-val {
      font-size: 13px;
      font-weight: 700;
      min-width: 36px;
      text-align: right;
      color: var(--brand);
    }
    .bvv-slider {
      flex: 1;
      accent-color: var(--brand);
      cursor: pointer;
    }
    .bvv-presets {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .bvv-presets button {
      background: var(--bg-tertiary, #36393f);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 11px;
      padding: 4px 8px;
      transition: .12s;
    }
    .bvv-presets button:hover {
      background: var(--brand);
      color: #fff;
      border-color: transparent;
    }

    /* â”€â”€ Advanced Search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    #gs-filter-bar {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-secondary);
    }
    .gs-filter-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .gs-filter-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: .5px;
    }
    .gs-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 3px 10px;
      font-size: 12px;
      cursor: default;
      white-space: nowrap;
    }
    .gs-chip-input {
      background: none;
      border: none;
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
      width: 80px;
    }
    .gs-clear-filters {
      background: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
      transition: .12s;
    }
    .gs-clear-filters:hover { background: var(--bg-hover); color: var(--text-primary); }
    .gs-load-more {
      display: block;
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 12px;
      margin-top: 8px;
      padding: 8px 0;
      text-align: center;
      transition: .12s;
    }
    .gs-load-more:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* â”€â”€ Slow Mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    .slow-mode-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(255, 165, 0, 0.12);
      border: 1px solid rgba(255, 165, 0, 0.25);
      border-radius: 12px;
      color: #ffa500;
      font-size: 11px;
      font-weight: 600;
      margin-left: 8px;
      padding: 2px 8px;
      vertical-align: middle;
    }

    /* â”€â”€ Audit Log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    .audit-modal {
      max-width: 640px;
      width: 95%;
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      padding: 0;
      overflow: hidden;
    }
    .modal-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .modal-header h3 { margin: 0; font-size: 16px; flex: 1; }
    .audit-filters { display: flex; gap: 8px; flex: 1; justify-content: flex-end; }
    .audit-filters select,
    .audit-search {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 12px;
      padding: 4px 8px;
    }
    .audit-search { width: 130px; }
    .audit-body { flex: 1; overflow-y: auto; padding: 8px 0; }
    .audit-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-top: 1px solid var(--border);
    }
    .audit-entry {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 16px;
      transition: background .1s;
    }
    .audit-entry:hover { background: var(--bg-hover); }
    .audit-icon {
      font-size: 18px;
      flex-shrink: 0;
      width: 28px;
      text-align: center;
    }
    .audit-content { flex: 1; min-width: 0; }
    .audit-main { font-size: 13px; line-height: 1.5; }
    .audit-actor { color: var(--text-primary); }
    .audit-action-label { color: var(--text-muted); margin: 0 4px; }
    .audit-target { color: var(--brand); }
    .audit-detail { color: var(--text-muted); font-size: 12px; }
    .audit-time { color: var(--text-muted); font-size: 11px; margin-top: 2px; }

    /* â”€â”€ Boost â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
    .boost-card { text-align: center; }
    .boost-header { padding: 20px 0 12px; }
    .boost-tier-badge {
      display: inline-block;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .5px;
      margin: 0 auto 16px;
      padding: 4px 14px;
      text-transform: uppercase;
    }
    .tier-0 { background: rgba(153,170,181,.15); color: #99aab5; }
    .tier-1 { background: rgba(163,125,255,.15); color: #a37dff; }
    .tier-2 { background: rgba(255,115,197,.15); color: #ff73c5; }
    .tier-3 { background: linear-gradient(90deg,rgba(163,125,255,.25),rgba(255,115,197,.25)); color: #fff; }
    .boost-progress-wrap { padding: 0 24px 16px; text-align: left; }
    .boost-progress-bar {
      background: var(--bg-secondary);
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
    }
    .boost-progress-fill {
      background: linear-gradient(90deg, #a37dff, #ff73c5);
      border-radius: 4px;
      height: 100%;
      transition: width .5s ease;
    }
    .boost-perks {
      background: var(--bg-secondary);
      border-radius: 10px;
      margin: 0 0 16px;
      padding: 14px 16px;
      text-align: left;
    }
    .boost-perk-item {
      font-size: 13px;
      padding: 4px 0;
    }
    .boost-perk-item.locked { color: var(--text-muted); }
    .boost-btn { width: 100%; justify-content: center; margin-bottom: 4px; }
    .boost-boosters-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 160px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .boost-booster-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
  `;
  document.head.appendChild(style);
})();

console.log('[Bridge] Features yÃ¼klendi:', [
  'Per-User Voice Volume', 'Advanced Search (from/before/after/has)', 'Slow Mode UI',
  'Audit Log', 'Server Boost UI',
].join(', '));

