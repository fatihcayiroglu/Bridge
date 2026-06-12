// client/js/core/ui/switch.ts
'use strict';

export const BridgeUISwitch = {
  create({ checked = false, onChange = null, id = '', label = '', disabled = false } = {}) {
    const wrap = document.createElement('label');
    wrap.className = `dui-switch${disabled ? ' dui-switch--disabled' : ''}`;
    if (id) wrap.htmlFor = `${id}-input`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'dui-switch__input';
    input.checked = checked;
    input.disabled = disabled;
    if (id) input.id = `${id}-input`;

    const track = document.createElement('span');
    track.className = 'dui-switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'dui-switch__thumb';
    track.appendChild(thumb);

    function sync() {
      track.style.background = input.checked ? 'var(--green, #43b581)' : 'var(--bg-3, #2f3136)';
      thumb.style.transform = input.checked ? 'translateX(20px)' : 'translateX(0)';
    }
    sync();

    input.addEventListener('change', () => { sync(); onChange?.(input.checked); });

    if (label) {
      const lbl = document.createElement('span');
      lbl.className = 'dui-switch__label';
      lbl.textContent = label;
      wrap.appendChild(input);
      wrap.appendChild(track);
      wrap.appendChild(lbl);
    } else {
      wrap.appendChild(input);
      wrap.appendChild(track);
    }

    wrap.getValue = () => input.checked;
    wrap.setValue = (v) => { input.checked = v; sync(); };
    return wrap;
  },
};
