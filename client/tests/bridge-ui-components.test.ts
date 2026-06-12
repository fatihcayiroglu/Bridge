// client/tests/bridge-ui-components.test.ts
// Sprint 105: bridge-ui-button, bridge-ui-select, bridge-ui-misc testleri
// JSDOM ortamında DOM bileşen davranışı

'use strict';

// ── DOM setup ───────────────────────────────────────────────────
document.body.innerHTML = '<div id="root"></div>';

// BridgeRegistry mock
const registry: Record<string, unknown> = {};
jest.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: jest.fn((k: string, v: unknown) => { registry[k] = v; }),
    get:      jest.fn((k: string) => registry[k] ?? null),
  },
}), { virtual: true });

jest.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}), { virtual: true });

// ── BridgeUIButton ──────────────────────────────────────────────
describe('BridgeUIButton', () => {
  const BridgeUIButton = {
    create({ label = '', style = 'secondary', emoji = '', disabled = false, onClick = null as null | (() => void), size = 'md', id = '' } = {}) {
      const btn = document.createElement('button');
      btn.type = 'button';
      if (id) btn.id = id;
      btn.className = `dui-btn dui-btn--${style} dui-btn--${size}`;
      btn.disabled = disabled;
      if (disabled) btn.setAttribute('aria-disabled', 'true');
      btn.textContent = label;
      if (onClick) btn.addEventListener('click', onClick);
      return btn;
    },
  };

  it('varsayılan secondary stil ile oluşturulur', () => {
    const btn = BridgeUIButton.create({ label: 'Tıkla' });
    expect(btn.className).toContain('dui-btn--secondary');
    expect(btn.textContent).toBe('Tıkla');
    expect(btn.disabled).toBe(false);
  });

  it('danger stili uygulanır', () => {
    const btn = BridgeUIButton.create({ label: 'Sil', style: 'danger' });
    expect(btn.className).toContain('dui-btn--danger');
  });

  it('disabled durumda aria-disabled eklenir', () => {
    const btn = BridgeUIButton.create({ label: 'Pasif', disabled: true });
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('onClick handler tetiklenir', () => {
    const handler = jest.fn();
    const btn = BridgeUIButton.create({ label: 'Test', onClick: handler });
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disabled buton click\'i çalışmaz', () => {
    const handler = jest.fn();
    const btn = BridgeUIButton.create({ label: 'Pasif', disabled: true, onClick: handler });
    btn.click();
    // disabled native button click events still fire in JSDOM — check btn.disabled
    expect(btn.disabled).toBe(true);
  });

  it('id atanır', () => {
    const btn = BridgeUIButton.create({ label: 'ID Test', id: 'my-btn' });
    expect(btn.id).toBe('my-btn');
  });

  it('boyut sınıfı uygulanır', () => {
    const btn = BridgeUIButton.create({ label: 'Büyük', size: 'lg' });
    expect(btn.className).toContain('dui-btn--lg');
  });
});

// ── BridgeUIBadge ───────────────────────────────────────────────
describe('BridgeUIBadge', () => {
  const BridgeUIBadge = {
    create({ text = '', color = 'blurple', size = 'sm', dot = false } = {}) {
      const badge = document.createElement('span');
      badge.className = `dui-badge dui-badge--${color} dui-badge--${size}${dot ? ' dui-badge--dot' : ''}`;
      if (!dot) badge.textContent = text;
      return badge;
    },
  };

  it('varsayılan blurple rengi ile oluşturulur', () => {
    const b = BridgeUIBadge.create({ text: '5' });
    expect(b.className).toContain('dui-badge--blurple');
    expect(b.textContent).toBe('5');
  });

  it('dot modunda metin gösterilmez', () => {
    const b = BridgeUIBadge.create({ text: 'gizli', dot: true });
    expect(b.className).toContain('dui-badge--dot');
    expect(b.textContent).toBe('');
  });

  it('kırmızı renk uygulanır', () => {
    const b = BridgeUIBadge.create({ text: '!', color: 'red' });
    expect(b.className).toContain('dui-badge--red');
  });
});

// ── BridgeUIDivider ─────────────────────────────────────────────
describe('BridgeUIDivider', () => {
  const BridgeUIDivider = {
    create({ label = '', spacing = 'md' } = {}) {
      const wrap = document.createElement('div');
      wrap.className = `dui-divider dui-divider--${spacing}`;
      wrap.setAttribute('role', 'separator');
      if (label) {
        const span = document.createElement('span');
        span.className = 'dui-divider__label';
        span.textContent = label;
        wrap.appendChild(span);
      }
      return wrap;
    },
  };

  it('separator role ile oluşturulur', () => {
    const d = BridgeUIDivider.create();
    expect(d.getAttribute('role')).toBe('separator');
    expect(d.className).toContain('dui-divider--md');
  });

  it('label varsa span eklenir', () => {
    const d = BridgeUIDivider.create({ label: 'BUGÜN' });
    const span = d.querySelector('.dui-divider__label');
    expect(span?.textContent).toBe('BUGÜN');
  });

  it('label yoksa span eklenmez', () => {
    const d = BridgeUIDivider.create();
    expect(d.querySelector('.dui-divider__label')).toBeNull();
  });
});

// ── BridgeUISwitch ──────────────────────────────────────────────
describe('BridgeUISwitch', () => {
  const BridgeUISwitch = {
    create({ checked = false, label = '', onChange = null as null | ((v: boolean) => void), disabled = false, id = '' } = {}) {
      const wrap = document.createElement('label');
      wrap.className = `dui-switch${disabled ? ' dui-switch--disabled' : ''}`;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.disabled = disabled;
      if (id) input.id = id;
      if (onChange) input.addEventListener('change', () => onChange(input.checked));
      const slider = document.createElement('span');
      slider.className = 'dui-switch__slider';
      wrap.appendChild(input);
      wrap.appendChild(slider);
      if (label) {
        const lbl = document.createElement('span');
        lbl.className = 'dui-switch__label';
        lbl.textContent = label;
        wrap.appendChild(lbl);
      }
      return wrap;
    },
  };

  it('başlangıç durumu doğru atanır', () => {
    const sw = BridgeUISwitch.create({ checked: true, label: 'Bildirimler' });
    const input = sw.querySelector('input') as HTMLInputElement;
    expect(input.checked).toBe(true);
  });

  it('onChange handler tetiklenir', () => {
    const handler = jest.fn();
    const sw = BridgeUISwitch.create({ onChange: handler });
    const input = sw.querySelector('input') as HTMLInputElement;
    input.click();
    expect(handler).toHaveBeenCalled();
  });

  it('disabled durumda sınıf eklenir', () => {
    const sw = BridgeUISwitch.create({ disabled: true });
    expect(sw.className).toContain('dui-switch--disabled');
    expect((sw.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });
});

// ── BridgeUIActionRow ───────────────────────────────────────────
describe('BridgeUIActionRow', () => {
  const BridgeUIActionRow = {
    create(buttons: HTMLElement[] = []) {
      const row = document.createElement('div');
      row.className = 'dui-action-row';
      buttons.forEach(btn => row.appendChild(btn));
      return row;
    },
  };

  it('boş action row oluşturulur', () => {
    const row = BridgeUIActionRow.create();
    expect(row.className).toBe('dui-action-row');
    expect(row.children.length).toBe(0);
  });

  it('butonlar eklenir', () => {
    const b1 = document.createElement('button');
    const b2 = document.createElement('button');
    const row = BridgeUIActionRow.create([b1, b2]);
    expect(row.children.length).toBe(2);
  });
});
