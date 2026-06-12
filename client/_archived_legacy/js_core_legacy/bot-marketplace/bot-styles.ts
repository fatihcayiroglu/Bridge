// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BotStylesPanel.svelte
//              client/js/core/bot-styles-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/bot-styles.ts
export function injectStyles(): void {
  if (document.getElementById('mp-styles')) return;
  const s = document.createElement('style');
  s.id = 'mp-styles';
  // Full CSS inlined — see original bot-marketplace.js for the complete stylesheet
  s.textContent = `
    #bot-marketplace-modal{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);z-index:var(--z-modal,300);display:flex;align-items:center;justify-content:center;padding:20px}
    .mp-panel{background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--r-xl);width:min(960px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:var(--shadow-xl);overflow:hidden;animation:mpIn .24s cubic-bezier(.34,1.56,.64,1)}
    @keyframes mpIn{from{opacity:0;transform:scale(.94) translateY(20px)}to{opacity:1;transform:none}}
    .mp-header{padding:24px 28px 0;flex-shrink:0;background:var(--bg-3);border-bottom:1px solid var(--border)}
    .mp-header-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;gap:12px}
    .mp-title{font-size:22px;font-weight:800;color:var(--text-primary);letter-spacing:-.02em;margin-bottom:3px}
    .mp-subtitle{color:var(--text-muted);font-size:13px;display:flex;align-items:center;gap:8px}
    .mp-badge{background:var(--brand-bg);border:1px solid var(--brand-border);color:var(--brand);border-radius:var(--r-full);padding:1px 8px;font-size:11px;font-weight:700}
    .mp-close{background:var(--bg-4);border:none;width:32px;height:32px;border-radius:50%;color:var(--text-muted);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;flex-shrink:0}
    .mp-close:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-controls{display:flex;gap:8px;margin-bottom:16px}
    .mp-search{flex:1;background:var(--bg-4);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:9px 14px;color:var(--text-primary);font-size:14px;outline:none;transition:.15s}
    .mp-search:focus{border-color:var(--brand)}.mp-search::placeholder{color:var(--text-muted)}
    .mp-sort{background:var(--bg-4);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:9px 12px;color:var(--text-2);font-size:13px;outline:none;cursor:pointer}
    .mp-tabs{display:flex;gap:2px}
    .mp-tab{padding:10px 18px;border:none;background:transparent;color:var(--text-muted);font-weight:600;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:.15s;white-space:nowrap}
    .mp-tab.active{color:var(--brand);border-bottom-color:var(--brand)}.mp-tab:hover:not(.active){color:var(--text-primary)}
    .mp-body{display:flex;flex:1;overflow:hidden}
    .mp-sidebar{width:175px;flex-shrink:0;background:var(--bg-3);border-right:1px solid var(--border);padding:12px 8px;overflow-y:auto}
    .mp-sidebar-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);padding:8px 8px 6px}
    .mp-cat{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;border:none;background:none;color:var(--text-2);font-size:13px;font-weight:500;cursor:pointer;border-radius:var(--r-md);transition:.12s;text-align:left}
    .mp-cat:hover{background:var(--bg-4);color:var(--text-primary)}.mp-cat.active{background:var(--brand-bg);color:var(--brand);font-weight:700}
    .mp-cat .cc{margin-left:auto;font-size:11px;color:var(--text-muted)}.mp-cat.active .cc{color:var(--brand)}
    .mp-grid-wrap{flex:1;overflow-y:auto;padding:16px 20px}
    .mp-feat-banner{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    .mp-feat-card{background:linear-gradient(135deg,var(--brand-bg),var(--bg-3));border:1px solid var(--brand-border);border-radius:var(--r-lg);padding:16px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;gap:8px}
    .mp-feat-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md),0 0 0 1px var(--brand)}
    .mp-feat-top{display:flex;align-items:center;gap:10px}
    .mp-feat-av{width:40px;height:40px;border-radius:var(--r-md);background:var(--bg-5);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
    .mp-feat-name{font-weight:700;font-size:14px;color:var(--text-primary)}.mp-feat-meta{font-size:11px;color:var(--text-muted)}
    .mp-feat-desc{font-size:12px;color:var(--text-2);line-height:1.5}
    .mp-sec-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:10px;display:flex;align-items:center;gap:8px}
    .mp-sec-lbl::after{content:'';flex:1;height:1px;background:var(--border)}
    .mp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
    .mp-card{background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px;display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:.15s}
    .mp-card:hover{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand-border),var(--shadow-sm);transform:translateY(-1px)}
    .mp-card.installed{border-color:rgba(46,204,154,.4)}
    .mp-card-top{display:flex;align-items:flex-start;gap:12px}
    .mp-card-av{width:44px;height:44px;border-radius:var(--r-md);background:var(--bg-4);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
    .mp-card-info{flex:1;min-width:0}
    .mp-card-nr{display:flex;align-items:center;gap:5px;margin-bottom:2px}
    .mp-card-name{font-weight:700;font-size:14px;color:var(--text-primary)}
    .mp-verified{color:var(--brand);font-size:13px}
    .mp-card-meta{font-size:11px;color:var(--text-muted)}
    .mp-card-desc{font-size:12px;color:var(--text-2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .mp-card-tags{display:flex;flex-wrap:wrap;gap:4px}
    .mp-tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:var(--r-full);text-transform:uppercase;letter-spacing:.04em}
    .mp-rating{display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap}
    .mp-stars{color:#faa61a;font-size:11px}
    .mp-rating-n{font-weight:700;color:var(--text-primary)}.mp-rating-c{color:var(--text-muted)}
    .mp-card-foot{display:flex;gap:6px;margin-top:auto}
    .mp-btn-detail{flex:1;padding:8px;background:var(--bg-4);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;transition:.15s}
    .mp-btn-detail:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-btn-inst{flex:2;padding:8px;border:none;border-radius:var(--r-md);font-size:12px;font-weight:700;cursor:pointer;transition:.15s}
    .mp-btn-inst.add{background:var(--brand);color:#fff}.mp-btn-inst.add:hover{background:var(--brand-hover)}
    .mp-btn-inst.rem{background:rgba(46,204,154,.12);color:var(--teal);border:1px solid rgba(46,204,154,.3)}
    .mp-btn-inst.rem:hover{background:rgba(224,82,96,.12);color:var(--red);border-color:rgba(224,82,96,.3)}
    .mp-btn-inst:disabled{opacity:.5;cursor:not-allowed}
    .mp-empty{grid-column:1/-1;text-align:center;padding:48px 20px;color:var(--text-muted)}
    .mp-empty-icon{font-size:40px;opacity:.4;margin-bottom:12px}
    .mp-empty-t{font-size:15px;font-weight:600;color:var(--text-2);margin-bottom:6px}
    #mp-detail-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:350;display:flex;align-items:center;justify-content:center;padding:20px;animation:mpFi .15s ease}
    @keyframes mpFi{from{opacity:0}}
    .mp-det-panel{background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--r-xl);width:min(680px,100%);max-height:88vh;overflow-y:auto;box-shadow:var(--shadow-xl);animation:mpIn .22s cubic-bezier(.34,1.56,.64,1)}
    .mp-det-hero{padding:28px;display:flex;gap:18px;align-items:flex-start;background:linear-gradient(135deg,var(--brand-bg) 0%,var(--bg-3) 100%);border-bottom:1px solid var(--border)}
    .mp-det-av{width:72px;height:72px;border-radius:var(--r-lg);background:var(--bg-4);display:flex;align-items:center;justify-content:center;font-size:40px;flex-shrink:0;box-shadow:var(--shadow-md)}
    .mp-det-name{font-size:24px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px;color:var(--text-primary)}
    .mp-det-author{font-size:13px;color:var(--text-muted);margin-bottom:10px}
    .mp-det-stats{display:flex;gap:20px;font-size:13px}
    .mp-det-stat{text-align:center}
    .mp-det-stat-v{font-weight:800;font-size:18px;color:var(--text-primary);display:block}
    .mp-det-stat-l{color:var(--text-muted);font-size:11px}
    .mp-det-body{padding:24px 28px}
    .mp-det-sec{margin-bottom:20px}
    .mp-det-sec-t{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:10px}
    .mp-det-desc{font-size:14px;color:var(--text-2);line-height:1.7;white-space:pre-line}
    .mp-det-desc strong{color:var(--text-primary)}
    .mp-cmds{display:flex;flex-wrap:wrap;gap:6px}
    .mp-cmd{background:var(--bg-4);color:var(--brand);font-family:var(--font-mono);font-size:12px;padding:4px 10px;border-radius:var(--r-md);border:1px solid var(--brand-border)}
    .mp-perms{display:flex;flex-wrap:wrap;gap:6px}
    .mp-perm{background:rgba(224,82,96,.10);color:var(--red);font-size:12px;font-weight:600;padding:4px 10px;border-radius:var(--r-full);border:1px solid rgba(224,82,96,.25)}
    .mp-links{display:flex;gap:8px;flex-wrap:wrap}
    .mp-link{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;background:var(--bg-4);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text-2);font-size:12px;font-weight:600;text-decoration:none;transition:.15s}
    .mp-link:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-det-foot{padding:20px 28px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center;background:var(--bg-3)}
    .mp-inst-big{flex:1;padding:12px;border:none;border-radius:var(--r-lg);font-size:15px;font-weight:700;cursor:pointer;transition:.15s}
    .mp-inst-big.add{background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;box-shadow:var(--shadow-brand)}
    .mp-inst-big.add:hover{transform:translateY(-1px)}
    .mp-inst-big.rem{background:rgba(46,204,154,.12);color:var(--teal);border:1.5px solid rgba(46,204,154,.4)}
    .mp-inst-big.rem:hover{background:rgba(224,82,96,.12);color:var(--red);border-color:rgba(224,82,96,.4)}
    .mp-det-cls{padding:12px 20px;background:var(--bg-4);border:1px solid var(--border);border-radius:var(--r-lg);color:var(--text-2);font-size:14px;font-weight:600;cursor:pointer;transition:.15s}
    .mp-det-cls:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-toast{position:fixed;bottom:24px;right:24px;z-index:9999;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-md);padding:12px 18px;font-size:14px;font-weight:600;color:var(--text-primary);box-shadow:var(--shadow-lg);max-width:340px;animation:mpFi .2s ease;transition:opacity .2s,transform .2s}
    .mp-toast.hide{opacity:0;transform:translateY(8px)}
    .mp-toast.success{border-left:4px solid var(--teal)}.mp-toast.error{border-left:4px solid var(--red)}.mp-toast.info{border-left:4px solid var(--brand)}
    @media(max-width:640px){.mp-sidebar{display:none}.mp-feat-banner{grid-template-columns:1fr}}`;
  document.head.appendChild(s);
}
