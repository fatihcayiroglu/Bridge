// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AnnouncementUiPanel.svelte
//              client/js/core/announcement-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/announcement-ui.ts — Sprint 94
// Announcement kanalı:
//   - Kanal başlığında "📢 Publish" butonu
//   - Mesaj hover'ında "Publish" aksiyonu
//   - Follow modal: başka sunucudan kanalı takip et

import { BridgeRegistry } from './bridge-registry.js';
import { apiFetch, escHtml, toast } from './utils.js';

(function () {

  const API = (window as Record<string, string>).API_BASE || '';

  // ── Kanal yüklenince başlığa Publish badge + Follow butonu enjekte et ──────
  function injectAnnouncementHeader(channelId: string, channelType: string): void {
    const header = document.getElementById('channel-header') ??
                   document.querySelector<HTMLElement>('.channel-header, #ch-header');
    if (!header) return;

    // Önceki announcement kontrollerini temizle
    header.querySelectorAll('.announcement-header-btn').forEach(el => el.remove());

    if (channelType !== 'announcement') return;

    // 📢 badge
    const badge = document.createElement('span');
    badge.className   = 'announcement-badge announcement-header-btn';
    badge.textContent = '📢 Announcement';
    badge.title       = 'Bu bir Announcement kanalı — mesajlar crosspost edilebilir';

    // Takipçiler butonu
    const followersBtn = document.createElement('button');
    followersBtn.className   = 'btn btn-sm announcement-header-btn';
    followersBtn.textContent = '👥 Takipçiler';
    followersBtn.type        = 'button';
    followersBtn.addEventListener('click', () => openFollowersModal(channelId));

    // Kanalı takip et butonu
    const followBtn = document.createElement('button');
    followBtn.className   = 'btn btn-sm btn-brand announcement-header-btn';
    followBtn.textContent = '+ Takip Et';
    followBtn.type        = 'button';
    followBtn.addEventListener('click', () => openFollowModal(channelId));

    const wrap = document.createElement('div');
    wrap.className = 'announcement-header-wrap announcement-header-btn';
    wrap.appendChild(badge);
    wrap.appendChild(followersBtn);
    wrap.appendChild(followBtn);

    header.appendChild(wrap);
  }

  // ── Mesaj hover'ına Publish butonu ekle ───────────────────────────────────
  // messages.ts'teki MutationObserver ile çalışır;
  // .msg-group[data-channel-type="announcement"] mesajlarına ekstra buton
  function injectPublishButton(msgEl: HTMLElement, channelId: string): void {
    if (msgEl.querySelector('.msg-publish-btn')) return;
    const msgId = msgEl.dataset.msgId || msgEl.id?.replace('msg-', '');
    if (!msgId) return;

    const bar = msgEl.querySelector<HTMLElement>('.msg-actions');
    if (!bar) return;

    const btn = document.createElement('button');
    btn.className   = 'msg-action-btn msg-publish-btn';
    btn.textContent = '📢';
    btn.title       = 'Publish — Tüm takipçilere gönder';
    btn.type        = 'button';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled    = true;
      btn.textContent = '⏳';
      try {
        const r = await apiFetch(
          `${API}/api/v1/channels/${channelId}/messages/${msgId}/crosspost`,
          { method: 'POST' }
        );
        const d = await r.json();
        if (!r.ok) { toast(d.error || 'Publish başarısız', 'error'); return; }
        toast(`✅ ${d.crosspostedTo} kanala gönderildi`, 'success');
        btn.textContent = '✅';
        btn.disabled    = true; // bir kez publish
      } catch {
        toast('Ağ hatası', 'error');
        btn.textContent = '📢';
        btn.disabled    = false;
      }
    });

    // Thread butonundan önce ekle
    const threadBtn = bar.querySelector<HTMLElement>('.thread-btn');
    if (threadBtn) bar.insertBefore(btn, threadBtn);
    else bar.appendChild(btn);
  }

  // ── Kanal takip modal ─────────────────────────────────────────────────────
  function openFollowModal(sourceChannelId: string): void {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:420px;">
        <h3>📢 Kanalı Takip Et</h3>
        <p class="setting-description">Bu announcement kanalını kendi sunucularınızdaki bir kanala yönlendirin. Mesajlar otomatik olarak iletilir.</p>
        <div class="setting-row">
          <label class="setting-label" for="follow-target-input">Hedef Kanal ID</label>
          <input type="text" id="follow-target-input" class="input-field" placeholder="Kanal ID yapıştırın">
        </div>
        <p class="setting-description" style="font-size:11px;">Kanal ID'sini almak için hedef kanalda sağ tık → "Kanal Kimliğini Kopyala" yapın.</p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
          <button id="follow-cancel-btn" class="btn" type="button">İptal</button>
          <button id="follow-confirm-btn" class="btn btn-brand" type="button">Takip Et</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    document.getElementById('follow-cancel-btn')?.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    document.getElementById('follow-confirm-btn')?.addEventListener('click', async () => {
      const targetChannelId = (document.getElementById('follow-target-input') as HTMLInputElement)?.value.trim();
      if (!targetChannelId) return;
      const btn = document.getElementById('follow-confirm-btn') as HTMLButtonElement;
      btn.disabled    = true;
      btn.textContent = 'Ekleniyor...';
      try {
        const r = await apiFetch(`${API}/api/v1/channels/${sourceChannelId}/follow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetChannelId }),
        });
        const d = await r.json();
        if (!r.ok) { toast(d.error || 'Takip başarısız', 'error'); btn.disabled = false; btn.textContent = 'Takip Et'; return; }
        toast('✅ Kanal takip edildi!', 'success');
        modal.remove();
      } catch {
        toast('Ağ hatası', 'error');
        btn.disabled    = false;
        btn.textContent = 'Takip Et';
      }
    });
  }

  // ── Takipçiler modal ──────────────────────────────────────────────────────
  async function openFollowersModal(sourceChannelId: string): Promise<void> {
    const r = await apiFetch(`${API}/api/v1/channels/${sourceChannelId}/followers`);
    const d = await r.json() as { count: number; followers: Array<{ targetChannelId: string; targetServerId: string }> };

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:420px;">
        <h3>👥 Takipçiler (${d.count})</h3>
        ${d.followers.length
          ? `<ul class="followers-list">${d.followers.map(f => `
              <li class="follower-item">
                <span class="follower-icon">📡</span>
                <span class="follower-id">${escHtml(f.targetChannelId)}</span>
                <span class="follower-server">${escHtml(f.targetServerId)}</span>
              </li>`).join('')}</ul>`
          : '<p class="analytics-empty">Henüz takipçi yok.</p>'}
        <button id="followers-close-btn" class="btn" type="button" style="margin-top:16px;">Kapat</button>
      </div>`;

    document.body.appendChild(modal);
    document.getElementById('followers-close-btn')?.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  // ── Event hooks ───────────────────────────────────────────────────────────
  document.addEventListener('bridge:channel-loaded', (e: Event) => {
    const { channelId, channelType } = (e as CustomEvent<{ channelId: string; channelType: string }>).detail ?? {};
    injectAnnouncementHeader(channelId, channelType);

    if (channelType !== 'announcement') return;

    // Mevcut mesajlara publish butonu ekle
    document.querySelectorAll<HTMLElement>('.msg-group, .msg-continue').forEach(msg => {
      injectPublishButton(msg, channelId);
    });

    // Yeni mesajlara da ekle
    const area = document.getElementById('messages-area') ?? document.getElementById('chat-messages');
    if (!area) return;
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList.contains('msg-group') || node.classList.contains('msg-continue')) {
            injectPublishButton(node, channelId);
          }
          node.querySelectorAll<HTMLElement>('.msg-group, .msg-continue').forEach(n => injectPublishButton(n, channelId));
        }
      }
    });
    obs.observe(area, { childList: true, subtree: true });
  });

  BridgeRegistry.register('injectAnnouncementHeader', (cid: unknown, type: unknown) =>
    injectAnnouncementHeader(cid as string, type as string));

})();
