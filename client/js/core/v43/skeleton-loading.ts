// client/js/core/v43/skeleton-loading.js
// ModÃ¼l: Skeleton Loading â€” kanal deÄŸiÅŸtirirken animasyonlu placeholder
// CSS: client/css/modules/transitions-fx.css â€” .skeleton-msg, .skeleton-line vb.
'use strict';

const SKELETON_COUNT = 7;  // KaÃ§ placeholder mesaj gÃ¶sterilsin

/**
 * messages-area iÃ§ine animasyonlu skeleton mesajlar ekler.
 * GerÃ§ek mesajlar yÃ¼klenince otomatik silinir (caller area.innerHTML = '' yapÄ±yor).
 */
function showSkeletonLoader(count = SKELETON_COUNT) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = '';

  for (let i = 0; i < count; i++) {
    const isGroupStart = (i === 0) || (i % 3 === 0);
    const lineCount    = 1 + (Math.random() > 0.5 ? 1 : 0);  // 1 veya 2 satÄ±r
    const firstWidth   = 40 + (Math.random() * 40 | 0);       // %40â€“80
    const secondWidth  = 15 + (Math.random() * 25 | 0);       // %15â€“40

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
 * Skeleton'larÄ± kaldÄ±r ve fade-in animasyonu ile gerÃ§ek mesajlarÄ± gÃ¶ster.
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

// â”€â”€ loadChannelMessages monkey-patch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _origLoadChannelMessages = window.loadChannelMessages;
if (typeof window.loadChannelMessages === 'function') {
  window.loadChannelMessages = async function(channelId, ...rest) {
    showSkeletonLoader();
    try {
      const result = await _origLoadChannelMessages.apply(this, [channelId, ...rest]);
      // KÄ±sa gecikme â€” DOM render iÃ§in fÄ±rsat ver
      requestAnimationFrame(hideSkeletonLoader);
      return result;
    } catch (err) {
      // Hata durumunda skeleton'Ä± kaldÄ±r
      const area = document.getElementById('messages-area');
      if (area) area.innerHTML = '<div style="padding:24px;color:var(--text-3);text-align:center;">Mesajlar yÃ¼klenemedi</div>';
      throw err;
    }
  };
}

// â”€â”€ Kanal geÃ§iÅŸini dinle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
document.addEventListener('bridge:channel-selected', () => {
  // YÃ¼kleme baÅŸlamadan Ã¶nce skeleton'Ä± hemen gÃ¶ster
  const area = document.getElementById('messages-area');
  if (area && area.children.length < 3) showSkeletonLoader();
});

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window._bridgeSkeleton = { show: showSkeletonLoader, hide: hideSkeletonLoader };

