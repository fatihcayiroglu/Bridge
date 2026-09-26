// client/tests/ux-final21-shell.test.ts
//
// Final21 UX turu — KABUK
//   U-10 boş `#discover-root` kabı artık kutu üretmez (belge 2× yükseklikti; scrollIntoView
//        tüm uygulamayı kaydırıyordu ve kullanıcı geri kaydıramıyordu)
//   U-14 telefonda kanal başlığı taşma menüsü ("# ge…" → kanal adı okunur; sabitlenmişler
//        telefonda yeniden erişilebilir)
//   U-07 başlıkta iki özdeş simge (Arkadaşlar = Üyeler) ve neredeyse aynı iki büyüteç
//   Dokunmatikte :hover ipucu yapışıp açılan menünün üstüne binmez

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(CLIENT, ...p), 'utf8');
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('U-10 — Keşfet kabı akışta yer kaplamaz', () => {
  it('#discover-root hiçbir stil sayfasında yükseklik almaz; tek sahip display: contents', () => {
    const sheets = ['community-features.css', 'sprint91.css', 'layout.css', 'responsive-fixes.css', 'modals.css']
      .map((f) => noComments(read('css', 'modules', f)));
    const rules = sheets.flatMap((css) => [...css.matchAll(/#discover-root\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim()));
    expect(rules).toEqual(['display: contents;']);
  });

  it('panel kendi sabit katmanında açılır (kabın yüksekliğine ihtiyacı yok)', () => {
    const panel = read('js', 'core', 'DiscoverPanel.svelte');
    expect(panel).toMatch(/\.discover-root \{\s*position: fixed;\s*inset: 0;/);
  });
});

describe('U-07 — başlık simgeleri ayırt edilebilir', () => {
  it('görünür başlık düğmelerinin hiçbiri aynı simgeyi taşımaz', () => {
    const html = read('index.html');
    const bar = html.slice(html.indexOf('class="channel-header-actions"'), html.indexOf('<!-- TEXT CHANNEL VIEW -->'));
    const icons = [...bar.matchAll(/<button[\s\S]*?<\/button>/g)].map((b) => (b[0].match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '').replace(/\s+/g, ''));
    const dup = icons.filter((v, i) => v && icons.indexOf(v) !== i);
    expect(icons.length).toBeGreaterThanOrEqual(9);
    expect(dup).toEqual([]);
  });
});

describe('ipucu — dokunmatikte yapışmaz, açılan menünün üstüne binmez', () => {
  it('hover olmayan cihazda ipucu yalnız klavye odağında; açık menünün düğmesinde gizli', () => {
    const css = noComments(read('css', 'modules', 'modals.css'));
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.tooltip:hover:not\(:focus-visible\)::after \{ opacity: 0; \}/);
    expect(css).toMatch(/\.tooltip\[aria-haspopup\]\[aria-expanded='true'\]:is\(:hover, :focus-visible\)::after \{ opacity: 0; \}/);
  });
});

describe('U-14 — telefonda başlık taşma menüsü', () => {
  const clicks: string[] = [];
  beforeEach(async () => {
    clicks.length = 0;
    document.body.innerHTML = `
      <div class="channel-header"><span id="ch-h-name">general</span>
        <div class="channel-header-actions">
          <button id="btn-inbox" aria-label="Gelen kutusunu aç"><svg data-i="inbox"></svg></button>
          <button id="btn-search" aria-label="Ara"><svg></svg></button>
          <button id="btn-pins" aria-label="Sabitlenmiş mesajları göster"><svg data-i="pins"></svg></button>
          <button id="btn-hidden" hidden aria-label="Gizli"><svg></svg></button>
          <button id="btn-disabled" disabled aria-label="Kapalı"><svg></svg></button>
          <button id="btn-header-more" aria-label="Diğer kanal araçları" aria-haspopup="menu" aria-expanded="false"><svg></svg></button>
        </div></div>`;
    for (const id of ['btn-inbox', 'btn-pins', 'btn-search']) document.getElementById(id)!.addEventListener('click', () => clicks.push(id));
    vi.resetModules();
    const mod = await import('../js/core/shell-actions.ts');
    mod.mountShellActions();
  });
  afterEach(async () => {
    const mod = await import('../js/core/shell-actions.ts');
    mod.unmountShellActions();
    document.body.innerHTML = '';
  });

  const menu = () => document.querySelector<HTMLElement>('.header-more-menu');
  const more = () => document.getElementById('btn-header-more')!;

  it('gizlenen araçları (arama ve gizli/devre dışı olanlar hariç) etiket ve simgeleriyle listeler, odak ilk öğede', () => {
    more().click();
    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute('role')).toBe('menu');
    const items = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Gelen kutusunu aç', 'Sabitlenmiş mesajları göster']);
    expect(items[0]!.querySelector('svg')?.getAttribute('data-i')).toBe('inbox');
    expect(document.activeElement).toBe(items[0]);
    expect(more().getAttribute('aria-expanded')).toBe('true');
  });

  it('öğe ASIL düğmeye vekâlet eder ve menüyü kapatır', () => {
    more().click();
    [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]!.click();
    expect(clicks).toEqual(['btn-pins']);
    expect(menu()).toBeNull();
    expect(more().getAttribute('aria-expanded')).toBe('false');
  });

  it('ok tuşları dolaşır; Esc kapatır ve odağı "⋯" düğmesine döndürür', () => {
    more().click();
    const items = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('dışarı tıklama ve ikinci "⋯" tıklaması kapatır; Tab menüyü bırakır', () => {
    more().click();
    document.getElementById('ch-h-name')!.click();
    expect(menu()).toBeNull();
    more().click();
    more().click();
    expect(menu()).toBeNull();
    more().click();
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(menu()).toBeNull();
  });

  it('erişilebilir adı olmayan düğme görünen ipucu metniyle listelenir (boş satır olmaz)', () => {
    const b = document.getElementById('btn-pins')!;
    b.removeAttribute('aria-label');
    b.setAttribute('data-tip', 'Sabitlenmişler');
    more().click();
    expect([...menu()!.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(['Gelen kutusunu aç', 'Sabitlenmişler']);
  });

  it('listelenecek araç yoksa menü açılmaz', () => {
    for (const id of ['btn-inbox', 'btn-pins']) document.getElementById(id)!.remove();
    more().click();
    expect(menu()).toBeNull();
  });

  it('CSS: telefonda yalnız arama ve "⋯" görünür; masaüstünde "⋯" gizli', () => {
    const desktop = noComments(read('css', 'modules', 'layout.css'));
    const phone = noComments(read('css', 'modules', 'responsive-fixes.css'));
    expect(desktop).toMatch(/#btn-header-more \{ display: none; \}/);
    expect(phone).toMatch(/\.channel-header-actions > \.h-btn:not\(#btn-search\):not\(#btn-header-more\) \{ display: none; \}/);
    expect(phone).toMatch(/#btn-header-more \{ display: grid; \}/);
  });
});
