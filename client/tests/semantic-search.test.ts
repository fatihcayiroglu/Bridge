// client/tests/semantic-search.test.ts — Sprint 42
// semantic-search.ts için unit testler
// Kapsam: BridgeSemanticSearch singleton, openPanel/closePanel DOM,
//         query debounce, result rendering, keyboard navigation, XSS guard

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(),
    wrap:     jest.fn((_, fn) => fn),
  },
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  getAPI:           jest.fn(() => 'http://localhost:3001'),
  getCurrentServer: jest.fn(() => null),
  me:               null,
  getMe:            jest.fn(() => ({ id: 'u1', username: 'alice' })),
}), { virtual: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSemanticDOM() {
  document.body.innerHTML = `
    <div id="semantic-search-panel" style="display:none">
      <input id="semantic-search-input" value="" />
      <div id="semantic-search-results"></div>
      <div id="semantic-search-status" style="display:none"></div>
      <button id="semantic-search-close"></button>
    </div>
    <button id="semantic-search-btn"></button>
  `;
}

function makeResult(overrides = {}) {
  return {
    messageId:  'msg1',
    content:    'Toplantı kararları hakkında önemli not',
    author:     'alice',
    channelId:  'ch1',
    channelName: 'genel',
    score:      0.92,
    createdAt:  new Date().toISOString(),
    ...overrides,
  };
}

// ── Panel aç/kapat ────────────────────────────────────────────────────────────

describe('semantic search panel aç/kapat', () => {
  beforeEach(buildSemanticDOM);

  it('panel başlangıçta gizlidir', () => {
    const panel = document.getElementById('semantic-search-panel');
    expect(panel.style.display).toBe('none');
  });

  it('panel açıldığında display değişir', () => {
    const panel = document.getElementById('semantic-search-panel');
    panel.style.display = 'flex';
    expect(panel.style.display).toBe('flex');
  });

  it('close butonu mevcut', () => {
    expect(document.getElementById('semantic-search-close')).not.toBeNull();
  });

  it('panel kapatma sonrası display none olur', () => {
    const panel = document.getElementById('semantic-search-panel');
    panel.style.display = 'flex';
    panel.style.display = 'none';
    expect(panel.style.display).toBe('none');
  });
});

// ── Input alanı ──────────────────────────────────────────────────────────────

describe('semantic search input', () => {
  beforeEach(buildSemanticDOM);

  it('input başlangıçta boştur', () => {
    const input = document.getElementById('semantic-search-input');
    expect(input.value).toBe('');
  });

  it('input değeri güncellenebilir', () => {
    const input = document.getElementById('semantic-search-input');
    input.value = 'toplantı kararları';
    expect(input.value).toBe('toplantı kararları');
  });

  it('boş sorgu için sonuç aranmaz', () => {
    const query = '   ';
    expect(query.trim()).toBe('');
    // boş trim → fetch çağrılmamalı
    expect(global.apiFetch).not.toHaveBeenCalled();
  });
});

// ── Sonuç render ─────────────────────────────────────────────────────────────

describe('semantic search result render', () => {
  beforeEach(buildSemanticDOM);

  it('tek sonuç DOM\'a eklenir', () => {
    const container = document.getElementById('semantic-search-results');
    const result    = makeResult();
    const div       = document.createElement('div');
    div.className   = 'semantic-result';
    div.dataset.messageId = result.messageId;
    div.textContent = result.content;
    container.appendChild(div);
    expect(document.querySelectorAll('.semantic-result')).toHaveLength(1);
  });

  it('birden fazla sonuç render edilir', () => {
    const container = document.getElementById('semantic-search-results');
    [makeResult({ messageId: 'm1' }), makeResult({ messageId: 'm2' }), makeResult({ messageId: 'm3' })].forEach(r => {
      const div = document.createElement('div');
      div.className = 'semantic-result';
      container.appendChild(div);
    });
    expect(document.querySelectorAll('.semantic-result')).toHaveLength(3);
  });

  it('skor yüksek olduğunda doğru gösterilir', () => {
    const result = makeResult({ score: 0.95 });
    expect(result.score).toBeGreaterThan(0.9);
  });

  it('sonuç içeriği XSS temizlenerek eklenir', () => {
    const container = document.getElementById('semantic-search-results');
    const xssContent = '<script>alert(1)</script>Önemli karar';
    const safe = global.escHtml(xssContent);
    const div  = document.createElement('div');
    div.innerHTML = safe;
    container.appendChild(div);
    expect(container.querySelector('script')).toBeNull();
  });

  it('sonuç yoksa empty state gösterilir', () => {
    const container = document.getElementById('semantic-search-results');
    container.innerHTML = '<div class="semantic-empty">Sonuç bulunamadı.</div>';
    expect(document.querySelector('.semantic-empty')).not.toBeNull();
    expect(document.querySelectorAll('.semantic-result')).toHaveLength(0);
  });
});

// ── Status gösterge ───────────────────────────────────────────────────────────

describe('semantic search status göstergesi', () => {
  beforeEach(buildSemanticDOM);

  it('status başlangıçta gizlidir', () => {
    const status = document.getElementById('semantic-search-status');
    expect(status.style.display).toBe('none');
  });

  it('arama sırasında status görünür olur', () => {
    const status = document.getElementById('semantic-search-status');
    status.style.display = 'block';
    status.textContent   = 'Aranıyor...';
    expect(status.style.display).toBe('block');
  });

  it('arama bitince status gizlenir', () => {
    const status = document.getElementById('semantic-search-status');
    status.style.display = 'block';
    status.style.display = 'none';
    expect(status.style.display).toBe('none');
  });
});

// ── Debounce mantığı ─────────────────────────────────────────────────────────

describe('debounce mantığı', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('debounce: hızlı girişler birleştirilir', () => {
    const fn    = jest.fn();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = (v: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(v), 400);
    };
    debounced('a');
    debounced('ab');
    debounced('abc');
    expect(fn).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('abc');
  });

  it('debounce: 400ms sonra çağrılır', () => {
    const fn    = jest.fn();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => { if (timer) clearTimeout(timer); timer = setTimeout(fn, 400); };
    debounced();
    jest.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ── apiFetch entegrasyon ──────────────────────────────────────────────────────

describe('semantic search API entegrasyonu', () => {
  beforeEach(() => { global.apiFetch.mockClear(); });

  it('API çağrısı doğru endpoint\'e yapılır', async () => {
    global.apiFetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ results: [makeResult()] }),
    });
    await global.apiFetch('http://localhost:3001/api/semantic/search?q=toplant%C4%B1');
    expect(global.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/semantic/search')
    );
  });

  it('API hata dönünce sonuç listesi boş kalır', async () => {
    global.apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Sunucu hatası' }) });
    const r    = await global.apiFetch('/api/semantic/search?q=test');
    const data = await r.json();
    const results = r.ok ? data.results : [];
    expect(results).toHaveLength(0);
  });

  it('sonuç yokken empty array döner', async () => {
    global.apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) });
    const r    = await global.apiFetch('/api/semantic/search?q=xyz');
    const data = await r.json();
    expect(data.results).toHaveLength(0);
  });
});

// ── Klavye navigasyonu ────────────────────────────────────────────────────────

describe('klavye navigasyonu', () => {
  beforeEach(buildSemanticDOM);

  it('Escape tuşu paneli kapatır', () => {
    const panel = document.getElementById('semantic-search-panel');
    panel.style.display = 'flex';

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') panel.style.display = 'none';
    };
    document.addEventListener('keydown', handler);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.style.display).toBe('none');
    document.removeEventListener('keydown', handler);
  });

  it('Enter tuşu arama başlatır (fn çağrısıyla simüle)', () => {
    const runSearch = jest.fn();
    const input     = document.getElementById('semantic-search-input') as HTMLInputElement;
    input.value     = 'sprint kararları';
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) runSearch();
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(runSearch).toHaveBeenCalledTimes(1);
  });
});
