// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DiscordImportStylesPanel.svelte
//              client/js/core/discord-import-styles-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/discord-import-styles.ts
// Discord Import Sihirbazı — CSS enjeksiyonu
// discord-import.ts tarafından import edilir.

export function injectImportStyles(): void {
  if (document.getElementById('di-styles')) return;
  const s = document.createElement('style');
  s.id = 'di-styles';
  s.textContent = `
    #di-modal {
      position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(5px);
      z-index:var(--z-modal,300);display:flex;align-items:center;justify-content:center;padding:20px;
    }
    .di-panel {
      background:var(--bg-2);border:1px solid var(--border-strong);
      border-radius:var(--r-xl);width:min(720px,100%);max-height:92vh;
      display:flex;flex-direction:column;box-shadow:var(--shadow-xl);overflow:hidden;
      animation:diIn .25s cubic-bezier(.34,1.56,.64,1);
    }
    @keyframes diIn{from{opacity:0;transform:scale(.93) translateY(24px)}to{opacity:1;transform:none}}

    /* Header */
    .di-header {
      padding:24px 28px 20px;background:var(--bg-3);border-bottom:1px solid var(--border);flex-shrink:0;
    }
    .di-header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
    .di-title{font-size:20px;font-weight:800;letter-spacing:-.02em;color:var(--text-primary)}
    .di-subtitle{font-size:13px;color:var(--text-muted);margin-top:3px}
    .di-close{background:var(--bg-4);border:none;width:32px;height:32px;border-radius:50%;color:var(--text-muted);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s}
    .di-close:hover{background:var(--bg-5);color:var(--text-primary)}

    /* Steps */
    .di-steps{display:flex;gap:0;align-items:center}
    .di-step{display:flex;align-items:center;gap:8px;flex:1}
    .di-step-num{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;flex-shrink:0;transition:.25s}
    .di-step.done .di-step-num{background:var(--teal);color:#fff}
    .di-step.active .di-step-num{background:var(--brand);color:#fff;box-shadow:0 0 0 4px var(--brand-subtle)}
    .di-step.pending .di-step-num{background:var(--bg-5);color:var(--text-muted)}
    .di-step-label{font-size:12px;font-weight:600;transition:.25s}
    .di-step.active .di-step-label{color:var(--brand)}
    .di-step.done .di-step-label{color:var(--teal)}
    .di-step.pending .di-step-label{color:var(--text-muted)}
    .di-step-line{flex:1;height:2px;background:var(--border);margin:0 8px;transition:.25s}
    .di-step.done + .di-step .di-step-line,.di-step.done .di-step-line{background:var(--teal)}

    /* Body */
    .di-body{flex:1;overflow-y:auto;padding:28px}

    /* Method selector */
    .di-method-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px}
    .di-method-card{
      background:var(--bg-3);border:2px solid var(--border);border-radius:var(--r-lg);
      padding:20px;cursor:pointer;transition:.18s;text-align:left;
    }
    .di-method-card:hover{border-color:var(--brand);background:var(--brand-bg)}
    .di-method-card.selected{border-color:var(--brand);background:var(--brand-bg);box-shadow:0 0 0 1px var(--brand)}
    .di-method-icon{font-size:28px;margin-bottom:10px}
    .di-method-title{font-weight:700;font-size:15px;color:var(--text-primary);margin-bottom:4px}
    .di-method-desc{font-size:12px;color:var(--text-2);line-height:1.5}
    .di-method-badge{display:inline-block;margin-top:8px;font-size:10px;font-weight:700;padding:2px 8px;border-radius:var(--r-full)}
    .badge-recommended{background:rgba(46,204,154,.15);color:var(--teal);border:1px solid rgba(46,204,154,.3)}
    .badge-fast{background:rgba(245,166,35,.15);color:var(--accent,#f5a623);border:1px solid rgba(245,166,35,.3)}

    /* Script box */
    .di-script-box{
      background:var(--bg-0,#0f1117);border:1px solid var(--border);border-radius:var(--r-md);
      padding:16px;font-family:var(--font-mono);font-size:12px;color:#c9d1d9;
      line-height:1.7;overflow-x:auto;position:relative;margin:12px 0;
    }
    .di-copy-btn{
      position:absolute;top:10px;right:10px;background:var(--bg-4);border:1px solid var(--border);
      border-radius:var(--r-sm);padding:4px 10px;font-size:11px;font-weight:600;
      color:var(--text-2);cursor:pointer;font-family:var(--font-sans);transition:.15s;
    }
    .di-copy-btn:hover{background:var(--bg-5);color:var(--text-primary)}
    .di-copy-btn.copied{background:rgba(46,204,154,.15);color:var(--teal);border-color:rgba(46,204,154,.3)}

    /* JSON textarea */
    .di-json-area{
      width:100%;min-height:160px;background:var(--bg-0,#0f1117);
      border:1.5px solid var(--border);border-radius:var(--r-md);
      padding:14px;font-family:var(--font-mono);font-size:12px;
      color:var(--text-primary);resize:vertical;outline:none;transition:.15s;
      line-height:1.6;
    }
    .di-json-area:focus{border-color:var(--brand)}
    .di-json-area.error{border-color:var(--red)}
    .di-json-area.ok{border-color:var(--teal)}

    /* Parse result preview */
    .di-preview{
      background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-lg);
      padding:16px;margin-top:14px;
    }
    .di-preview-title{font-size:13px;font-weight:700;color:var(--text-primary);margin-bottom:10px;display:flex;align-items:center;gap:7px}
    .di-preview-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .di-preview-stat{text-align:center;background:var(--bg-4);border-radius:var(--r-md);padding:10px}
    .di-preview-val{font-size:20px;font-weight:800;color:var(--brand)}
    .di-preview-lbl{font-size:11px;color:var(--text-muted);margin-top:2px}
    .di-preview-cats{margin-top:12px;display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto}
    .di-preview-cat{font-size:12px;font-weight:700;color:var(--text-muted);padding:6px 10px;background:var(--bg-4);border-radius:var(--r-sm)}

    /* Footer */
    .di-footer{padding:16px 28px;border-top:1px solid var(--border);background:var(--bg-3);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0}
    .di-btn{padding:9px 20px;border-radius:var(--r-md);font-size:14px;font-weight:600;cursor:pointer;border:none;transition:.15s}
    .di-btn-ghost{background:var(--bg-4);color:var(--text-2)}
    .di-btn-ghost:hover{background:var(--bg-5);color:var(--text-primary)}
    .di-btn-primary{background:var(--brand);color:#fff}
    .di-btn-primary:hover{filter:brightness(1.08)}
    .di-btn-primary:disabled{opacity:.5;cursor:not-allowed}
    .di-btn-success{background:var(--teal);color:#fff}

    /* Status / progress */
    .di-progress{margin-top:16px}
    .di-progress-bar-wrap{height:6px;background:var(--bg-4);border-radius:3px;overflow:hidden;margin-top:8px}
    .di-progress-bar{height:100%;background:var(--brand);border-radius:3px;transition:width .3s}
    .di-log{margin-top:14px;max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:5px}
    .di-log-line{font-size:12px;padding:5px 10px;border-radius:var(--r-sm);display:flex;align-items:center;gap:8px}
    .di-log-line.ok{background:rgba(46,204,154,.08);color:var(--teal)}
    .di-log-line.err{background:rgba(237,66,69,.08);color:var(--red)}
    .di-log-line.info{background:var(--bg-3);color:var(--text-2)}
    .di-log-line.loading{background:var(--bg-3);color:var(--text-2)}

    /* Success screen */
    .di-success{text-align:center;padding:24px 0}
    .di-success-icon{font-size:56px;margin-bottom:16px}
    .di-success-title{font-size:22px;font-weight:800;color:var(--text-primary);margin-bottom:8px}
    .di-success-desc{font-size:14px;color:var(--text-2);line-height:1.6;max-width:380px;margin:0 auto 20px}
    .di-success-stats{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
    .di-success-stat{background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-lg);padding:12px 20px;text-align:center}
    .di-success-stat-val{font-size:22px;font-weight:800;color:var(--brand)}
    .di-success-stat-lbl{font-size:11px;color:var(--text-muted);margin-top:2px}

    /* Manual builder */
    .di-manual-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
    .di-manual-title{font-size:15px;font-weight:700;color:var(--text-primary)}
    .di-cats-list{display:flex;flex-direction:column;gap:10px;max-height:380px;overflow-y:auto;padding-right:4px}
    .di-cat-row{background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden}
    .di-cat-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)}
    .di-cat-name{flex:1;background:transparent;border:none;outline:none;font-size:14px;font-weight:600;color:var(--text-primary);font-family:var(--font-sans)}
    .di-cat-name::placeholder{color:var(--text-muted)}
    .di-cat-del{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:15px;padding:2px 4px;border-radius:var(--r-sm)}
    .di-cat-del:hover{background:rgba(237,66,69,.15);color:var(--red)}
    .di-channels-list{padding:8px 14px;display:flex;flex-direction:column;gap:6px}
    .di-ch-row{display:flex;align-items:center;gap:8px}
    .di-ch-icon{font-size:14px;color:var(--text-muted)}
    .di-ch-name{flex:1;background:transparent;border:none;outline:none;font-size:13px;color:var(--text-primary);font-family:var(--font-sans);border-bottom:1px solid transparent;transition:.15s;padding:2px 0}
    .di-ch-name:focus{border-color:var(--border-strong)}
    .di-ch-name::placeholder{color:var(--text-muted)}
    .di-ch-type{font-size:11px;font-weight:600;color:var(--text-muted);background:var(--bg-4);padding:2px 8px;border-radius:var(--r-full);cursor:pointer;border:none;font-family:var(--font-sans)}
    .di-ch-type:hover{background:var(--bg-5)}
    .di-ch-del{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:var(--r-sm)}
    .di-ch-del:hover{color:var(--red)}
    .di-add-ch{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer;padding:4px 0;background:none;border:none;font-family:var(--font-sans);transition:.15s}
    .di-add-ch:hover{color:var(--brand)}
  `;
  document.head.appendChild(s);
}
