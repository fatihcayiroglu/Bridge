// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SkeletonLoadingPanel.svelte
//              client/js/core/skeleton-loading-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/skeleton-loading.ts
// Skeleton Loading — kanal değiştirirken animasyonlu placeholder

import { BridgeRegistry } from './bridge-registry.js';

const SKELETON_COUNT = 7;

export function showSkeletonLoader(count = SKELETON_COUNT): void {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = '';

  for (let i = 0; i < count; i++) {
    const isGroupStart = i === 0 || i % 3 === 0;
    const lineCount    = 1 + (Math.random() > 0.5 ? 1 : 0);
    const firstWidth   = 40 + Math.floor(Math.random() * 40);
    const secondWidth  = 15 + Math.floor(Math.random() * 25);
    area.insertAdjacentHTML('beforeend', `
      <div class="${isGroupStart ? 'skeleton-msg' : 'skeleton-continue'}">
        ${isGroupStart
          ? '<div class="skeleton-avatar"></div>'
          : '<div class="skeleton-avatar-placeholder"></div>'}
        <div class="skeleton-body">
          ${isGroupStart ? `<div class="skeleton-name" style="width:${60 + Math.floor(Math.random() * 60)}px"></div>` : ''}
          <div class="skeleton-line" style="width:${firstWidth}%"></div>
          ${lineCount > 1 ? `<div class="skeleton-line" style="width:${secondWidth}%"></div>` : ''}
        </div>
      </div>`);
  }
}

export function hideSkeletonLoader(): void {
  const area = document.getElementById('messages-area');
  if (!area) return;
  const realMsgs = [...area.children].filter(
    el => !el.classList.contains('skeleton-msg') && !el.classList.contains('skeleton-continue')
  ) as HTMLElement[];
  realMsgs.forEach((el, i) => {
    el.style.opacity    = '0';
    el.style.transition = `opacity .15s ease ${i * 12}ms`;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  });
}

// Wrap loadChannelMessages
BridgeRegistry.wrap('loadChannelMessages', async (orig?: Function, ...args: unknown[]) => {
  showSkeletonLoader();
  try {
    const result = orig ? await orig(...args) : undefined;
    requestAnimationFrame(hideSkeletonLoader);
    return result;
  } catch (err) {
    const area = document.getElementById('messages-area');
    if (area) area.innerHTML = '<div style="padding:24px;color:var(--text-3);text-align:center;">Mesajlar yüklenemedi</div>';
    throw err;
  }
});

document.addEventListener('bridge:channel-selected', () => {
  const area = document.getElementById('messages-area');
  if (area && area.children.length < 3) showSkeletonLoader();
});

BridgeRegistry.register('showSkeletonLoader', showSkeletonLoader);
BridgeRegistry.register('hideSkeletonLoader', hideSkeletonLoader);
