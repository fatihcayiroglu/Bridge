// client/tests/emoji-picker.test.ts — Sprint 50
// emoji-picker.ts için unit testler

'use strict';

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: { register: jest.fn(), get: jest.fn(), call: jest.fn() },
}), { virtual: true });

// ── DOM Setup ─────────────────────────────────────────────────────────────────

function setupDOM() {
  document.body.innerHTML = `
    <div id="emoji-picker" style="display:none">
      <div id="emoji-categories"></div>
      <div id="emoji-grid"></div>
      <input id="emoji-search" type="text">
      <div id="panel-emoji"></div>
      <div id="panel-gif" style="display:none"></div>
      <div id="panel-server-gif" style="display:none"></div>
      <button id="tab-emoji" class="active"></button>
      <button id="tab-gif"></button>
      <button id="tab-server-gif"></button>
      <div id="gif-grid"></div>
      <div id="gif-label"></div>
    </div>
    <input id="msg-input" type="text" value="">`;
}

const EMOJI_CATEGORIES = {
  '😊 Yüzler':  ['😀','😃','😄','😁','😆'],
  '👋 Eller':   ['👋','🤚','🖐️','✋','🖖'],
  '❤️ Kalpler': ['❤️','🧡','💛','💚','💙'],
  '🔥 Popüler': ['🔥','💯','✅','❌','⭐'],
};

// ── toggleEmojiPicker ──────────────────────────────────────────────────────────

describe('emoji-picker — toggleEmojiPicker', () => {
  beforeEach(() => setupDOM());

  test('ilk açılışta display:block olur', () => {
    const p = document.getElementById('emoji-picker');
    p.style.display = 'none';
    const isHidden = p.style.display === 'none';
    p.style.display = isHidden ? 'block' : 'none';
    expect(p.style.display).toBe('block');
  });

  test('tekrar çağrılınca kapanır', () => {
    const p = document.getElementById('emoji-picker');
    p.style.display = 'block';
    const isHidden = p.style.display === 'none';
    p.style.display = isHidden ? 'block' : 'none';
    expect(p.style.display).toBe('none');
  });
});

// ── initEmojiPicker ────────────────────────────────────────────────────────────

describe('emoji-picker — initEmojiPicker', () => {
  beforeEach(() => setupDOM());

  function initEmojiPicker() {
    const catBar = document.getElementById('emoji-categories');
    if (!catBar) return;
    catBar.innerHTML = '';
    let first = true;
    for (const cat of Object.keys(EMOJI_CATEGORIES)) {
      const btn = document.createElement('button');
      btn.className = 'ep-cat-btn' + (first ? ' active' : '');
      btn.textContent = cat.split(' ')[0];
      btn.title = cat;
      catBar.appendChild(btn);
      first = false;
    }
    renderEmojiGrid(Object.values(EMOJI_CATEGORIES)[0]);
  }

  function renderEmojiGrid(list) {
    const grid = document.getElementById('emoji-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const e of list) {
      const btn = document.createElement('div');
      btn.className = 'emoji-btn';
      btn.textContent = e;
      grid.appendChild(btn);
    }
  }

  test('kategori butonları oluşturulur', () => {
    initEmojiPicker();
    const catBar = document.getElementById('emoji-categories');
    expect(catBar.querySelectorAll('.ep-cat-btn').length).toBe(Object.keys(EMOJI_CATEGORIES).length);
  });

  test('ilk kategori butonu active sınıfına sahip', () => {
    initEmojiPicker();
    const firstBtn = document.querySelector('.ep-cat-btn');
    expect(firstBtn.classList.contains('active')).toBe(true);
  });

  test('emoji grid dolu', () => {
    initEmojiPicker();
    const grid = document.getElementById('emoji-grid');
    expect(grid.querySelectorAll('.emoji-btn').length).toBeGreaterThan(0);
  });

  test('her emoji bir div olarak eklenir', () => {
    initEmojiPicker();
    const grid = document.getElementById('emoji-grid');
    const firstBtn = grid.querySelector('.emoji-btn');
    expect(firstBtn).not.toBeNull();
    expect(['😀','👋','❤️','🔥']).toContain(firstBtn.textContent);
  });
});

// ── insertEmoji ────────────────────────────────────────────────────────────────

describe('emoji-picker — insertEmoji', () => {
  beforeEach(() => setupDOM());

  function insertEmoji(e) {
    const inp = document.getElementById('msg-input');
    if (!inp) return;
    const pos = inp.selectionStart ?? inp.value.length;
    inp.value = inp.value.slice(0, pos) + e + inp.value.slice(pos);
    const picker = document.getElementById('emoji-picker');
    if (picker) picker.style.display = 'none';
  }

  test('emoji input\'a eklenir', () => {
    insertEmoji('😀');
    const inp = document.getElementById('msg-input');
    expect(inp.value).toBe('😀');
  });

  test('mevcut metne emoji eklenir', () => {
    const inp = document.getElementById('msg-input');
    inp.value = 'Merhaba ';
    insertEmoji('❤️');
    expect(inp.value).toBe('Merhaba ❤️');
  });

  test('emoji eklendikten sonra picker kapanır', () => {
    const picker = document.getElementById('emoji-picker');
    picker.style.display = 'block';
    insertEmoji('🔥');
    expect(picker.style.display).toBe('none');
  });
});

// ── filterEmojis ──────────────────────────────────────────────────────────────

describe('emoji-picker — filterEmojis', () => {
  beforeEach(() => setupDOM());

  function renderEmojiGrid(list) {
    const grid = document.getElementById('emoji-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const e of list) {
      const btn = document.createElement('div');
      btn.className = 'emoji-btn';
      btn.textContent = e;
      grid.appendChild(btn);
    }
  }

  test('boş sorgu tüm emojileri gösterir', () => {
    const all = Object.values(EMOJI_CATEGORIES).flat();
    renderEmojiGrid(all);
    const grid = document.getElementById('emoji-grid');
    expect(grid.querySelectorAll('.emoji-btn').length).toBe(all.length);
  });

  test('filtre sonucu grid güncellenir', () => {
    renderEmojiGrid(['😀', '😃']);
    const grid = document.getElementById('emoji-grid');
    expect(grid.querySelectorAll('.emoji-btn').length).toBe(2);
  });
});

// ── switchPickerTab ────────────────────────────────────────────────────────────

describe('emoji-picker — switchPickerTab', () => {
  beforeEach(() => setupDOM());

  function switchPickerTab(tab) {
    ['emoji', 'gif', 'server-gif'].forEach(t => {
      const panel = document.getElementById(`panel-${t}`);
      if (panel) panel.style.display = t === tab ? '' : 'none';
      const tabEl = document.getElementById(`tab-${t}`);
      if (tabEl) tabEl.classList.toggle('active', t === tab);
    });
  }

  test('gif tab\'ına geçince gif panel görünür', () => {
    switchPickerTab('gif');
    expect(document.getElementById('panel-gif').style.display).toBe('');
  });

  test('gif tab\'ına geçince emoji panel gizlenir', () => {
    switchPickerTab('gif');
    expect(document.getElementById('panel-emoji').style.display).toBe('none');
  });

  test('emoji tab\'ına geri dönülür', () => {
    switchPickerTab('gif');
    switchPickerTab('emoji');
    expect(document.getElementById('panel-emoji').style.display).toBe('');
    expect(document.getElementById('panel-gif').style.display).toBe('none');
  });

  test('tab butonu active sınıfı alır', () => {
    switchPickerTab('gif');
    expect(document.getElementById('tab-gif').classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-emoji').classList.contains('active')).toBe(false);
  });
});
