// client/js/core/v43/skeleton-loading.js
// Modül: Skeleton Loading — kanal değiştirirken animasyonlu placeholder
// CSS: client/css/modules/transitions-fx.css — .skeleton-msg, .skeleton-line vb.
'use strict';

const SKELETON_COUNT = 7;  // Kaç placeholder mesaj gösterilsin

/**
 * messages-area içine animasyonlu skeleton mesajlar ekler.
 * Gerçek mesajlar yüklenince otomatik silinir (caller area.innerHTML = '' yapıyor).
 */
function showSkeletonLoader(count = SKELETON_COUNT) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = '';

  for (let i = 0; i < count; i++) {
    const isGroupStart = (i === 0) || (i % 3 === 0);
    const lineCount    = 1 + (Math.random() > 0.5 ? 1 : 0);  // 1 veya 2 satır
    const firstWidth   = 40 + (Math.random() * 40 | 0);       // %40–80
    const secondWidth  = 15 + (Math.random() * 25 | 0);       // %15–40

    const html = `
      <div class="${isGroupStart ? 'skeleton-msg' : 'skeleton-continue'}">
        ${isGroupStart
          ? '<div class="skeleton-avatar"></div>'
          : '<div class="skeleton-avatar-placeholder"></div>'}
        <div class="skeleton-body">
          ${isGroupStart ? `<div class="skeleton-name" style="width:${60 + (Math.random() * 60 | 0)}px"></div>` : ''}
          <div class="skeleton-line" style="width:${firstWidth}%"></div>
          ${lineCount > 1 ? `<div class="skeleton-line" style="width:${secondWidth}%"></div>` : ''}
        </div>
      </div>`;
    area.insertAdjacentHTML('beforeend', html);
  }
}

/**
 * Skeleton'ları kaldır ve fade-in animasyonu ile gerçek mesajları göster.
 */
function hideSkeletonLoader() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  // skeleton-msg/continue olmayan elementler varsa animasyon ekle
  const realMsgs = [...area.children].filter(
    el => !el.classList.contains('skeleton-msg') && !el.classList.contains('skeleton-continue')
  );
  realMsgs.forEach((el, i) => {
    el.style.opacity = '0';
    el.style.transition = `opacity .15s ease ${i * 12}ms`;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  });
}

// ── loadChannelMessages monkey-patch ────────────────────────
const _origLoadChannelMessages = window.loadChannelMessages;
if (typeof window.loadChannelMessages === 'function') {
  window.loadChannelMessages = async function(channelId, ...rest) {
    showSkeletonLoader();
    try {
      const result = await _origLoadChannelMessages.apply(this, [channelId, ...rest]);
      // Kısa gecikme — DOM render için fırsat ver
      requestAnimationFrame(hideSkeletonLoader);
      return result;
    } catch (err) {
      // Hata durumunda skeleton'ı kaldır
      const area = document.getElementById('messages-area');
      if (area) area.innerHTML = '<div style="padding:24px;color:var(--text-3);text-align:center;">Mesajlar yüklenemedi</div>';
      throw err;
    }
  };
}

// ── Kanal geçişini dinle ─────────────────────────────────────
document.addEventListener('bridge:channel-selected', () => {
  // Yükleme başlamadan önce skeleton'ı hemen göster
  const area = document.getElementById('messages-area');
  if (area && area.children.length < 3) showSkeletonLoader();
});

// ── Public API ───────────────────────────────────────────────
window._bridgeSkeleton = { show: showSkeletonLoader, hide: hideSkeletonLoader };
