// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AutomodUiPanel.svelte
//              client/js/core/automod-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/automod-ui.ts
// AutoMod kural yönetim paneli — rule editor, list, CRUD
// Sprint 33: Full rewrite with strict types (original file had encoding issues)

'use strict';

declare const apiFetch: (url: string, opts?: RequestInit) => Promise<Response>;
declare const escHtml: (s: string) => string;
declare const API: string;
declare const toast: (msg: string, type: string) => void;
declare const currentServer: { _id: string } | null;
declare function _destroyTempModal(): void;
declare function openAutoModPanel(): Promise<void>;

// ── Types ──────────────────────────────────────────────────────────────────
interface AutoModConfig {
  action?: 'delete' | 'timeout' | 'delete_and_timeout';
  timeoutMs?: number;
  logChannelId?: string;
  exemptRoles?: string[];
  words?: string[];
  maxMessages?: number;
  windowSecs?: number;
  minLength?: number;
  maxMentions?: number;
  minRepeat?: number;
}

interface AutoModRule {
  _id: string;
  type: keyof typeof AUTOMOD_TYPES | string;
  enabled: boolean;
  config?: AutoModConfig;
}

const AUTOMOD_TYPES = {
  blocked_words:  { label: '🚫 Yasaklı Kelimeler',     desc: 'Belirli kelimeleri içeren mesajları engelle' },
  spam_messages:  { label: '⚡ Spam Koruması',          desc: 'Kısa sürede çok mesaj gönderilmesini engelle' },
  caps_lock:      { label: '🔠 Büyük Harf Spam',       desc: 'Aşırı büyük harf kullanımını engelle' },
  link_filter:    { label: '🔗 Link Filtresi',          desc: 'İzinsiz link paylaşımını engelle' },
  invite_filter:  { label: '💌 Davet Linki Filtresi',  desc: 'Bridge davet linklerini engelle' },
  mention_spam:   { label: '📢 Mention Spam',           desc: 'Toplu mention engelleyici' },
  repeated_chars: { label: '🔁 Tekrar Karakter',       desc: 'Aaaaaaa gibi tekrar eden karakterleri engelle' },
} as const;

// ── Panel ─────────────────────────────────────────────────────────────────
async function openAutoModPanel(): Promise<void> {
  if (!currentServer) return;
  _destroyTempModal();

  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:680px;width:95%;max-height:85vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="margin:0">🛡️ AutoMod Kuralları</h2>
        <button class="btn btn-primary" onclick="openAutoModRuleEditor(null)">+ Kural Ekle</button>
      </div>
      <div id="automod-rules-list" style="flex:1;overflow-y:auto">
        <div style="text-align:center;padding:30px;color:var(--text-muted)">Yükleniyor...</div>
      </div>
      <div class="modal-footer"><button class="btn" onclick="_destroyTempModal()">Kapat</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) _destroyTempModal(); };
  await refreshAutoModRules();
}

async function refreshAutoModRules(): Promise<void> {
  const list = document.getElementById('automod-rules-list');
  if (!list || !currentServer) return;

  const r     = await apiFetch(`${API}/api/servers/${currentServer._id}/automod`);
  const rules = r.ok ? await r.json() as AutoModRule[] : [];

  if (!rules.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:40px;margin-bottom:12px">🛡️</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">Henüz kural yok</div>
        <div style="font-size:13px">Sunucunu korumak için AutoMod kuralları ekle.</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  for (const rule of rules) {
    const meta = AUTOMOD_TYPES[rule.type as keyof typeof AUTOMOD_TYPES] ?? { label: rule.type, desc: '' };
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;display:flex;gap:12px;align-items:center';
    card.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <span style="font-weight:600;font-size:14px">${escHtml(meta.label)}</span>
          <span style="font-size:11px;padding:2px 6px;border-radius:3px;
            background:${rule.enabled ? 'var(--green)' : 'var(--bg-3)'};
            color:${rule.enabled ? '#fff' : 'var(--text-muted)'}">
            ${rule.enabled ? 'Aktif' : 'Kapalı'}
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-muted)">${_automodConfigSummary(rule)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-sm"
          onclick="toggleAutoModRule('${rule._id}',${!rule.enabled})"
          title="${rule.enabled ? 'Kapat' : 'Aç'}">
          ${rule.enabled ? '⏸' : '▶️'}
        </button>
        <button class="btn btn-sm" onclick="openAutoModRuleEditor('${rule._id}')" title="Düzenle">✏️</button>
        <button class="btn btn-sm" style="color:var(--danger)"
          onclick="deleteAutoModRule('${rule._id}')" title="Sil">🗑️</button>
      </div>`;
    list.appendChild(card);
  }
}

function _automodConfigSummary(rule: AutoModRule): string {
  const c     = rule.config ?? {};
  const parts: string[] = [];
  if (rule.type === 'blocked_words' && c.words?.length)  parts.push(`${c.words.length} kelime`);
  if (rule.type === 'spam_messages') parts.push(`${c.maxMessages ?? 5} mesaj / ${c.windowSecs ?? 5}sn`);
  if (rule.type === 'caps_lock')     parts.push(`min ${c.minLength ?? 8} karakter`);
  if (rule.type === 'mention_spam')  parts.push(`max ${c.maxMentions ?? 5} mention`);
  if (c.action)       parts.push(`Eylem: ${c.action === 'delete' ? 'Sil' : c.action === 'timeout' ? 'Sustur' : 'Sil + Sustur'}`);
  if (c.logChannelId) parts.push('Log: aktif');
  return parts.join(' · ') || 'Varsayılan ayarlar';
}

// ── Toggle / Delete ───────────────────────────────────────────────────────
async function toggleAutoModRule(ruleId: string, enabled: boolean): Promise<void> {
  if (!currentServer) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod/${ruleId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) return void toast('Güncellenemedi', 'error');
  toast(enabled ? 'Kural aktifleştirildi' : 'Kural kapatıldı', 'success');
  await refreshAutoModRules();
}

async function deleteAutoModRule(ruleId: string): Promise<void> {
  if (!currentServer) return;
  if (!confirm('Bu kuralı silmek istediğinizden emin misiniz?')) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod/${ruleId}`, { method: 'DELETE' });
  if (!r.ok) return void toast('Silinemedi', 'error');
  toast('Kural silindi', 'success');
  await refreshAutoModRules();
}

// ── Rule Editor ───────────────────────────────────────────────────────────
function openAutoModRuleEditor(ruleId: string | null): void {
  if (!currentServer) return;

  const doOpen = (existing: AutoModRule | null): void => {
    const isEdit = !!existing;
    const c      = existing?.config ?? {};
    const type   = existing?.type   ?? '';

    _destroyTempModal();
    const modal = document.createElement('div');
    modal.id = 'temp-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%">
        <h2>${isEdit ? '✏️ Kuralı Düzenle' : '+ Yeni Kural'}</h2>
        ${!isEdit ? `
        <div class="form-group">
          <label>Kural Türü</label>
          <select id="am-type" class="input-field" onchange="renderAutoModConfigFields()">
            <option value="">— Seç —</option>
            ${Object.entries(AUTOMOD_TYPES).map(([k, v]) =>
              `<option value="${k}">${escHtml(v.label)}</option>`
            ).join('')}
          </select>
        </div>` :
        `<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">
          ${escHtml(AUTOMOD_TYPES[type as keyof typeof AUTOMOD_TYPES]?.label ?? type)}
         </p>
         <input type="hidden" id="am-type" value="${escHtml(type)}">`}
        <div id="am-config-fields"></div>
        <div class="form-group">
          <label>Eylem</label>
          <select id="am-action" class="input-field">
            <option value="delete"             ${c.action === 'delete'             ? 'selected' : ''}>Mesajı Sil</option>
            <option value="timeout"            ${c.action === 'timeout'            ? 'selected' : ''}>Kullanıcıyı Sustur</option>
            <option value="delete_and_timeout" ${c.action === 'delete_and_timeout' ? 'selected' : ''}>Sil + Sustur</option>
          </select>
        </div>
        <div class="form-group" id="am-timeout-group"
          style="${c.action?.includes('timeout') ? '' : 'display:none'}">
          <label>Susturma Süresi (dakika)</label>
          <input type="number" id="am-timeout-min" class="input-field"
            value="${Math.round((c.timeoutMs ?? 60000) / 60000)}" min="1" max="10080" style="width:120px">
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary"
            onclick="${isEdit ? `saveAutoModRule('${ruleId}')` : 'createAutoModRule()'}">
            ${isEdit ? 'Kaydet' : 'Oluştur'}
          </button>
          <button class="btn" onclick="openAutoModPanel()">İptal</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.onclick = (e) => { if (e.target === modal) void openAutoModPanel(); };

    const actionSel = document.getElementById('am-action') as HTMLSelectElement | null;
    if (actionSel) {
      actionSel.onchange = () => {
        const g = document.getElementById('am-timeout-group');
        if (g) g.style.display = actionSel.value.includes('timeout') ? '' : 'none';
      };
    }

    if (isEdit) renderAutoModConfigFields(c);
    else renderAutoModConfigFields();
  };

  if (ruleId && currentServer) {
    apiFetch(`${API}/api/servers/${currentServer._id}/automod`).then(async r => {
      const rules = r.ok ? await r.json() as AutoModRule[] : [];
      doOpen(rules.find(x => x._id === ruleId) ?? null);
    });
  } else {
    doOpen(null);
  }
}

function renderAutoModConfigFields(existingConfig?: AutoModConfig): void {
  const typeEl    = document.getElementById('am-type') as HTMLInputElement | HTMLSelectElement | null;
  const type      = typeEl?.value ?? '';
  const c         = existingConfig ?? {};
  const container = document.getElementById('am-config-fields');
  if (!container) return;
  container.innerHTML = '';
  if (!type) return;

  if (type === 'blocked_words') {
    container.innerHTML = `
      <div class="form-group">
        <label>Yasaklı Kelimeler (virgülle ayır)</label>
        <textarea id="am-words" class="input-field" rows="3"
          placeholder="kelime1, kelime2, ...">${(c.words ?? []).join(', ')}</textarea>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Max 100 kelime</div>
      </div>`;
  } else if (type === 'spam_messages') {
    container.innerHTML = `
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label>Mesaj Limiti</label>
          <input type="number" id="am-maxmsg" class="input-field"
            value="${c.maxMessages ?? 5}" min="2" max="20">
        </div>
        <div class="form-group" style="flex:1">
          <label>Süre (saniye)</label>
          <input type="number" id="am-window" class="input-field"
            value="${c.windowSecs ?? 5}" min="1" max="60">
        </div>
      </div>`;
  } else if (type === 'caps_lock') {
    container.innerHTML = `
      <div class="form-group">
        <label>Min Karakter Uzunluğu</label>
        <input type="number" id="am-minlen" class="input-field"
          value="${c.minLength ?? 8}" min="4" max="50" style="width:100px">
      </div>`;
  } else if (type === 'mention_spam') {
    container.innerHTML = `
      <div class="form-group">
        <label>Mention Limiti</label>
        <input type="number" id="am-maxmention" class="input-field"
          value="${c.maxMentions ?? 5}" min="2" max="20" style="width:100px">
      </div>`;
  } else if (type === 'repeated_chars') {
    container.innerHTML = `
      <div class="form-group">
        <label>Min Tekrar Sayısı</label>
        <input type="number" id="am-minrepeat" class="input-field"
          value="${c.minRepeat ?? 10}" min="5" max="30" style="width:100px">
      </div>`;
  }
  // link_filter and invite_filter need no extra config
}

function _collectAutoModConfig(): AutoModConfig | null {
  const typeEl    = document.getElementById('am-type') as HTMLInputElement | HTMLSelectElement | null;
  const actionEl  = document.getElementById('am-action') as HTMLSelectElement | null;
  const timeoutEl = document.getElementById('am-timeout-min') as HTMLInputElement | null;

  const type      = typeEl?.value ?? '';
  const action    = (actionEl?.value ?? 'delete') as AutoModConfig['action'];
  const timeoutMs = parseInt(timeoutEl?.value ?? '1', 10) * 60_000;
  const config: AutoModConfig = { action, timeoutMs };

  if (type === 'blocked_words') {
    const raw   = (document.getElementById('am-words') as HTMLTextAreaElement | null)?.value ?? '';
    config.words = raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean).slice(0, 100);
    if (!config.words.length) { toast('En az bir kelime girin', 'error'); return null; }
  }
  if (type === 'spam_messages') {
    config.maxMessages = parseInt((document.getElementById('am-maxmsg') as HTMLInputElement | null)?.value ?? '5', 10) || 5;
    config.windowSecs  = parseInt((document.getElementById('am-window')  as HTMLInputElement | null)?.value ?? '5', 10) || 5;
  }
  if (type === 'caps_lock')     config.minLength   = parseInt((document.getElementById('am-minlen')     as HTMLInputElement | null)?.value ?? '8',  10) || 8;
  if (type === 'mention_spam')  config.maxMentions = parseInt((document.getElementById('am-maxmention') as HTMLInputElement | null)?.value ?? '5',  10) || 5;
  if (type === 'repeated_chars') config.minRepeat  = parseInt((document.getElementById('am-minrepeat')  as HTMLInputElement | null)?.value ?? '10', 10) || 10;

  return config;
}

async function createAutoModRule(): Promise<void> {
  if (!currentServer) return;
  const typeEl = document.getElementById('am-type') as HTMLSelectElement | null;
  const type   = typeEl?.value ?? '';
  if (!type) return void toast('Kural türü seçin', 'error');
  const config = _collectAutoModConfig();
  if (!config) return;

  const r    = await apiFetch(`${API}/api/servers/${currentServer._id}/automod`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, config, enabled: true }),
  });
  const data = await r.json() as { error?: string };
  if (!r.ok) return void toast(data.error ?? 'Oluşturulamadı', 'error');
  toast('Kural oluşturuldu! 🛡️', 'success');
  void openAutoModPanel();
}

async function saveAutoModRule(ruleId: string): Promise<void> {
  if (!currentServer) return;
  const config = _collectAutoModConfig();
  if (!config) return;

  const r    = await apiFetch(`${API}/api/servers/${currentServer._id}/automod/${ruleId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  const data = await r.json() as { error?: string };
  if (!r.ok) return void toast(data.error ?? 'Kaydedilemedi', 'error');
  toast('Kural güncellendi', 'success');
  void openAutoModPanel();
}

// ── Global exposure ───────────────────────────────────────────────────────
type G = Window & {
  openAutoModPanel:        () => Promise<void>;
  refreshAutoModRules:     () => Promise<void>;
  toggleAutoModRule:       (id: string, enabled: boolean) => Promise<void>;
  deleteAutoModRule:       (id: string) => Promise<void>;
  openAutoModRuleEditor:   (id: string | null) => void;
  renderAutoModConfigFields:(cfg?: AutoModConfig) => void;
  createAutoModRule:       () => Promise<void>;
  saveAutoModRule:         (id: string) => Promise<void>;
};
const W = window as G;
W.openAutoModPanel        = openAutoModPanel;
W.refreshAutoModRules     = refreshAutoModRules;
W.toggleAutoModRule       = toggleAutoModRule;
W.deleteAutoModRule       = deleteAutoModRule;
W.openAutoModRuleEditor   = openAutoModRuleEditor;
W.renderAutoModConfigFields = renderAutoModConfigFields;
W.createAutoModRule       = createAutoModRule;
W.saveAutoModRule         = saveAutoModRule;
