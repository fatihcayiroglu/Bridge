// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BridgeUiSelectPanel.svelte
//              client/js/core/bridge-ui-select-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bridge-ui-select.ts
// Sprint 105: discord-ui-kit.ts parçalandı — Select Menu bileşeni
// Kullanım: BridgeUI.select({ options, value, placeholder, onChange })

'use strict';

export const BridgeUISelect = {
  create({ options = [], value = '', placeholder = 'Seçiniz...', onChange = null, id = '', multiple = false, maxValues = 1, disabled = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `dui-select${disabled ? ' dui-select--disabled' : ''}`;
    if (id) wrap.id = id;

    // Seçili değerleri takip et
    const selected = new Set(value ? [value] : []);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dui-select__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.disabled = disabled;

    const triggerContent = document.createElement('span');
    triggerContent.className = 'dui-select__value';
    triggerContent.textContent = placeholder;

    const arrow = document.createElement('span');
    arrow.className = 'dui-select__arrow';
    arrow.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;

    trigger.appendChild(triggerContent);
    trigger.appendChild(arrow);

    const dropdown = document.createElement('div');
    dropdown.className = 'dui-select__dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.hidden = true;

    function updateTrigger() {
      const selOpts = options.filter(o => selected.has(o.value));
      if (selOpts.length === 0) {
        triggerContent.textContent = placeholder;
        triggerContent.classList.remove('dui-select__value--filled');
      } else {
        triggerContent.innerHTML = selOpts.map(o =>
          `${o.emoji ? `<span aria-hidden="true">${o.emoji}</span> ` : ''}${escHtml ? escHtml(o.label) : o.label}`
        ).join(', ');
        triggerContent.classList.add('dui-select__value--filled');
      }
    }

    function renderOptions() {
      dropdown.innerHTML = '';
      options.forEach(opt => {
        if (opt.type === 'divider') {
          const div = document.createElement('div');
          div.className = 'dui-select__divider';
          if (opt.label) {
            const span = document.createElement('span');
            span.textContent = opt.label;
            div.appendChild(span);
          }
          dropdown.appendChild(div);
          return;
        }

        const item = document.createElement('div');
        item.className = `dui-select__option${selected.has(opt.value) ? ' dui-select__option--selected' : ''}${opt.disabled ? ' dui-select__option--disabled' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', selected.has(opt.value));
        item.dataset.value = opt.value;

        let html = '';
        if (opt.emoji) html += `<span class="dui-select__opt-emoji" aria-hidden="true">${opt.emoji}</span>`;
        html += `<div class="dui-select__opt-text"><span class="dui-select__opt-label">${opt.label}</span>`;
        if (opt.description) html += `<span class="dui-select__opt-desc">${opt.description}</span>`;
        html += '</div>';
        if (selected.has(opt.value)) html += `<span class="dui-select__opt-check" aria-hidden="true">✓</span>`;

        item.innerHTML = html;
        if (!opt.disabled) {
          item.addEventListener('click', () => {
            if (multiple) {
              if (selected.has(opt.value)) selected.delete(opt.value);
              else if (selected.size < maxValues) selected.add(opt.value);
            } else {
              selected.clear();
              selected.add(opt.value);
              close();
            }
            updateTrigger();
            renderOptions();
            onChange?.([...selected], opt.value);
          });
        }
        dropdown.appendChild(item);
      });
    }

    function open() {
      dropdown.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.classList.add('dui-select--open');
      // Ekranın dışına taşarsa yukarı aç
      const rect = wrap.getBoundingClientRect();
      if (rect.bottom + 240 > window.innerHeight) dropdown.classList.add('dui-select__dropdown--up');
      else dropdown.classList.remove('dui-select__dropdown--up');
    }

    function close() {
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('dui-select--open');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropdown.hidden) { renderOptions(); open(); } else close();
    });

    // Dışarı tıklayınca kapat
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    // Klavye navigasyonu
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (dropdown.hidden) { renderOptions(); open(); } else close(); }
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (dropdown.hidden) { renderOptions(); open(); }
        const items = [...dropdown.querySelectorAll('.dui-select__option:not(.dui-select__option--disabled)')];
        const focused = dropdown.querySelector('.dui-select__option--focused') || items[0];
        items.forEach(i => i.classList.remove('dui-select__option--focused'));
        const idx = items.indexOf(focused);
        const next = e.key === 'ArrowDown' ? items[idx + 1] || items[0] : items[idx - 1] || items[items.length - 1];
        next?.classList.add('dui-select__option--focused');
        next?.scrollIntoView({ block: 'nearest' });
      }
    });

    renderOptions();
    updateTrigger();
    wrap.appendChild(trigger);
    wrap.appendChild(dropdown);

    wrap.getValue = () => multiple ? [...selected] : [...selected][0] || '';
    wrap.setValue = (v) => { selected.clear(); if (v) (Array.isArray(v) ? v : [v]).forEach(x => selected.add(x)); updateTrigger(); renderOptions(); };
    wrap.setOptions = (opts) => { options.splice(0, options.length, ...opts); renderOptions(); updateTrigger(); };

    return wrap;
  },
};

/* ══════════════════════════════════════════════════════════════
   BADGE BİLEÅENİ
   Kullanım: BridgeUI.badge({ text, color, size })
   color: 'blurple' | 'green' | 'red' | 'yellow' | 'gray' | custom hex
══════════════════════════════════════════════════════════════ */
