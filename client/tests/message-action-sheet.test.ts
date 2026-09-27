// client/tests/message-action-sheet.test.ts
//
// MOBİL MESAJ EYLEM SAYFASI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Dokunmatikte hover olmadığı için masaüstü eylem çubuğu her mesajda KALICI
// görünüyor ve `position: static` ile mesajın YANINDA yer kaplıyordu.
//
// ÖLÇÜM (412px telefon): 6 ikon genişliğin ~%45'ini alıyordu; metin satır
// başına üç kelimeye düşüyor, sohbet okunaksız hale geliyordu.
//
// Denenip REDDEDİLEN iki yol kaynakta kayıtlı:
//   · absolute konumlama → metin genişliği geri geldi ama çubuk METNİ ÖRTTÜ
//   · eylemleri gizlemek → mesaj bağlam menüsü YOK, eylemler erişilemez kalırdı
//
// ── BU PAKETİN KİLİTLEDİĞİ SÖZLEŞMELER ────────────────────────────────────
//   1. Sayfa YETKİ KARARI VERMEZ; yalnızca verilen eylemleri gösterir.
//      İzin mantığı masaüstü çubuğuyla TEK kaynaktan gelir.
//   2. Yıkıcı eylem RENKTEN başka işaret de taşır.
//   3. Escape / scrim kapatır.
//   4. Eylem çalışmadan ÖNCE sayfa kapanır (iki örtü üst üste binmesin).
//   5. Dokunma hedefi mobil erişilebilirlik sözleşmesini karşılar.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import MessageActionSheet from '../js/core/MessageActionSheet.svelte';
import { readFileSync } from 'fs';
import { join } from 'path';

const CLIENT = join(__dirname, '..');
const RENDERER = readFileSync(join(CLIENT, 'js', 'core', 'MessageRenderer.svelte'), 'utf8');

const action = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, run: vi.fn(), ...over,
});

// ════════════════════════════════════════════════════════════════════════════
describe('sayfa — görünürlük ve kapanış', () => {
  it('kapalıyken hiçbir şey render etmez', () => {
    const { container } = render(MessageActionSheet, { props: { open: false, actions: [action('reply')] } });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('açıkken menü rolüyle render eder', () => {
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [action('reply')] } });
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
  });

  it('scrim tıklaması kapatır', async () => {
    const onClose = vi.fn();
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [action('reply')], onClose } });
    await fireEvent.click(container.querySelector('.mas-scrim')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape kapatır', async () => {
    const onClose = vi.fn();
    render(MessageActionSheet, { props: { open: true, actions: [action('reply')], onClose } });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sayfa — eylemler', () => {
  it('verilen eylemi ÇALIŞTIRIR', async () => {
    const reply = action('reply', { label: 'Yanıtla' });
    const { getByText } = render(MessageActionSheet, { props: { open: true, actions: [reply] } });
    await fireEvent.click(getByText('Yanıtla'));
    expect(reply.run).toHaveBeenCalledTimes(1);
  });

  it('eylemden ÖNCE kapanır', async () => {
    // Eylem bir modal açarsa (düzenle/sil onayı) iki örtü üst üste binmemeli.
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    const act = action('edit', { label: 'Düzenle', run: vi.fn(() => order.push('run')) });
    const { getByText } = render(MessageActionSheet, { props: { open: true, actions: [act], onClose } });
    await fireEvent.click(getByText('Düzenle'));
    expect(order).toEqual(['close', 'run']);
  });

  it('YIKICI eylem renkten başka işaret de taşır', () => {
    const { container } = render(MessageActionSheet, {
      props: { open: true, actions: [action('delete', { label: 'Sil', danger: true })] },
    });
    expect(container.querySelector('.mas-item.danger')).toBeTruthy();
  });

  it('sayfa KENDİ BAŞINA eylem uydurmaz', () => {
    // Yetki kararı burada verilmez: boş liste boş menü demektir.
    const { container } = render(MessageActionSheet, { props: { open: true, actions: [] } });
    const items = [...container.querySelectorAll('[role="menuitem"]')];
    // Yalnızca "İptal" bulunur.
    expect(items).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('renderer — uzun basma ve izin koşulları', () => {
  it('dokunmatikte satır içi çubuk düzenden ÇIKARILIR', () => {
    // Asıl kusur buydu: çubuk mesaj genişliğinin ~%45'ini yiyordu.
    expect(RENDERER).toMatch(/\.msg-actions \{ display: none; \}/);
  });

  it('klavye kullanıcısı için odakta KATMAN olarak geri gelir', () => {
    // Gizlemek eylemleri erişilemez yapmamalı.
    expect(RENDERER).toMatch(/\.msg:focus-visible \.msg-actions/);
    expect(RENDERER).toMatch(/position: absolute/);
  });

  it('mobilde katman DOKUNMAYLA değil YALNIZCA klavyeyle açılır', () => {
    // Mesaj dolaşan tabindex ile odaklanabilir hale geldi; dokunmak da odaklar.
    // Mobil blokta `:focus-within` kullanılsaydı her dokunuşta çubuk metnin
    // ÜZERİNE binerdi — UX-18'de ölçülüp REDDEDİLEN durum.
    const mobileBlock = RENDERER.slice(RENDERER.indexOf('.msg-actions { display: none; }'));
    expect(mobileBlock).not.toMatch(/\.msg:focus-within \.msg-actions/);
    expect(mobileBlock).toMatch(/:focus-visible/);
  });

  it('FARE uzun basması tetiklemez — masaüstü davranışı korunur', () => {
    expect(RENDERER).toMatch(/if \(e\.pointerType === 'mouse'\) return;/);
  });

  it('KAYDIRMA uzun basmayı iptal eder', () => {
    // Dikey kaydırırken yanlışlıkla açılmamalı.
    expect(RENDERER).toMatch(/MOVE_CANCEL_PX/);
    expect(RENDERER).toMatch(/onpointercancel=/);
  });

  it('uzun basmadan sonraki TIKLAMA yutulur', () => {
    // Hem uzun basma hem tıklama ateşlenmemeli.
    expect(RENDERER).toMatch(/onclickcapture=/);
    expect(RENDERER).toMatch(/pressFired/);
  });

  it('DÜZENLE/SİL yalnızca sahiplik ve teslim edilmiş kimlik koşuluyla eklenir', () => {
    // Masaüstü çubuğuyla AYNI koşul; bekleyen ack kimliği sunucu mesaj kimliği
    // değildir ve düzenle/sil komutlarında kullanılamaz.
    const block = RENDERER.slice(RENDERER.indexOf('const sheetActions'));
    expect(block).toMatch(/if \(isOwn && isDelivered\) \{[\s\S]*?'edit'[\s\S]*?'delete'/);
  });

  it('KALICI BAĞLANTI yalnızca `canPermalink` ile eklenir', () => {
    const block = RENDERER.slice(RENDERER.indexOf('const sheetActions'));
    expect(block).toMatch(/if \(canPermalink\)/);
  });

  it('eylemler KANONİK işleyicileri çağırır — mantık çoğaltılmaz', () => {
    const block = RENDERER.slice(RENDERER.indexOf('const sheetActions'));
    for (const handler of ['onReply?.(message)', 'onEdit?.(message)', 'onDelete?.(message)', 'onSave?.(message)']) {
      expect(block).toContain(handler);
    }
  });

  it('etiketler i18n\'den gelir — sabit kod YOK', () => {
    const block = RENDERER.slice(RENDERER.indexOf('const sheetActions'));
    expect(block).toMatch(/t\('msg_action_reply'/);
    expect(block).toMatch(/t\('msg_action_delete'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sayfa — jeton disiplini', () => {
  const SHEET = readFileSync(join(CLIENT, 'js', 'core', 'MessageActionSheet.svelte'), 'utf8');

  it('SİHİRLİ z-index yok', () => {
    expect(SHEET).not.toMatch(/z-index:\s*\d+/);
    expect(SHEET).toMatch(/z-index: var\(--z-modal\)/);
  });

  it('sabit kodlu tema rengi yok', () => {
    const css = SHEET.slice(SHEET.indexOf('<style>'));
    expect(css).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(css).not.toMatch(/rgb\(\s*\d+/);
  });

  it('dokunma hedefi mobil sözleşmeyi karşılar', () => {
    expect(SHEET).toMatch(/min-height:\s*48px/);
  });

  it('hareket azaltma tercihine saygı duyar', () => {
    expect(SHEET).toMatch(/prefers-reduced-motion: no-preference/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('klavye erişimi — dolaşan tabindex (WCAG 2.1.1)', () => {
  const LIST = readFileSync(join(CLIENT, 'js', 'core', 'MessageListPanel.svelte'), 'utf8');

  // KAPATILAN GERÇEK KUSUR: `.msg-actions` temel durumda `visibility: hidden`
  // idi; bu, içindeki düğmeleri ODAKLANAMAZ yapar. `.msg` de odaklanabilir
  // değildi. Sonuç: düz metin mesajında `.msg:focus-within` HİÇ ateşlenemez,
  // yanıtla/düzenle/sil YALNIZCA FAREYLE erişilebilirdi.
  //
  // axe bunu YAKALAYAMAZ: statik ihlal yok, "erişilebilir mi" sorusu
  // yalnızca gerçek klavye sürüşüyle yanıtlanır.

  it('mesaj ODAKLANABİLİR — yoksa `:focus-within` hiç ateşlenemez', () => {
    expect(RENDERER).toMatch(/tabindex=\{tabIndex\}/);
  });

  it('odak GÖRÜNÜR bir halka bırakır (WCAG 2.4.7)', () => {
    expect(RENDERER).toMatch(/\.msg:focus-visible \{/);
    expect(RENDERER).toMatch(/outline: 2px solid var\(--focus-ring\)/);
  });

  it('günlük TEK tab durağıdır — mesaj başına altı durak DEĞİL', () => {
    // Her düğmeyi odaklanabilir yapmak 50 mesajda ~300 durak demekti.
    expect(LIST).toMatch(/rovingId/);
    expect(LIST).toMatch(/tabIndex=\{String\(message\._id\) === rovingId \? 0 : -1\}/);
  });

  it('ok tuşları mesajlar arasında gezinir', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(LIST).toContain(`case '${key}'`);
    }
  });

  it('ok tuşları YALNIZCA günlükte gezinirken çalışır', () => {
    // Yazma alanı veya bir düğme odaktayken ok tuşları o öğenin işidir.
    expect(LIST).toMatch(/classList\.contains\('msg'\)/);
  });

  it('liste boşken veya seçim kaybolunca SON mesaj odaklanabilir kalır', () => {
    // Aksi halde günlük tab sırasından tamamen düşerdi.
    expect(LIST).toMatch(/grouped\[grouped\.length - 1\]/);
  });
});
