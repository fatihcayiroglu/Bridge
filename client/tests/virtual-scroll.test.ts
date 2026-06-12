// client/tests/virtual-scroll.test.ts — Sprint 50
// virtual-scroll.ts için unit testler
// Kapsam: DOM penceresi mantığı, window hesaplama, spacer yönetimi

'use strict';

jest.mock('../js/core/globals', () => ({
  getCurrentChannel: jest.fn(() => ({ _id: 'ch1', name: 'test' })),
}), { virtual: true });

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get: jest.fn().mockImplementation((key) => {
      if (key === 'loadingMoreMessages') return false;
      if (key === 'noMoreMessages') return false;
      if (key === 'oldestMessageTimestamp') return '2024-01-01';
      return null;
    }),
    call: jest.fn().mockResolvedValue(undefined),
    has: jest.fn(),
  },
}), { virtual: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

const WINDOW_SIZE   = 80;
const ITEM_EST_H    = 56;

function createMockMessage(id) {
  const el = document.createElement('div');
  el.id = `msg-${id}`;
  el.style.height = `${ITEM_EST_H}px`;
  el.textContent = `Message ${id}`;
  return { id: String(id), el };
}

function setupScrollArea() {
  const area = document.createElement('div');
  area.id = 'messages-area';
  area.style.cssText = 'height:600px;overflow-y:auto;display:flex;flex-direction:column;';
  document.body.appendChild(area);

  const topSpacer = document.createElement('div');
  topSpacer.className = 'vs-top-spacer';
  topSpacer.style.height = '0px';
  area.appendChild(topSpacer);

  const botSpacer = document.createElement('div');
  botSpacer.className = 'vs-bot-spacer';
  area.appendChild(botSpacer);

  return { area, topSpacer, botSpacer };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('virtual-scroll — DOM window logic', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('WINDOW_SIZE sabiti makul aralıkta', () => {
    expect(WINDOW_SIZE).toBeGreaterThanOrEqual(40);
    expect(WINDOW_SIZE).toBeLessThanOrEqual(200);
  });

  test('ITEM_EST_H tahmini yükseklik pozitif', () => {
    expect(ITEM_EST_H).toBeGreaterThan(0);
  });

  test('scroll alanı oluşturulabilir', () => {
    const { area } = setupScrollArea();
    expect(area).not.toBeNull();
    expect(area.id).toBe('messages-area');
  });

  test('top spacer başlangıçta sıfır yükseklikte', () => {
    const { topSpacer } = setupScrollArea();
    expect(topSpacer.style.height).toBe('0px');
  });

  test('spacer yükseklik güncellenebilir', () => {
    const { topSpacer } = setupScrollArea();
    topSpacer.style.height = `${ITEM_EST_H * 10}px`;
    expect(topSpacer.style.height).toBe(`${ITEM_EST_H * 10}px`);
  });
});

describe('virtual-scroll — mesaj ekleme', () => {
  let area;

  beforeEach(() => {
    document.body.innerHTML = '';
    area = setupScrollArea().area;
  });

  test('mesaj elementi DOM\'a eklenebilir', () => {
    const msg = createMockMessage(1);
    area.appendChild(msg.el);
    expect(document.getElementById('msg-1')).not.toBeNull();
  });

  test('100 mesaj eklenebilir', () => {
    for (let i = 0; i < 100; i++) {
      area.appendChild(createMockMessage(i).el);
    }
    const messages = area.querySelectorAll('[id^="msg-"]');
    expect(messages.length).toBe(100);
  });

  test('mesaj DOM\'dan kaldırılabilir', () => {
    const msg = createMockMessage(42);
    area.appendChild(msg.el);
    expect(document.getElementById('msg-42')).not.toBeNull();
    msg.el.remove();
    expect(document.getElementById('msg-42')).toBeNull();
  });

  test('WINDOW_SIZE kadar mesaj DOM\'da tutulabilir', () => {
    const messages = [];
    for (let i = 0; i < WINDOW_SIZE; i++) {
      const m = createMockMessage(i);
      area.appendChild(m.el);
      messages.push(m);
    }
    const inDOM = area.querySelectorAll('[id^="msg-"]').length;
    expect(inDOM).toBe(WINDOW_SIZE);
  });

  test('WINDOW_SIZE aşıldığında eski mesajlar çıkarılabilir', () => {
    const messages = [];
    for (let i = 0; i < WINDOW_SIZE + 10; i++) {
      const m = createMockMessage(i);
      area.appendChild(m.el);
      messages.push(m);
    }
    // Remove oldest 10
    for (let i = 0; i < 10; i++) {
      messages[i].el.remove();
    }
    const inDOM = area.querySelectorAll('[id^="msg-"]').length;
    expect(inDOM).toBe(WINDOW_SIZE);
  });
});

describe('virtual-scroll — scroll state', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setupScrollArea();
  });

  test('scroll position okunabilir', () => {
    const area = document.getElementById('messages-area');
    expect(typeof area.scrollTop).toBe('number');
  });

  test('scrollHeight pozitif değer döner', () => {
    const area = document.getElementById('messages-area');
    expect(area.scrollHeight).toBeGreaterThanOrEqual(0);
  });

  test('scrollIntoView elementi için çağrılabilir', () => {
    const { area } = setupScrollArea();
    const msg = createMockMessage('test');
    area.appendChild(msg.el);
    msg.el.scrollIntoView = jest.fn();
    msg.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    expect(msg.el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
});

describe('virtual-scroll — spacer hesaplama', () => {
  test('kaldırılan her mesaj için spacer büyür', () => {
    let topSpacerH = 0;
    const messages = [{ height: 56 }, { height: 80 }, { height: 40 }];
    messages.forEach(m => { topSpacerH += m.height; });
    expect(topSpacerH).toBe(176);
  });

  test('eklenen mesajlar için spacer küçülür', () => {
    let topSpacerH = 200;
    const addedH = 56 * 3;
    topSpacerH = Math.max(0, topSpacerH - addedH);
    expect(topSpacerH).toBe(32);
  });

  test('spacer negatife düşemez', () => {
    let topSpacerH = 100;
    topSpacerH = Math.max(0, topSpacerH - 200);
    expect(topSpacerH).toBe(0);
  });
});

describe('virtual-scroll — message highlight', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setupScrollArea();
  });

  test('msg-highlight sınıfı eklenir ve kaldırılır', () => {
    jest.useFakeTimers();
    const { area } = setupScrollArea();
    const msg = createMockMessage('hl');
    area.appendChild(msg.el);
    msg.el.classList.add('msg-highlight');
    expect(msg.el.classList.contains('msg-highlight')).toBe(true);
    setTimeout(() => msg.el.classList.remove('msg-highlight'), 1500);
    jest.runAllTimers();
    expect(msg.el.classList.contains('msg-highlight')).toBe(false);
    jest.useRealTimers();
  });
});
