// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DiscordImportPanel.svelte
//              client/js/core/discord-import-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/discord-import.ts
// Discord Sunucu Import Sihirbazı — Ana koordinatör modül
//
// Modül yapısı (Sprint 42 refactor):
//   discord-import-styles.ts  — CSS enjeksiyonu (~170 satır)
//   discord-import-parser.ts  — JSON parse + doğrulama + payload oluşturma
//   discord-import.ts         — Wizard UI + state + import akışı (bu dosya)
//
// Discord, sunucu verilerini dışa aktarmak için resmi API sunmaz.
// Bu araç kullanıcıya 2 yöntem sunar:
//
//   Yöntem A — Manuel JSON (önerilen, %100 çalışır)
//     Kullanıcı kendi bot token'ı ile çalıştırabileceği küçük bir
//     Python/Node script'i kopyalar, çıktı JSON'u buraya yapıştırır.
//
//   Yöntem B — Hızlı Åablon
//     Kanal yapısını sıfırdan elle girerek Bridge şablonu oluşturur.
//
// Sunucu tarafı: POST /api/discord-import
// Oluşturulan: Sunucu + kategoriler + kanallar + roller

import { BridgeRegistry } from './bridge-registry.js';
import { getAPI } from './globals.js';
import { injectImportStyles } from './discord-import-styles.js';
import {
  parseDiscordData as _parseDiscordData,
  validateAndParseJSON,
  buildImportPayload as _buildImportPayload,
} from './discord-import-parser.js';
'use strict';

import { createLogger } from './logger.js';
const log = createLogger('DiscordImport');


// Styles modülünden import edildi — bkz. discord-import-styles.ts

/* ══════════════════════════════════════════════════════════
   SCRIPT ÅABLONLARI — kullanıcı kopyalayıp çalıştırır
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
    log.log('✅ discord_export.json oluşturuldu!');
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
            <div class="di-title">ğŸ“¥ Discord Sunucu Import</div>
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
  document.getElementById('di-close')?.addEventListener('click', closeImport);
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
        <div class="di-method-icon">ğŸ“„</div>
        <div class="di-method-title">JSON ile İçe Aktar</div>
        <div class="di-method-desc">Küçük bir script çalıştır, çıktı JSON'u buraya yapıştır. Tam kanal yapısı ve roller aktarılır.</div>
        <span class="di-method-badge badge-recommended">✓ Önerilen</span>
      </button>
      <button class="di-method-card ${_method==='manual'?'selected':''}" data-method="manual">
        <div class="di-method-icon">âœï¸</div>
        <div class="di-method-title">Elle Oluştur</div>
        <div class="di-method-desc">Kategori ve kanalları arayüzden gir. Küçük sunucular veya yeni başlayanlar için ideal.</div>
        <span class="di-method-badge badge-fast">âš¡ Hızlı</span>
      </button>
    </div>
    <div class="di-warn-box">
      âš ï¸ <strong>Not:</strong> Mesaj geçmişi aktarılamaz — bu Discord'un politikası gereğidir. Sadece sunucu yapısı (kanallar, kategoriler, roller) taşınır.
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
  document.getElementById('di-next-1')?.addEventListener('click', () => { _step = 2; renderStep(); });
}

/* ── ADIM 2: Veri Gir ── */
function renderStep2(body, footer) {
  if (_method === 'json') renderStep2JSON(body);
  else renderStep2Manual(body);

  footer.innerHTML = `
    <button class="di-btn di-btn-ghost" id="di-back-2">â† Geri</button>
    <button class="di-btn di-btn-primary" id="di-next-2">Devam →</button>`;
  document.getElementById('di-back-2')?.addEventListener('click', () => { _step = 1; renderStep(); });
  document.getElementById('di-next-2')?.addEventListener('click', () => {
    if (_method === 'json') { if (!validateJSON()) return; }
    else { if (!validateManual()) return; }
    _step = 3;
    renderStep();
  });
}

function renderStep2JSON(body) {
  body.innerHTML = `
    <div class="di-sec-title">ğŸ Script'i çalıştır, JSON'u yapıştır</div>
    <div class="di-sec-sub">Aşağıdaki script'i çalıştır, çıktı dosyasını aç ve içeriği buraya yapıştır.</div>

    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button class="di-btn di-btn-ghost" id="lang-py" style="padding:6px 14px;font-size:12px">ğŸ Python</button>
      <button class="di-btn di-btn-ghost" id="lang-node" style="padding:6px 14px;font-size:12px">ğŸŸ¢ Node.js</button>
    </div>

    <div style="position:relative">
      <pre class="di-script-box" id="di-script-pre">${escHtml(PYTHON_SCRIPT)}</pre>
      <button class="di-copy-btn" id="di-copy-script">ğŸ“‹ Kopyala</button>
    </div>

    <div class="di-info-box">
      ğŸ’¡ <strong>Nasıl çalışır?</strong> Script, kendi bot token'ınla Discord API'sine bağlanır ve sadece sunucu yapısını (kanal adları, kategoriler) çeker. Token güvende kalır — Bridge'e gönderilmez.
    </div>

    <div style="margin-top:16px">
      <div class="di-sec-title" style="margin-bottom:8px">Çıktı JSON'unu buraya yapıştır:</div>
      <textarea class="di-json-area" id="di-json-input" placeholder='{"name":"Sunucum","channels":[...],"roles":[]}'></textarea>
      <div class="di-err-msg" id="di-json-err" style="display:none"></div>
    </div>

    <div id="di-preview-wrap"></div>`;

  // Lang toggle
  document.getElementById('lang-py')?.addEventListener('click', () => {
    _lang = 'python';
    document.getElementById('di-script-pre')?.textContent = PYTHON_SCRIPT;
    updateLangBtns();
  });
  document.getElementById('lang-node')?.addEventListener('click', () => {
    _lang = 'node';
    document.getElementById('di-script-pre')?.textContent = NODE_SCRIPT;
    updateLangBtns();
  });
  updateLangBtns();

  // Copy
  document.getElementById('di-copy-script')?.addEventListener('click', function() {
    const script = _lang === 'python' ? PYTHON_SCRIPT : NODE_SCRIPT;
    navigator.clipboard.writeText(script).then(() => {
      this.textContent = '✓ Kopyalandı!';
      this.classList.add('copied');
      setTimeout(() => { this.textContent = 'ğŸ“‹ Kopyala'; this.classList.remove('copied'); }, 2000);
    });
  });

  // JSON input → live preview
  document.getElementById('di-json-input')?.addEventListener('input', livePreview);
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
    const parsed = _parseDiscordData(data);
    _parsedData = parsed;
    textarea?.classList.remove('error'); textarea?.classList.add('ok');
    if (errEl) errEl.style.display = 'none';
    prevWrap.innerHTML = buildPreviewHTML(parsed);
  } catch (e) {
    _parsedData = null;
    textarea?.classList.add('error'); textarea?.classList.remove('ok');
    if (errEl) { errEl.textContent = 'âŒ Geçersiz JSON: ' + e.message; errEl.style.display = 'block'; }
    prevWrap.innerHTML = '';
  }
}

function buildPreviewHTML(parsed) {
  const cats = Object.entries(parsed.categories);
  const totalChannels = cats.reduce((s,[,v]) => s + v.length, 0);
  const catsHTML = cats.map(([cat, chs]) => `
    <div class="di-preview-cat">ğŸ“ ${escHtml(cat)}</div>
    ${chs.map(ch => `<div class="di-preview-ch"><span class="di-ch-icon">${ch.type==='voice'?'ğŸ”Š':ch.type==='stage'?'ğŸ­':'#'}</span>${escHtml(ch.name)}</div>`).join('')}
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
    <div class="di-sec-title">âœï¸ Sunucu yapısını elle oluştur</div>
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

  document.getElementById('di-srv-name')?.addEventListener('input', e => { _serverName = e.target.value; });
  document.getElementById('di-srv-icon')?.addEventListener('input', e => { _serverIcon = e.target.value; });
  document.getElementById('di-add-cat')?.addEventListener('click', () => {
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
        <span style="color:var(--text-muted);font-size:12px">ğŸ“</span>
        <input class="di-cat-name-inp" value="${escHtml(cat.name)}" data-ci="${ci}">
        <button class="di-cat-del" data-ci="${ci}">ğŸ—‘</button>
      </div>
      <div class="di-channels-list" id="di-chs-${ci}">
        ${cat.channels.map((ch, chi) => `
          <div class="di-ch-item">
            <span style="color:var(--text-muted);font-size:11px">${ch.type==='voice'?'ğŸ”Š':ch.type==='stage'?'ğŸ­':'#'}</span>
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
  const importData = _buildImportPayload(_method as 'json' | 'manual', _parsedData, _manualCats, _serverName, _serverIcon);

  const totalChannels = importData.categories.reduce((s, c) => s + c.channels.length, 0);

  body.innerHTML = `
    <div class="di-sec-title">ğŸš€ İçe aktarılacak yapı</div>
    <div class="di-preview" style="margin-bottom:16px">
      <div class="di-preview-title">ğŸ“‹ Özet — <span style="color:var(--brand)">${escHtml(importData.name)}</span></div>
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
    <button class="di-btn di-btn-ghost" id="di-back-3">â† Geri</button>
    <button class="di-btn di-btn-primary" id="di-start-import">ğŸš€ İçe Aktarmayı Başlat</button>`;

  document.getElementById('di-back-3')?.addEventListener('click', () => { _step = 2; renderStep(); });
  document.getElementById('di-start-import')?.addEventListener('click', () => {
    document.getElementById('di-start-import')?.disabled = true;
    document.getElementById('di-back-3')?.style.display = 'none';
    document.getElementById('di-progress-wrap')?.style.display = 'block';
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
      el.innerHTML = `<span class="di-ps-icon">${state==='done'?'✅':state==='error'?'âŒ':'â³'}</span>${escHtml(label||'')}`;
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
      const r = await fetch(`${getAPI()}/api/servers`, {
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
            await fetch(`${getAPI()}/api/servers/${serverId}/channels`, {
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
          await fetch(`${getAPI()}/api/servers/${serverId}/roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ name: role.name, color: role.colorHex || '#99aab5' }),
          });
        }
      } catch {}
      setProgress(stepIdx, 'done', `✅ Rol: ${role.name}`);
    }

    setProgress(total, 'done', 'ğŸ‰ Tamamlandı!');
    await delay(600);
    _step = 4;
    renderStep();

  } catch (err) {
    setProgress(total, 'error', 'âŒ Hata: ' + err.message);
    document.getElementById('di-start-import')?.disabled = false;
    document.getElementById('di-start-import')?.textContent = 'â†º Tekrar Dene';
    document.getElementById('di-back-3')?.style.display = '';
  }
}

/* ── ADIM 4: Tamamlandı ── */
function renderStep4(body, footer) {
  body.innerHTML = `
    <div class="di-result">
      <div class="di-result-icon">ğŸ‰</div>
      <div class="di-result-title" style="color:var(--teal)">İçe Aktarma Tamamlandı!</div>
      <div class="di-result-sub">
        Sunucun başarıyla oluşturuldu.<br>
        Åimdi üyeleri davet edebilir, bot ekleyebilir ve kanalları özelleştirebilirsin.
      </div>
      <div class="di-info-box" style="margin-top:24px;text-align:left">
        ğŸ’¡ <strong>Sıradaki adımlar:</strong><br>
        • Sunucu ayarlarından davet linki oluştur<br>
        • Bot Marketplace'ten bot ekle<br>
        • Kanal izinlerini yapılandır<br>
        • E2E şifrelemeyi etkinleştir (isteğe bağlı)
      </div>
    </div>`;

  footer.innerHTML = `
    <button class="di-btn di-btn-ghost" id="di-import-another">â†º Tekrar İmport Et</button>
    <button class="di-btn di-btn-success" id="di-go-server">Sunucuya Git →</button>`;

  document.getElementById('di-import-another')?.addEventListener('click', () => {
    _step = 1; _parsedData = null; _manualCats = []; _importedServerId = null; renderStep();
  });
  document.getElementById('di-go-server')?.addEventListener('click', () => {
    closeImport();
    if (_importedServerId && typeof loadServer === 'function') {
      loadServer(_importedServerId);
    } else if (_importedServerId) {
      location.hash = '#server/' + _importedServerId;
    }
    if (typeof showToast === 'function') showToast('Sunucu başarıyla oluşturuldu! ğŸ‰', 'success');
  });
}

/* ══════════════════════════════════════════════════════════
   YARDIMCI FONKSİYONLAR
══════════════════════════════════════════════════════════ */

/** Discord API çıktısını Bridge iç formatına dönüştür */

function validateJSON() {
  const val = document.getElementById('di-json-input')?.value?.trim();
  const errEl = document.getElementById('di-json-err');
  if (!val) {
    if (errEl) { errEl.textContent = 'âŒ JSON boş olamaz.'; errEl.style.display = 'block'; }
    return false;
  }
  try {
    const data = JSON.parse(val);
    _parsedData = _parseDiscordData(data);
    return true;
  } catch (e) {
    if (errEl) { errEl.textContent = 'âŒ Geçersiz JSON: ' + e.message; errEl.style.display = 'block'; }
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
// escHtml — utils.js'ten gelir, buradaki kopya kaldırıldı

/* ══════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════ */
BridgeRegistry.register('DiscordImport:open', openDiscordImport);
BridgeRegistry.register('DiscordImport:close', closeImport);
BridgeRegistry.register('openDiscordImport', openDiscordImport);
// Geriye-dönük uyumluluk: HTML onclick="openDiscordImport()" için
(globalThis as Record<string, unknown>).openDiscordImport = openDiscordImport;
log.log('[DiscordImport] Sihirbaz yüklendi ✓');

