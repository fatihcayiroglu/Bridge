// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BridgeUiButtonPanel.svelte
//              client/js/core/bridge-ui-button-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bridge-ui-button.ts
// Sprint 105: discord-ui-kit.ts parçalandı — Button bileşeni
// Kullanım: BridgeUI.button({ label, style, emoji, disabled, onClick })
// style: 'primary' | 'secondary' | 'danger' | 'success' | 'link' | 'ghost'

'use strict';

export const BridgeUIButton = {
  create({ label = '', style = 'secondary', emoji = '', disabled = false, onClick = null, size = 'md', id = '' } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (id) btn.id = id;
    btn.className = `dui-btn dui-btn--${style} dui-btn--${size}`;
    btn.disabled = disabled;
    if (disabled) btn.setAttribute('aria-disabled', 'true');

    const inner = document.createElement('span');
    inner.className = 'dui-btn__inner';
    if (emoji) {
      const em = document.createElement('span');
      em.className = 'dui-btn__emoji';
      em.textContent = emoji;
      em.setAttribute('aria-hidden', 'true');
      inner.appendChild(em);
    }
    const txt = document.createElement('span');
    txt.textContent = label;
    inner.appendChild(txt);
    btn.appendChild(inner);

    // Ripple efekti
    btn.addEventListener('pointerdown', (e) => {
      if (disabled) return;
      const rect = btn.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'dui-btn__ripple';
      const size = Math.max(rect.width, rect.height);
      ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });

    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  },
};
};
