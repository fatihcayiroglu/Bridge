// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ServerEventsPanel.svelte
//              client/js/core/server-events-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/server-events.ts
// Sprint 95 — Sunucu Etkinlikleri UI
//
// Özellikler:
//   - Sol panelde "📅 Etkinlikler" butonu (sunucu seçiliyken görünür)
//   - Modal: etkinlik listesi, detay, RSVP
//   - Admin için etkinlik oluşturma formu
//   - Socket: server:event:created / updated / deleted / rsvp anlık güncelleme
//   - Yaklaşan etkinlik için kanal başlığı altında mini banner

import { BridgeRegistry }  from './bridge-registry.js';
import { apiFetch }        from './api-fetch.js';
import { getAPI, getMe, getCurrentServer } from './globals.js';
import { escHtml, toast }  from './utils.js';
import { createLogger }    from './logger.js';

const log = createLogger('ServerEvents');

// ── Tipler ────────────────────────────────────────────────────────────────────

interface ServerEvent {
  id:                   string;
  server_id:            string;
  creator_id:           string;
  title:                string;
  description:          string | null;
  location:             string | null;
  channel_id:           string | null;
  starts_at:            string;
  ends_at:              string | null;
  status:               'scheduled' | 'active' | 'ended' | 'cancelled';
  cover_image:          string | null;
  creator_username?:    string;
  creator_display_name?: string;
  creator_avatar?:      string;
  rsvp_count?:          number;
  my_rsvp?:             'interested' | 'going' | 'not_going' | null;
}

// ── State ──────────────────────────────────────────────────────────────────────

let _events: ServerEvent[] = [];
let _modalOpen  = false;
let _detailId:  string | null = null;

// ── API yardımcıları ──────────────────────────────────────────────────────────

async function _loadEvents(serverId: string, filter = 'upcoming'): Promise<ServerEvent[]> {
  try {
    const r = await apiFetch(
      `${getAPI()}/api/v1/servers/${serverId}/events?filter=${filter}&limit=20`
    );
    if (!r.ok) throw new Error('fetch failed');
    const data = await r.json();
    _events = data.events ?? [];
    return _events;
  } catch (e) {
    log.warn('loadEvents error', e);
    return [];
  }
}

async function _rsvp(serverId: string, eventId: string, status: string): Promise<void> {
  await apiFetch(`${getAPI()}/api/v1/servers/${serverId}/events/${eventId}/rsvp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

async function _cancelRsvp(serverId: string, eventId: string): Promise<void> {
  await apiFetch(`${getAPI()}/api/v1/servers/${serverId}/events/${eventId}/rsvp`, {
    method: 'DELETE',
  });
}

async function _createEvent(serverId: string, data: Partial<ServerEvent>): Promise<ServerEvent | null> {
  try {
    const r = await apiFetch(`${getAPI()}/api/v1/servers/${serverId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) { toast('Etkinlik oluşturulamadı', 'error'); return null; }
    const { event } = await r.json();
    return event;
  } catch { return null; }
}

async function _deleteEvent(serverId: string, eventId: string): Promise<boolean> {
  const r = await apiFetch(`${getAPI()}/api/v1/servers/${serverId}/events/${eventId}`, {
    method: 'DELETE',
  });
  return r.ok;
}

// ── Tarih formatlama ──────────────────────────────────────────────────────────

function _fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('tr-TR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function _relative(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'Başladı';
  const m = Math.floor(diff / 60000);
  if (m < 60)   return `${m} dakika sonra`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h} saat sonra`;
  return `${Math.floor(h / 24)} gün sonra`;
}

// ── Render: etkinlik kartı ────────────────────────────────────────────────────

function _renderCard(ev: ServerEvent): string {
  const coverStyle = ev.cover_image
    ? `background-image:url(${escHtml(ev.cover_image)});background-size:cover;background-position:center;`
    : 'background:var(--bg-3);';

  const rsvpCount = ev.rsvp_count ?? 0;
  const myRsvp    = ev.my_rsvp;

  const rsvpLabel = myRsvp === 'going'       ? '✅ Katılıyorum'
                  : myRsvp === 'interested'  ? '⭐ İlgileniyorum'
                  : myRsvp === 'not_going'   ? '❌ Katılmıyorum'
                  : '+ RSVP';

  return `
    <div class="event-card" data-event-id="${escHtml(ev.id)}" role="button" tabindex="0"
         aria-label="${escHtml(ev.title)} etkinliğine tıkla">
      <div class="event-card__cover" style="${coverStyle}">
        ${ev.status === 'active' ? '<span class="event-badge event-badge--live">🔴 Canlı</span>' : ''}
      </div>
      <div class="event-card__body">
        <div class="event-card__time">${_relative(ev.starts_at)}</div>
        <div class="event-card__title">${escHtml(ev.title)}</div>
        ${ev.location ? `<div class="event-card__location">📍 ${escHtml(ev.location)}</div>` : ''}
        <div class="event-card__meta">
          <span class="event-card__rsvp-count">👥 ${rsvpCount} kişi</span>
          <button class="btn btn-sm event-rsvp-btn ${myRsvp ? 'event-rsvp-btn--active' : ''}"
                  data-event-id="${escHtml(ev.id)}"
                  aria-pressed="${myRsvp ? 'true' : 'false'}">
            ${rsvpLabel}
          </button>
        </div>
      </div>
    </div>`;
}

// ── Render: etkinlik listesi modal ────────────────────────────────────────────

function _renderListModal(serverId: string): string {
  const me = getMe() as { id?: string } | null;
  const server = getCurrentServer() as { ownerId?: string; myPerms?: Record<string, boolean> } | null;
  const canManage = !!(server?.ownerId === me?.id || server?.myPerms?.ADMINISTRATOR || server?.myPerms?.MANAGE_EVENTS);

  const upcoming = _events.filter(e => new Date(e.starts_at) >= new Date() || e.status === 'active');
  const past     = _events.filter(e => new Date(e.starts_at) < new Date()  && e.status !== 'active');

  return `
    <div class="modal-backdrop" id="events-modal-backdrop" role="dialog" aria-modal="true" aria-label="Sunucu Etkinlikleri">
      <div class="modal events-modal">
        <div class="modal-header">
          <h2>📅 Etkinlikler</h2>
          <button class="modal-close" id="events-modal-close" aria-label="Kapat">✕</button>
        </div>
        <div class="modal-body events-modal__body">
          ${canManage ? `
          <button class="btn btn-primary events-create-btn" id="events-create-btn">
            + Etkinlik Oluştur
          </button>` : ''}

          <div class="events-section">
            <h3 class="events-section__title">Yaklaşan (${upcoming.length})</h3>
            ${upcoming.length
              ? upcoming.map(_renderCard).join('')
              : '<p class="events-empty">Henüz etkinlik yok.</p>'}
          </div>

          ${past.length ? `
          <details class="events-section events-section--past">
            <summary class="events-section__title">Geçmiş (${past.length})</summary>
            ${past.map(_renderCard).join('')}
          </details>` : ''}
        </div>
      </div>
    </div>`;
}

// ── Render: etkinlik oluşturma formu ─────────────────────────────────────────

function _renderCreateForm(serverId: string): string {
  const minDate = new Date(Date.now() + 60000).toISOString().slice(0, 16);
  return `
    <div class="modal-backdrop" id="event-create-backdrop" role="dialog" aria-modal="true" aria-label="Etkinlik Oluştur">
      <div class="modal event-create-modal">
        <div class="modal-header">
          <h2>📅 Etkinlik Oluştur</h2>
          <button class="modal-close" id="event-create-close" aria-label="Kapat">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="ev-title">Başlık *</label>
            <input class="form-input" id="ev-title" maxlength="100" placeholder="Etkinlik adı" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="ev-desc">Açıklama</label>
            <textarea class="form-input" id="ev-desc" rows="3" maxlength="1000" placeholder="Etkinlik hakkında…"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label" for="ev-location">Konum / Bağlantı</label>
            <input class="form-input" id="ev-location" maxlength="200" placeholder="Adres veya link">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="ev-start">Başlangıç *</label>
              <input class="form-input" type="datetime-local" id="ev-start" min="${minDate}" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="ev-end">Bitiş</label>
              <input class="form-input" type="datetime-local" id="ev-end" min="${minDate}">
            </div>
          </div>
          <div class="form-actions">
            <button class="btn" id="ev-cancel-btn">İptal</button>
            <button class="btn btn-primary" id="ev-submit-btn">Oluştur</button>
          </div>
        </div>
      </div>
    </div>`;
}

// ── Modal yönetimi ────────────────────────────────────────────────────────────

async function openEventsModal(): Promise<void> {
  if (_modalOpen) return;
  const server = getCurrentServer() as { _id?: string } | null;
  if (!server?._id) { toast('Önce bir sunucu seç', 'error'); return; }

  _modalOpen = true;
  await _loadEvents(server._id);

  const wrap = document.createElement('div');
  wrap.id = 'events-modal-wrap';
  wrap.innerHTML = _renderListModal(server._id);
  document.body.appendChild(wrap);

  _bindListEvents(server._id, wrap);
}

function closeEventsModal(): void {
  document.getElementById('events-modal-wrap')?.remove();
  _modalOpen  = false;
  _detailId   = null;
}

function _bindListEvents(serverId: string, container: HTMLElement): void {
  container.querySelector('#events-modal-close')?.addEventListener('click', closeEventsModal);
  container.querySelector('#events-modal-backdrop')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'events-modal-backdrop') closeEventsModal();
  });

  container.querySelector('#events-create-btn')?.addEventListener('click', () => {
    closeEventsModal();
    openCreateModal(serverId);
  });

  // Kart tıklama (detay)
  container.querySelectorAll<HTMLElement>('.event-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.event-rsvp-btn')) return;
      const eid = card.dataset.eventId;
      if (eid) _openDetail(serverId, eid);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const eid = card.dataset.eventId;
        if (eid) _openDetail(serverId, eid);
      }
    });
  });

  // RSVP butonları
  container.querySelectorAll<HTMLButtonElement>('.event-rsvp-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const eid = btn.dataset.eventId;
      if (!eid) return;
      _handleRsvpClick(serverId, eid, btn);
    });
  });
}

async function _handleRsvpClick(serverId: string, eventId: string, btn: HTMLButtonElement): Promise<void> {
  const ev = _events.find(e => e.id === eventId);
  if (!ev) return;

  // Mini dropdown
  const existing = document.getElementById('rsvp-dropdown');
  if (existing) { existing.remove(); return; }

  const options: Array<{ label: string; value: string }> = [
    { label: '✅ Katılıyorum',    value: 'going' },
    { label: '⭐ İlgileniyorum', value: 'interested' },
    { label: '❌ Katılmıyorum',  value: 'not_going' },
  ];
  if (ev.my_rsvp) options.push({ label: '🗑 RSVP İptal', value: '__cancel__' });

  const rect = btn.getBoundingClientRect();
  const dd   = document.createElement('div');
  dd.id        = 'rsvp-dropdown';
  dd.className = 'rsvp-dropdown';
  dd.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;z-index:9999;`;
  dd.innerHTML = options.map(o =>
    `<button class="rsvp-dropdown__item" data-value="${o.value}">${o.label}</button>`
  ).join('');
  document.body.appendChild(dd);

  dd.querySelectorAll<HTMLButtonElement>('.rsvp-dropdown__item').forEach(item => {
    item.addEventListener('click', async () => {
      dd.remove();
      const val = item.dataset.value!;
      try {
        if (val === '__cancel__') {
          await _cancelRsvp(serverId, eventId);
          ev.my_rsvp = null;
          ev.rsvp_count = Math.max(0, (ev.rsvp_count ?? 1) - 1);
        } else {
          await _rsvp(serverId, eventId, val);
          if (!ev.my_rsvp) ev.rsvp_count = (ev.rsvp_count ?? 0) + 1;
          ev.my_rsvp = val as ServerEvent['my_rsvp'];
        }
        // Re-render
        const wrap = document.getElementById('events-modal-wrap');
        if (wrap) {
          wrap.innerHTML = _renderListModal(serverId);
          _bindListEvents(serverId, wrap);
        }
      } catch { toast('RSVP hatası', 'error'); }
    });
  });

  document.addEventListener('click', () => dd.remove(), { once: true, capture: true });
}

async function _openDetail(serverId: string, eventId: string): Promise<void> {
  const ev = _events.find(e => e.id === eventId);
  if (!ev) return;

  const html = `
    <div class="modal-backdrop" id="event-detail-backdrop">
      <div class="modal event-detail-modal">
        <div class="modal-header">
          <button class="btn btn-sm" id="event-detail-back">← Geri</button>
          <h2>${escHtml(ev.title)}</h2>
          <button class="modal-close" id="event-detail-close">✕</button>
        </div>
        <div class="modal-body">
          ${ev.cover_image ? `<img src="${escHtml(ev.cover_image)}" class="event-detail__cover" alt="">` : ''}
          <div class="event-detail__time">🕐 ${_fmtDate(ev.starts_at)}${ev.ends_at ? ` — ${_fmtDate(ev.ends_at)}` : ''}</div>
          ${ev.location ? `<div class="event-detail__location">📍 ${escHtml(ev.location)}</div>` : ''}
          ${ev.description ? `<div class="event-detail__desc">${escHtml(ev.description)}</div>` : ''}
          <div class="event-detail__creator">
            Oluşturan: <strong>${escHtml(ev.creator_display_name ?? ev.creator_username ?? '?')}</strong>
          </div>
          <div class="event-detail__rsvp">
            <strong>👥 ${ev.rsvp_count ?? 0} kişi katılıyor/ilgileniyor</strong>
          </div>
        </div>
      </div>
    </div>`;

  const wrap = document.getElementById('events-modal-wrap')!;
  const prev = wrap.innerHTML;
  wrap.innerHTML = html;

  wrap.querySelector('#event-detail-back')?.addEventListener('click', () => {
    wrap.innerHTML = prev;
    _bindListEvents(serverId, wrap);
  });
  wrap.querySelector('#event-detail-close')?.addEventListener('click', closeEventsModal);
}

async function openCreateModal(serverId: string): Promise<void> {
  const wrap = document.createElement('div');
  wrap.id = 'event-create-wrap';
  wrap.innerHTML = _renderCreateForm(serverId);
  document.body.appendChild(wrap);

  const close = () => wrap.remove();

  wrap.querySelector('#event-create-close')?.addEventListener('click', close);
  wrap.querySelector('#ev-cancel-btn')?.addEventListener('click', close);
  wrap.querySelector('#event-create-backdrop')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'event-create-backdrop') close();
  });

  wrap.querySelector('#ev-submit-btn')?.addEventListener('click', async () => {
    const title    = (wrap.querySelector('#ev-title')    as HTMLInputElement)?.value.trim();
    const desc     = (wrap.querySelector('#ev-desc')     as HTMLTextAreaElement)?.value.trim();
    const location = (wrap.querySelector('#ev-location') as HTMLInputElement)?.value.trim();
    const startsAt = (wrap.querySelector('#ev-start')    as HTMLInputElement)?.value;
    const endsAt   = (wrap.querySelector('#ev-end')      as HTMLInputElement)?.value;

    if (!title || !startsAt) { toast('Başlık ve başlangıç tarihi zorunlu', 'error'); return; }

    const btn = wrap.querySelector('#ev-submit-btn') as HTMLButtonElement;
    btn.disabled     = true;
    btn.textContent  = 'Oluşturuluyor…';

    const event = await _createEvent(serverId, {
      title,
      description:  desc   || undefined,
      location:     location || undefined,
      starts_at:    new Date(startsAt).toISOString(),
      ends_at:      endsAt  ? new Date(endsAt).toISOString() : undefined,
    } as Partial<ServerEvent>);

    if (event) {
      toast('✅ Etkinlik oluşturuldu', 'success');
      close();
      openEventsModal();
    } else {
      btn.disabled    = false;
      btn.textContent = 'Oluştur';
    }
  });
}

// ── Yaklaşan etkinlik banner'ı ────────────────────────────────────────────────

function _updateUpcomingBanner(): void {
  const server = getCurrentServer() as { _id?: string } | null;
  if (!server?._id) return;

  const next = _events
    .filter(e => e.status === 'scheduled' || e.status === 'active')
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())[0];

  const existing = document.getElementById('upcoming-event-banner');

  if (!next) { existing?.remove(); return; }

  if (!existing) {
    const banner = document.createElement('div');
    banner.id         = 'upcoming-event-banner';
    banner.className  = 'upcoming-event-banner';
    banner.setAttribute('role', 'note');
    banner.innerHTML = `
      <span class="upcoming-event-banner__icon">${next.status === 'active' ? '🔴' : '📅'}</span>
      <span class="upcoming-event-banner__text">
        <strong>${escHtml(next.title)}</strong> — ${_relative(next.starts_at)}
      </span>
      <button class="upcoming-event-banner__btn btn btn-sm" id="banner-rsvp-btn">Detay</button>`;

    const chatArea = document.getElementById('chat-area') ?? document.getElementById('messages-area')?.parentElement;
    chatArea?.insertAdjacentElement('afterbegin', banner);

    document.getElementById('banner-rsvp-btn')?.addEventListener('click', openEventsModal);
  } else {
    existing.querySelector('.upcoming-event-banner__text')!.innerHTML =
      `<strong>${escHtml(next.title)}</strong> — ${_relative(next.starts_at)}`;
  }
}

// ── Sol panel butonu ──────────────────────────────────────────────────────────

function _injectSidebarButton(): void {
  if (document.getElementById('events-sidebar-btn')) return;

  const btn = document.createElement('button');
  btn.id           = 'events-sidebar-btn';
  btn.className    = 'sidebar-events-btn';
  btn.title        = 'Sunucu Etkinlikleri';
  btn.setAttribute('aria-label', 'Sunucu etkinliklerini aç');
  btn.textContent  = '📅';
  btn.addEventListener('click', openEventsModal);

  // Kanal listesi üst kısmına veya server toolbar'a ekle
  const toolbar = document.querySelector('.server-toolbar') ?? document.querySelector('.channel-list-header');
  toolbar?.appendChild(btn);
}

// ── Socket entegrasyonu ───────────────────────────────────────────────────────

function _installSocketListeners(): void {
  const socket = BridgeRegistry.get('socket') as {
    on(ev: string, cb: (...a: unknown[]) => void): void;
  } | null;
  if (!socket) { setTimeout(_installSocketListeners, 500); return; }

  socket.on('server:event:created', (data: unknown) => {
    const { event } = data as { event: ServerEvent };
    if (!_events.find(e => e.id === event.id)) _events.unshift(event);
    _updateUpcomingBanner();
    // Modaldaki liste açıksa güncelle
    const wrap = document.getElementById('events-modal-wrap');
    const server = getCurrentServer() as { _id?: string } | null;
    if (wrap && server?._id) {
      wrap.innerHTML = _renderListModal(server._id);
      _bindListEvents(server._id, wrap);
    }
  });

  socket.on('server:event:updated', (data: unknown) => {
    const { event } = data as { event: ServerEvent };
    const idx = _events.findIndex(e => e.id === event.id);
    if (idx >= 0) _events[idx] = { ..._events[idx], ...event };
    _updateUpcomingBanner();
  });

  socket.on('server:event:deleted', (data: unknown) => {
    const { eventId } = data as { eventId: string };
    _events = _events.filter(e => e.id !== eventId);
    _updateUpcomingBanner();
  });

  socket.on('server:event:rsvp', (data: unknown) => {
    const { eventId, userId, status, count } = data as {
      eventId: string; userId: string; status: string | null; count?: number;
    };
    const ev = _events.find(e => e.id === eventId);
    if (!ev) return;
    const me = getMe() as { id?: string } | null;
    if (userId === me?.id) ev.my_rsvp = status as ServerEvent['my_rsvp'];
    if (count !== undefined) ev.rsvp_count = count;
  });
}

// ── Kanal değişiminde banner güncelle ─────────────────────────────────────────

BridgeRegistry.register('onChannelChange', (channelId: unknown) => {
  _updateUpcomingBanner();
});

// ── Public API ────────────────────────────────────────────────────────────────

BridgeRegistry.register('openEventsModal',  openEventsModal);
BridgeRegistry.register('closeEventsModal', closeEventsModal);
BridgeRegistry.register('loadServerEvents', _loadEvents);

// ── Init ──────────────────────────────────────────────────────────────────────

function _init(): void {
  _injectSidebarButton();
  _installSocketListeners();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}

export const serverEventsReady = true;
