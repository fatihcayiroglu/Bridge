// client/tests/i18n-reactivity.test.ts
//
// DİL DEĞİŞİMİNDE ARAYÜZ GERÇEKTEN YENİLENİYOR MU?
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU TEST ÖNCE YAZILDI
// ════════════════════════════════════════════════════════════════════════════
// i18n göçüne başlamadan önce yanıtlanması gereken bir soru vardı: sabit
// kodlu metinleri `t()` çağrılarına taşımak GERÇEKTEN işe yarıyor mu?
//
// `t()` (i18n/index.ts) modül düzeyindeki düz bir `_table` değişkenini okur.
// Svelte 5'te bir şablon ifadesi YALNIZCA içinde okunan REAKTİF durum
// değiştiğinde yeniden değerlendirilir. Düz bir modül değişkeni rune
// değildir — yani `{t('key')}` hiçbir reaktif bağımlılık kurmaz.
//
// `i18n-dom.ts` yalnızca `index.html` içindeki `data-i18n` NİTELİKLİ düz DOM
// düğümlerini günceller; Svelte bileşenlerindeki `t()` çağrılarını KAPSAMAZ.
//
// Sonuç şu olurdu: 387 dizeyi `t()`ye taşımak, dili değiştiren kullanıcı için
// HİÇBİR ŞEYİ DEĞİŞTİRMEZDİ — metinler sayfa yenilenene kadar eski dilde
// kalırdı. Yani göç, ölçülebilir ama İŞLEVSİZ olurdu.
//
// Bu dosya önce sorunu KANITLAR, sonra düzeltmenin kalıcı olmasını sağlar.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';

// Gerçek i18n sahibi — sahte tablo YOK, ürünün kendi tabloları kullanılır.
import { setLocale, locale, t as rawT } from '../js/core/i18n/index.ts';
import { t as reactiveT, localeTick } from '../js/core/i18n/reactive.svelte.ts';

describe('i18n — ham t() davranışı (temel gerçek)', () => {
  beforeEach(async () => {
    await setLocale('tr');
  });

  it('ham t() dil değişince YENİ değeri döndürür', async () => {
    // Ham fonksiyonun kendisi doğrudur; sorun REAKTİFLİKTE, çeviride değil.
    const tr = rawT('sign_in', 'Giriş yap');
    await setLocale('en');
    const en = rawT('sign_in', 'Giriş yap');
    expect({ differs: tr !== en, locale: locale.current })
      .toEqual({ differs: true, locale: 'en' });
  });
});

describe('i18n — REAKTİF sarmalayıcı', () => {
  beforeEach(async () => {
    await setLocale('tr');
  });

  it('reaktif t() de doğru değeri döndürür (sözleşme aynı)', async () => {
    const tr = reactiveT('sign_in', 'Giriş yap');
    await setLocale('en');
    const en = reactiveT('sign_in', 'Giriş yap');
    expect({ differs: tr !== en }).toEqual({ differs: true });
  });

  it('dil değişimi bir SÜRÜM SAYACINI artırır', async () => {
    // Reaktifliğin taşıyıcısı budur: bileşenler bu sayacı okuduğu için
    // dil değiştiğinde yeniden değerlendirilirler.
    const before = localeTick();
    await setLocale('en');
    await waitFor(() => expect(localeTick()).toBeGreaterThan(before));
  });

  it('AYNI dile geçmek gereksiz yenileme tetiklemez', async () => {
    const before = localeTick();
    await setLocale('tr');            // zaten tr
    expect(localeTick()).toBe(before);
  });

  it('bilinmeyen anahtar için yedek metin korunur', async () => {
    // Ham anahtar sızıntısı olmamalı: çeviri yoksa Türkçe yedek görünür.
    expect(reactiveT('__kesinlikle_yok__', 'Yedek metin')).toBe('Yedek metin');
  });
});

describe('canlı dil değişimi — MONTE EDİLMİŞ bileşen', () => {
  beforeEach(async () => {
    document.body.innerHTML = '';
    await setLocale('tr');
  });

  it('dil değişince EKRANDAKİ metin gerçekten değişir', async () => {
    // ASIL SORU BUDUR. Kullanıcı ayarlardan İngilizce'yi seçtiğinde, zaten
    // ekranda olan bileşenlerin metni değişmelidir — sayfa yenilenmeden.
    const { default: Probe } = await import('./fixtures/LocaleProbe.svelte');
    render(Probe);

    const trText = rawT('sign_in', 'Giriş yap');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(trText));

    await setLocale('en');

    const enText = rawT('sign_in', 'Giriş yap');
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe(enText);
    });
  });

  it('KONTROL: ham t() kullanan bileşen dil değişimine YANIT VERMEZ', async () => {
    // Kusurun gerçekliğini gösteren karşı örnek. Bu test GEÇERSE, sabit
    // metinleri ham `t()`ye taşımanın kullanıcı için hiçbir şey
    // değiştirmeyeceği kanıtlanmış olur — göçün neden reaktif sarmalayıcı
    // üzerinden yapılması gerektiğinin nedeni budur.
    const { default: RawProbe } = await import('./fixtures/LocaleProbeRaw.svelte');
    render(RawProbe);

    const trText = rawT('sign_in', 'Giriş yap');
    await waitFor(() => expect(screen.getByTestId('probe-raw').textContent).toBe(trText));

    await setLocale('en');
    const enText = rawT('sign_in', 'Giriş yap');
    expect({ differs: trText !== enText }).toEqual({ differs: true });

    // Ekrandaki metin HALA eski dilde — yeniden değerlendirme olmadı.
    expect(screen.getByTestId('probe-raw').textContent).toBe(trText);
  });
});
