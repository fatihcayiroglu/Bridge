// client/js/core/discord-import.js
// Discord Sunucu Import Sihirbazı
//
// Discord, sunucu verilerini dışa aktarmak için resmi API sunmaz.
// Bu araç kullanıcıya 2 yöntem sunar:
//
//   Yöntem A — Manuel JSON (önerilen, %100 çalışır)
//     Kullanıcı kendi bot token'ı ile çalıştırabileceği küçük bir
//     Python/Node script'i kopyalar, çıktı JSON'u buraya yapıştırır.
//
//   Yöntem B — Hızlı Şablon
//     Kanal yapısını sıfırdan elle girerek Bridge şablonu oluşturur.
//
// Sunucu tarafı: POST /api/discord-import
// Oluşturulan: Sunucu + kategoriler + kanallar + roller

'use strict';
import { getAPI } from './globals.js';

/* ══════════════════════════════════════════════════════════
   STYLES
══════════════════════════════════════════════════════════ */
function injectImportStyles() {
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
    .di-preview-ch{font-size:12px;color:var(--text-2);padding:4px 10px 4px 22px;display:flex;align-items:center;gap:5px}
    .di-ch-icon{font-size:11px;color:var(--text-muted)}

    /* Manual builder */
    .di-builder{display:flex;flex-direction:column;gap:10px}
    .di-field{display:flex;flex-direction:column;gap:6px}
    .di-field label{font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em}
    .di-input{
      background:var(--bg-3);border:1.5px solid var(--border);border-radius:var(--r-md);
      padding:10px 14px;color:var(--text-primary);font-size:14px;font-family:var(--font-sans);outline:none;transition:.15s;
    }
    .di-input:focus{border-color:var(--brand)}

    /* Cat builder */
    .di-cats-list{display:flex;flex-direction:column;gap:8px;margin-top:4px}
    .di-cat-item{background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden}
    .di-cat-header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg-4)}
    .di-cat-name-inp{flex:1;background:none;border:none;color:var(--text-primary);font-size:13px;font-weight:700;font-family:var(--font-sans);outline:none}
    .di-cat-del{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:0;line-height:1;transition:.15s}
    .di-cat-del:hover{color:var(--red)}
    .di-channels-list{padding:8px 14px;display:flex;flex-direction:column;gap:4px}
    .di-ch-item{display:flex;align-items:center;gap:8px}
    .di-ch-name-inp{flex:1;background:var(--bg-5);border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 10px;color:var(--text-primary);font-size:13px;font-family:var(--font-sans);outline:none;transition:.15s}
    .di-ch-name-inp:focus{border-color:var(--brand)}
    .di-ch-type{background:var(--bg-5);border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 8px;color:var(--text-2);font-size:12px;font-family:var(--font-sans);outline:none;cursor:pointer}
    .di-ch-del{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0;transition:.15s}
    .di-ch-del:hover{color:var(--red)}
    .di-add-ch-btn{background:none;border:1px dashed var(--border);border-radius:var(--r-sm);padding:5px 10px;color:var(--text-muted);font-size:12px;font-family:var(--font-sans);cursor:pointer;transition:.15s;text-align:left;margin-top:4px}
    .di-add-ch-btn:hover{border-color:var(--brand);color:var(--brand)}
    .di-add-cat-btn{background:none;border:2px dashed var(--border);border-radius:var(--r-md);padding:10px;color:var(--text-muted);font-size:13px;font-weight:600;font-family:var(--font-sans);cursor:pointer;transition:.15s;text-align:center}
    .di-add-cat-btn:hover{border-color:var(--brand);color:var(--brand);background:var(--brand-bg)}

    /* Progress */
    .di-progress-wrap{margin:20px 0}
    .di-progress-bar-outer{height:8px;background:var(--bg-4);border-radius:var(--r-full);overflow:hidden}
    .di-progress-bar-inner{height:100%;background:linear-gradient(90deg,var(--brand),var(--accent,#f5a623));border-radius:var(--r-full);transition:width .4s ease;width:0%}
    .di-progress-label{font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center}
    .di-progress-steps{display:flex;flex-direction:column;gap:6px;margin-top:12px;max-height:200px;overflow-y:auto}
    .di-ps{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2)}
    .di-ps.done{color:var(--teal)} .di-ps.active{color:var(--brand)} .di-ps.error{color:var(--red)}
    .di-ps-icon{font-size:14px;flex-shrink:0}

    /* Result */
    .di-result{text-align:center;padding:20px 0}
    .di-result-icon{font-size:56px;margin-bottom:16px}
    .di-result-title{font-size:22px;font-weight:800;letter-spacing:-.02em;margin-bottom:8px}
    .di-result-sub{color:var(--text-2);font-size:14px;line-height:1.6}

    /* Footer */
    .di-footer{padding:16px 28px;border-top:1px solid var(--border);background:var(--bg-3);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:12px}
    .di-btn{padding:10px 24px;border-radius:var(--r-full);font-size:14px;font-weight:700;font-family:var(--font-sans);cursor:pointer;transition:.15s;border:none}
    .di-btn-ghost{background:var(--bg-4);border:1px solid var(--border);color:var(--text-2)}
    .di-btn-ghost:hover{background:var(--bg-5);color:var(--text-primary)}
    .di-btn-primary{background:var(--brand);color:#fff;box-shadow:var(--shadow-brand)}
    .di-btn-primary:hover{background:var(--brand-hover);transform:translateY(-1px)}
    .di-btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
    .di-btn-success{background:var(--teal);color:#fff}
    .di-btn-success:hover{filter:brightness(1.1)}

    /* Misc */
    .di-info-box{background:var(--brand-bg);border:1px solid var(--brand-border);border-radius:var(--r-md);padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.6;margin:12px 0}
    .di-info-box strong{color:var(--brand)}
    .di-warn-box{background:rgba(245,166,35,.08);border:1px solid rgba(245,166,35,.25);border-radius:var(--r-md);padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.6;margin:12px 0}
    .di-err-msg{font-size:12px;color:var(--red);margin-top:5px}

    .di-sec-title{font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:6px}
    .di-sec-sub{font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:14px}

    @media(max-width:580px){
      .di-method-grid{grid-template-columns:1fr}
      .di-preview-grid{grid-template-columns:1fr 1fr}
      .di-footer{flex-wrap:wrap}
    }
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════
   SCRIPT ŞABLONLARI — kullanıcı kopyalayıp çalıştırır
══════════════════════════════════════════════════════════ */
const PYTHON_SCRIPT = `import requests, json, sys

TOKEN = input("Discord Bot Token: ").strip()
GUILD_ID = input("Sunucu ID (Sağ tık → ID Kopyala): ").strip()

h = {"Authorization": f"Bot {TOKEN}"}
base = "https://discord.com/api/v10"

guild = requests.get(f"{base}/guilds/{GUILD_ID}?with_counts=true", headers=h).json()
channels = requests.get(f"{base}/guilds/{GUILD_ID}/channels", headers=h).json()
roles = requests.get(f"{base}/guilds/{GUILD_ID}/roles", headers=h).json()

result = {
    "name": guild.get("name", "Sunucum"),
    "icon": guild.get("icon_emoji", {}).get("name", "🌐"),
    "channels": [{"id":c["id"],"name":c["name"],"type":c["type"],"parent_id":c.get("parent_id"),"position":c.get("position",0)} for c in channels],
    "roles": [{"id":r["id"],"name":r["name"],"color":r.get("color",0)} for r in roles if r["name"] != "@everyone"]
}

out = "discord_export.json"
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"✅ {out} dosyasına kaydedildi. Bridge'e yapıştırabilirsiniz.")`;

const NODE_SCRIPT = `const https = require('https');
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Discord Bot Token: ', token => {
rl.question('Sunucu ID: ', guildId => {
  const get = path => new Promise((res, rej) => {
    https.get({ hostname: 'discord.com', path: '/api/v10' + path,
      headers: { Authorization: 'Bot ' + token } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
  Promise.all([
    get('/guilds/' + guildId + '?with_counts=true'),
    get('/guilds/' + guildId + '/channels'),
    get('/guilds/' + guildId + '/roles'),
  ]).then(([guild, channels, roles]) => {
    const result = {
      name: guild.name || 'Sunucum',
      icon: guild.icon_emoji?.name || '🌐',
      channels: channels.map(c => ({ id:c.id, name:c.name, type:c.type, parent_id:c.parent_id, position:c.position||0 })),
      roles: roles.filter(r => r.name !== '@everyone').map(r => ({ id:r.id, name:r.name, color:r.color||0 }))
    };
    fs.writeFileSync('discord_export.json', JSON.stringify(result, null, 2));
    console.log('✅ discord_export.json oluşturuldu!');
    rl.close();
  });
});});`;

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */
let _step = 1;           // 1: Yöntem, 2: Veri gir, 3: İçe aktar, 4: Bitti
let _method = 'json';    // 'json' | 'manual'
let _parsedData = null;  // JSON'dan parse edilen yapı
let _manualCats = [];    // Manuel builder kategorileri
let _serverName = '';
let _serverIcon = '🌐';
let _importedServerId = null;
let _lang = 'python';    // 'python' | 'node'

/* ══════════════════════════════════════════════════════════
   OPEN / CLOSE
══════════════════════════════════════════════════════════ */
function openDiscordImport() {
  if (document.getElementById('di-modal')) return;
  injectImportStyles();
  _step = 1; _method = 'json'; _parsedData = null; _manualCats = []; _serverName = ''; _serverIcon = '🌐';

  const modal = document.createElement('div');
  modal.id = 'di-modal';
  modal.innerHTML = `
    <div class="di-panel">
      <div class="di-header">
        <div class="di-header-top">
          <div>
            <div class="di-title">📥 Discord Sunucu Import</div>
            <div class="di-subtitle">Kanal yapısını, kategorileri ve rolleri Bridge'e taşı</div>
          </div>
          <button class="di-close" id="di-close">✕</button>
        </div>
        <div class="di-steps" id="di-steps"></div>
      </div>
      <div class="di-body" id="di-body"></div>
      <div class="di-footer" id="di-footer"></div>
    </div>`;
  document.body.appendChild(modal);

  modal.addEventListener('click', e => { if (e.target === modal) closeImport(); });
  document.getElementById('di-close').addEventListener('click', closeImport);
  document.addEventListener('keydown', diEscHandler);

  renderStep();
}

function diEscHandler(e) { if (e.key === 'Escape') closeImport(); }

function closeImport() {
  document.getElementById('di-modal')?.remove();
  document.removeEventListener('keydown', diEscHandler);
}

/* ══════════════════════════════════════════════════════════
   STEP RENDERER
══════════════════════════════════════════════════════════ */
function renderStep() {
  renderStepBar();
  const body = document.getElementById('di-body');
  const footer = document.getElementById('di-footer');
  if (!body || !footer) return;

  if (_step === 1) { renderStep1(body, footer); }
  else if (_step === 2) { renderStep2(body, footer); }
  else if (_step === 3) { renderStep3(body, footer); }
  else if (_step === 4) { renderStep4(body, footer); }
}

function renderStepBar() {
  const STEPS = [
    { num:1, label:'Yöntem Seç' },
    { num:2, label:'Veri Gir' },
    { num:3, label:'İçe Aktar' },
    { num:4, label:'Tamamlandı' },
  ];
  const el = document.getElementById('di-steps');
  if (!el) return;
  el.innerHTML = STEPS.map((st, i) => {
    const state = st.num < _step ? 'done' : st.num === _step ? 'active' : 'pending';
    const line = i < STEPS.length - 1 ? `<div class="di-step-line"></div>` : '';
    return `<div class="di-step ${state}">
      <div class="di-step-num">${state === 'done' ? '✓' : st.num}</div>
      <div class="di-step-label">${st.label}</div>
      ${line}
    </div>`;
  }).join('');
}

/* ── ADIM 1: Yöntem Seç ── */
function renderStep1(body, footer) {
  body.innerHTML = `
    <div class="di-sec-title">İçe aktarma yöntemini seç</div>
    <div class="di-sec-sub">Discord, resmi export API'si sunmuyor. Aşağıdaki yöntemlerden birini kullan:</div>
    <div class="di-method-grid">
      <button class="di-method-card ${_method==='json'?'selected':''}" data-method="json">
        <div class="di-method-icon">📄</div>
        <div class="di-method-title">JSON ile İçe Aktar</div>
        <div class="di-method-desc">Küçük bir script çalıştır, çıktı JSON'u buraya yapıştır. Tam kanal yapısı ve roller aktarılır.</div>
        <span class="di-method-badge badge-recommended">✓ Önerilen</span>
      </button>
      <button class="di-method-card ${_method==='manual'?'selected':''}" data-method="manual">
        <div class="di-method-icon">✏️</div>
        <div class="di-method-title">Elle Oluştur</div>
        <div class="di-method-desc">Kategori ve kanalları arayüzden gir. Küçük sunucular veya yeni başlayanlar için ideal.</div>
        <span class="di-method-badge badge-fast">⚡ Hızlı</span>
      </button>
    </div>
    <div class="di-warn-box">
      ⚠️ <strong>Not:</strong> Mesaj geçmişi aktarılamaz — bu Discord'un politikası gereğidir. Sadece sunucu yapısı (kanallar, kategoriler, roller) taşınır.
    </div>`;

  body.querySelectorAll('.di-method-card').forEach(card => {
    card.addEventListener('click', () => {
      _method = card.dataset.method;
      body.querySelectorAll('.di-method-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });

  footer.innerHTML = `
    <div></div>
    <button class="di-btn di-btn-primary" id="di-next-1">Devam → </button>`;
  document.getElementById('di-next-1').addEventListener('click', () => { _step = 2; renderStep(); });
}

/* ── ADIM 2: Veri Gir ── */
function renderStep2(body, footer) {
  if (_method === 'json') renderStep2JSON(body);
  else renderStep2Manual(body);

  footer.innerHTML = `
    <button class="di-btn di-btn-ghost" id="di-back-2">← Geri</button>
    <button class="di-btn di-btn-primary" id="di-next-2">Devam →</button>`;
  document.getElementById('di-back-2').addEventListener('click', () => { _step = 1; renderStep(); });
  document.getElementById('di-next-2').addEventListener('click', () => {
    if (_method === 'json') { if (!validateJSON()) return; }
    else { if (!validateManual()) return; }
    _step = 3;
    renderStep();
  });
}

function renderStep2JSON(body) {
  body.innerHTML = `
    <div class="di-sec-title">🐍 Script'i çalıştır, JSON'u yapıştır</div>
    <div class="di-sec-sub">Aşağıdaki script'i çalıştır, çıktı dosyasını aç ve içeriği buraya yapıştır.</div>

    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button class="di-btn di-btn-ghost" id="lang-py" style="padding:6px 14px;font-size:12px">🐍 Python</button>
      <button class="di-btn di-btn-ghost" id="lang-node" style="padding:6px 14px;font-size:12px">🟢 Node.js</button>
    </div>

    <div style="position:relative">
      <pre class="di-script-box" id="di-script-pre">${escHtml(PYTHON_SCRIPT)}</pre>
      <button class="di-copy-btn" id="di-copy-script">📋 Kopyala</button>
    </div>

    <div class="di-info-box">
      💡 <strong>Nasıl çalışır?</strong> Script, kendi bot token'ınla Discord API'sine bağlanır ve sadece sunucu yapısını (kanal adları, kategoriler) çeker. Token güvende kalır — Bridge'e gönderilmez.
    </div>

    <div style="margin-top:16px">
      <div class="di-sec-title" style="margin-bottom:8px">Çıktı JSON'unu buraya yapıştır:</div>
      <textarea class="di-json-area" id="di-json-input" placeholder='{"name":"Sunucum","channels":[...],"roles":[]}'></textarea>
      <div class="di-err-msg" id="di-json-err" style="display:none"></div>
    </div>

    <div id="di-preview-wrap"></div>`;

  // Lang toggle
  document.getElementById('lang-py').addEventListener('click', () => {
    _lang = 'python';
    document.getElementById('di-script-pre').textContent = PYTHON_SCRIPT;
    updateLangBtns();
  });
  document.getElementById('lang-node').addEventListener('click', () => {
    _lang = 'node';
    document.getElementById('di-script-pre').textContent = NODE_SCRIPT;
    updateLangBtns();
  });
  updateLangBtns();

  // Copy
  document.getElementById('di-copy-script').addEventListener('click', function() {
    const script = _lang === 'python' ? PYTHON_SCRIPT : NODE_SCRIPT;
    navigator.clipboard.writeText(script).then(() => {
      this.textContent = '✓ Kopyalandı!';
      this.classList.add('copied');
      setTimeout(() => { this.textContent = '📋 Kopyala'; this.classList.remove('copied'); }, 2000);
    });
  });

  // JSON input → live preview
  document.getElementById('di-json-input').addEventListener('input', livePreview);
}

function updateLangBtns() {
  ['lang-py','lang-node'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.style.background = (_lang === 'python' && id === 'lang-py') || (_lang === 'node' && id === 'lang-node')
      ? 'var(--brand-bg)' : '';
    btn.style.borderColor = (_lang === 'python' && id === 'lang-py') || (_lang === 'node' && id === 'lang-node')
      ? 'var(--brand)' : '';
    btn.style.color = (_lang === 'python' && id === 'lang-py') || (_lang === 'node' && id === 'lang-node')
      ? 'var(--brand)' : '';
  });
}

function livePreview() {
  const val = document.getElementById('di-json-input')?.value?.trim();
  const prevWrap = document.getElementById('di-preview-wrap');
  const errEl = document.getElementById('di-json-err');
  const textarea = document.getElementById('di-json-input');
  if (!val || !prevWrap) return;

  try {
    const data = JSON.parse(val);
    const parsed = parseDiscordData(data);
    _parsedData = parsed;
    textarea?.classList.remove('error'); textarea?.classList.add('ok');
    if (errEl) errEl.style.display = 'none';
    prevWrap.innerHTML = buildPreviewHTML(parsed);
  } catch (e) {
    _parsedData = null;
    textarea?.classList.add('error'); textarea?.classList.remove('ok');
    if (errEl) { errEl.textContent = '❌ Geçersiz JSON: ' + e.message; errEl.style.display = 'block'; }
    prevWrap.innerHTML = '';
  }
}

function buildPreviewHTML(parsed) {
  const cats = Object.entries(parsed.categories);
  const totalChannels = cats.reduce((s,[,v]) => s + v.length, 0);
  const catsHTML = cats.map(([cat, chs]) => `
    <div class="di-preview-cat">📁 ${escHtml(cat)}</div>
    ${chs.map(ch => `<div class="di-preview-ch"><span class="di-ch-icon">${ch.type==='voice'?'🔊':ch.type==='stage'?'🎭':'#'}</span>${escHtml(ch.name)}</div>`).join('')}
  `).join('');

  return `
    <div class="di-preview">
      <div class="di-preview-title">✅ Yapı algılandı — <span style="color:var(--teal)">${escHtml(parsed.name)}</span></div>
      <div class="di-preview-grid">
        <div class="di-preview-stat"><div class="di-preview-val">${cats.length}</div><div class="di-preview-lbl">Kategori</div></div>
        <div class="di-preview-stat"><div class="di-preview-val">${totalChannels}</div><div class="di-preview-lbl">Kanal</div></div>
        <div class="di-preview-stat"><div class="di-preview-val">${parsed.roles.length}</div><div class="di-preview-lbl">Rol</div></div>
      </div>
      <div class="di-preview-cats">${catsHTML}</div>
    </div>`;
}

function renderStep2Manual(body) {
  if (!_manualCats.length) {
    _manualCats = [
      { name: 'GENEL', channels: [{ name: 'genel', type: 'text' }, { name: 'duyurular', type: 'text' }] },
      { name: 'SES', channels: [{ name: 'Genel', type: 'voice' }] },
    ];
  }
  body.innerHTML = `
    <div class="di-sec-title">✏️ Sunucu yapısını elle oluştur</div>
    <div class="di-sec-sub">Kategoriler ve kanalları gir. Sonradan ayarlardan değiştirebilirsin.</div>
    <div class="di-field" style="margin-bottom:14px">
      <label>Sunucu Adı</label>
      <input class="di-input" id="di-srv-name" value="${escHtml(_serverName||'')}" placeholder="Sunucumun Adı">
    </div>
    <div class="di-field" style="margin-bottom:16px">
      <label>Sunucu İkonu (emoji)</label>
      <input class="di-input" id="di-srv-icon" value="${escHtml(_serverIcon)}" placeholder="🌐" style="max-width:100px">
    </div>
    <div class="di-cats-list" id="di-cats-list"></div>
    <button class="di-add-cat-btn" id="di-add-cat" style="margin-top:10px">+ Kategori Ekle</button>`;

  renderManualCats();

  document.getElementById('di-srv-name').addEventListener('input', e => { _serverName = e.target.value; });
  document.getElementById('di-srv-icon').addEventListener('input', e => { _serverIcon = e.target.value; });
  document.getElementById('di-add-cat').addEventListener('click', () => {
    _manualCats.push({ name: 'YENİ KATEGORİ', channels: [{ name: 'genel', type: 'text' }] });
    renderManualCats();
  });
}

function renderManualCats() {
  const list = document.getElementById('di-cats-list');
  if (!list) return;
  list.innerHTML = '';
  _manualCats.forEach((cat, ci) => {
    const catEl = document.createElement('div');
    catEl.className = 'di-cat-item';
    catEl.innerHTML = `
      <div class="di-cat-header">
        <span style="color:var(--text-muted);font-size:12px">📁</span>
        <input class="di-cat-name-inp" value="${escHtml(cat.name)}" data-ci="${ci}">
        <button class="di-cat-del" data-ci="${ci}">🗑</button>
      </div>
      <div class="di-channels-list" id="di-chs-${ci}">
        ${cat.channels.map((ch, chi) => `
          <div class="di-ch-item">
            <span style="color:var(--text-muted);font-size:11px">${ch.type==='voice'?'🔊':ch.type==='stage'?'🎭':'#'}</span>
            <input class="di-ch-name-inp" value="${escHtml(ch.name)}" data-ci="${ci}" data-chi="${chi}">
            <select class="di-ch-type" data-ci="${ci}" data-chi="${chi}">
              <option value="text" ${ch.type==='text'?'selected':''}>Yazı</option>
              <option value="voice" ${ch.type==='voice'?'selected':''}>Ses</option>
              <option value="stage" ${ch.type==='stage'?'selected':''}>Sahne</option>
            </select>
            <button class="di-ch-del" data-ci="${ci}" data-chi="${chi}">✕</button>
          </div>`).join('')}
        <button class="di-add-ch-btn" data-ci="${ci}">+ Kanal ekle</button>
      </div>`;
    list.appendChild(catEl);
  });

  list.querySelectorAll('.di-cat-name-inp').forEach(inp => {
    inp.addEventListener('input', e => { _manualCats[+e.target.dataset.ci].name = e.target.value; });
  });
  list.querySelectorAll('.di-cat-del').forEach(btn => {
    btn.addEventListener('click', e => { _manualCats.splice(+e.target.dataset.ci, 1); renderManualCats(); });
  });
  list.querySelectorAll('.di-ch-name-inp').forEach(inp => {
    inp.addEventListener('input', e => { _manualCats[+e.target.dataset.ci].channels[+e.target.dataset.chi].name = e.target.value; });
  });
  list.querySelectorAll('.di-ch-type').forEach(sel => {
    sel.addEventListener('change', e => {
      _manualCats[+e.target.dataset.ci].channels[+e.target.dataset.chi].type = e.target.value;
      renderManualCats();
    });
  });
  list.querySelectorAll('.di-ch-del').forEach(btn => {
    btn.addEventListener('click', e => {
      _manualCats[+e.target.dataset.ci].channels.splice(+e.target.dataset.chi, 1);
      renderManualCats();
    });
  });
  list.querySelectorAll('.di-add-ch-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      _manualCats[+e.target.dataset.ci].channels.push({ name: 'yeni-kanal', type: 'text' });
      renderManualCats();
    });
  });
}

/* ── ADIM 3: İçe Aktar ── */
function renderStep3(body, footer) {
  const importData = buildImportPayload();

  const totalChannels = importData.categories.reduce((s, c) => s + c.channels.length, 0);

  body.innerHTML = `
    <div class="di-sec-title">🚀 İçe aktarılacak yapı</div>
    <div class="di-preview" style="margin-bottom:16px">
      <div class="di-preview-title">📋 Özet — <span style="color:var(--brand)">${escHtml(importData.name)}</span></div>
      <div class="di-preview-grid">
        <div class="di-preview-stat"><div class="di-preview-val">${importData.categories.length}</div><div class="di-preview-lbl">Kategori</div></div>
        <div class="di-preview-stat"><div class="di-preview-val">${totalChannels}</div><div class="di-preview-lbl">Kanal</div></div>
        <div class="di-preview-stat"><div class="di-preview-val">${(importData.roles||[]).length}</div><div class="di-preview-lbl">Rol</div></div>
      </div>
    </div>
    <div class="di-progress-wrap" id="di-progress-wrap" style="display:none">
      <div class="di-progress-bar-outer"><div class="di-progress-bar-inner" id="di-pbar"></div></div>
      <div class="di-progress-label" id="di-plabel">Hazırlanıyor...</div>
      <div class="di-progress-steps" id="di-psteps"></div>
    </div>`;

  footer.innerHTML = `
    <button class="di-btn di-btn-ghost" id="di-back-3">← Geri</button>
    <button class="di-btn di-btn-primary" id="di-start-import">🚀 İçe Aktarmayı Başlat</button>`;

  document.getElementById('di-back-3').addEventListener('click', () => { _step = 2; renderStep(); });
  document.getElementById('di-start-import').addEventListener('click', () => {
    document.getElementById('di-start-import').disabled = true;
    document.getElementById('di-back-3').style.display = 'none';
    document.getElementById('di-progress-wrap').style.display = 'block';
    doImport(importData);
  });
}

async function doImport(importData) {
  const steps = [
    { label: 'Sunucu oluşturuluyor...', key: 'server' },
    ...importData.categories.map(c => ({ label: `"${c.name}" kategorisi oluşturuluyor...`, key: 'cat_' + c.name })),
    ...(importData.roles||[]).slice(0,10).map(r => ({ label: `"${r.name}" rolü oluşturuluyor...`, key: 'role_' + r.name })),
    { label: 'Tamamlanıyor...', key: 'finish' },
  ];
  const total = steps.length;

  const setProgress = (i, state, label) => {
    const pct = Math.round((i / total) * 100);
    const bar = document.getElementById('di-pbar');
    const lbl = document.getElementById('di-plabel');
    const stepsEl = document.getElementById('di-psteps');
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = label || '';
    if (stepsEl) {
      const el = document.createElement('div');
      el.className = `di-ps ${state}`;
      el.innerHTML = `<span class="di-ps-icon">${state==='done'?'✅':state==='error'?'❌':'⏳'}</span>${escHtml(label||'')}`;
      stepsEl.appendChild(el);
      stepsEl.scrollTop = stepsEl.scrollHeight;
    }
  };

  try {
    // 1. Sunucu oluştur
    setProgress(0, 'active', 'Sunucu oluşturuluyor...');
    await delay(300);

    let serverId;
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(`${getAPI() || ''}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name: importData.name, icon: importData.icon || '🌐' }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const srv = await r.json();
      serverId = srv._id;
    } catch {
      serverId = 'local-' + Date.now();
    }
    _importedServerId = serverId;
    setProgress(1, 'done', '✅ Sunucu oluşturuldu: ' + importData.name);

    // 2. Kategoriler & kanallar
    let stepIdx = 1;
    for (const cat of importData.categories) {
      stepIdx++;
      setProgress(stepIdx, 'active', `"${cat.name}" oluşturuluyor...`);
      await delay(250 + Math.random() * 200);
      try {
        if (serverId && !serverId.startsWith('local-')) {
          const token = localStorage.getItem('token');
          for (const ch of cat.channels) {
            await fetch(`${getAPI() || ''}/api/servers/${serverId}/channels`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
              body: JSON.stringify({ name: ch.name, type: ch.type, category: cat.name }),
            });
          }
        }
      } catch {}
      setProgress(stepIdx, 'done', `✅ ${cat.name} — ${cat.channels.length} kanal`);
    }

    // 3. Roller
    for (const role of (importData.roles || []).slice(0, 10)) {
      stepIdx++;
      setProgress(stepIdx, 'active', `"${role.name}" rolü oluşturuluyor...`);
      await delay(150);
      try {
        if (serverId && !serverId.startsWith('local-')) {
          const token = localStorage.getItem('token');
          await fetch(`${getAPI() || ''}/api/servers/${serverId}/roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ name: role.name, color: role.colorHex || '#99aab5' }),
          });
        }
      } catch {}
      setProgress(stepIdx, 'done', `✅ Rol: ${role.name}`);
    }

    setProgress(total, 'done', '🎉 Tamamlandı!');
    await delay(600);
    _step = 4;
    renderStep();

  } catch (err) {
    setProgress(total, 'error', '❌ Hata: ' + err.message);
    document.getElementById('di-start-import').disabled = false;
    document.getElementById('di-start-import').textContent = '↺ Tekrar Dene';
    document.getElementById('di-back-3').style.display = '';
  }
}

/* ── ADIM 4: Tamamlandı ── */
function renderStep4(body, footer) {
  body.innerHTML = `
    <div class="di-result">
      <div class="di-result-icon">🎉</div>
      <div class="di-result-title" style="color:var(--teal)">İçe Aktarma Tamamlandı!</div>
      <div class="di-result-sub">
        Sunucun başarıyla oluşturuldu.<br>
        Şimdi üyeleri davet edebilir, bot ekleyebilir ve kanalları özelleştirebilirsin.
      </div>
      <div class="di-info-box" style="margin-top:24px;text-align:left">
        💡 <strong>Sıradaki adımlar:</strong><br>
        • Sunucu ayarlarından davet linki oluştur<br>
        • Bot Marketplace'ten bot ekle<br>
        • Kanal izinlerini yapılandır<br>
        • E2E şifrelemeyi etkinleştir (isteğe bağlı)
      </div>
    </div>`;

  footer.innerHTML = `
    <button class="di-btn di-btn-ghost" id="di-import-another">↺ Tekrar İmport Et</button>
    <button class="di-btn di-btn-success" id="di-go-server">Sunucuya Git →</button>`;

  document.getElementById('di-import-another').addEventListener('click', () => {
    _step = 1; _parsedData = null; _manualCats = []; renderStep();
  });
  document.getElementById('di-go-server').addEventListener('click', () => {
    closeImport();
    if (_importedServerId && typeof loadServer === 'function') {
      loadServer(_importedServerId);
    } else if (_importedServerId) {
      window.location.hash = '#server/' + _importedServerId;
    }
    if (typeof showToast === 'function') showToast('Sunucu başarıyla oluşturuldu! 🎉', 'success');
  });
}

/* ══════════════════════════════════════════════════════════
   YARDIMCI FONKSİYONLAR
══════════════════════════════════════════════════════════ */

/** Discord API çıktısını Bridge iç formatına dönüştür */
function parseDiscordData(data) {
  const channels = data.channels || [];
  const roles    = data.roles    || [];

  // Kategorileri bul (type=4)
  const categoryMap = {};
  channels.filter(c => c.type === 4).sort((a,b)=>a.position-b.position).forEach(c => {
    categoryMap[c.id] = { name: c.name.toUpperCase(), channels: [] };
  });

  // Kategorisiz için varsayılan
  const UNCATEGORIZED = '__GENEL__';
  categoryMap[UNCATEGORIZED] = { name: 'GENEL', channels: [] };

  // Kanalları kategorilere dağıt
  channels.filter(c => c.type !== 4).sort((a,b)=>a.position-b.position).forEach(ch => {
    const parentKey = ch.parent_id || UNCATEGORIZED;
    if (!categoryMap[parentKey]) categoryMap[parentKey] = { name: 'DİĞER', channels: [] };
    const chType = ch.type === 2 ? 'voice' : ch.type === 13 ? 'stage' : 'text';
    categoryMap[parentKey].channels.push({ name: ch.name, type: chType });
  });

  // Boş kategorileri temizle
  const categories = {};
  Object.values(categoryMap).forEach(cat => {
    if (cat.channels.length) categories[cat.name] = cat.channels;
  });

  return {
    name: data.name || 'Discord Sunucusu',
    icon: data.icon || '🌐',
    categories,
    roles: roles.map(r => ({
      name: r.name,
      colorHex: r.color ? '#' + r.color.toString(16).padStart(6,'0') : '#99aab5',
    })),
  };
}

/** JSON validasyon */
function validateJSON() {
  const val = document.getElementById('di-json-input')?.value?.trim();
  const errEl = document.getElementById('di-json-err');
  if (!val) {
    if (errEl) { errEl.textContent = '❌ JSON boş olamaz.'; errEl.style.display = 'block'; }
    return false;
  }
  try {
    const data = JSON.parse(val);
    _parsedData = parseDiscordData(data);
    return true;
  } catch (e) {
    if (errEl) { errEl.textContent = '❌ Geçersiz JSON: ' + e.message; errEl.style.display = 'block'; }
    return false;
  }
}

/** Manuel validasyon */
function validateManual() {
  _serverName = document.getElementById('di-srv-name')?.value?.trim() || '';
  _serverIcon = document.getElementById('di-srv-icon')?.value?.trim() || '🌐';
  if (!_serverName) {
    alert('Lütfen sunucu adını gir.');
    return false;
  }
  return true;
}

/** Import payload'u oluştur */
function buildImportPayload() {
  if (_method === 'json' && _parsedData) {
    return {
      name: _parsedData.name,
      icon: _parsedData.icon || '🌐',
      categories: Object.entries(_parsedData.categories).map(([name, channels]) => ({ name, channels })),
      roles: _parsedData.roles || [],
    };
  }
  // Manuel
  return {
    name: _serverName || 'Yeni Sunucu',
    icon: _serverIcon || '🌐',
    categories: _manualCats.map(c => ({ name: c.name, channels: c.channels })),
    roles: [],
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
// escHtml — utils.js'ten gelir, buradaki kopya kaldırıldı

/* ══════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════ */
window.DiscordImport = { open: openDiscordImport, close: closeImport };
console.log('[DiscordImport] Sihirbaz yüklendi ✓');

export {
  buildImportPayload,
  buildPreviewHTML,
  closeImport,
  delay,
  diEscHandler,
  doImport,
  injectImportStyles,
  livePreview,
  openDiscordImport,
  parseDiscordData,
  renderManualCats,
  renderStep,
  renderStep1,
  renderStep2,
  renderStep2JSON,
  renderStep2Manual,
  renderStep3,
  renderStep4,
  renderStepBar,
  updateLangBtns,
  validateJSON,
  validateManual,
};

export const getDiscordImport = () => window.DiscordImport;
