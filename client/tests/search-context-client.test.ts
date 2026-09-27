// client/tests/search-context-client.test.ts
//
// ARAMA BAGLAM ONIZLEMESI — ISTEMCI VERI KATMANI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUK
// ════════════════════════════════════════════════════════════════════════════
// Arama tek satirlik isabetler donduruyordu. "tamam" yazan bir mesaj neyin
// tamam oldugunu soylemez; kullanici sonuca GITMEDEN once hangi konusma
// oldugunu goremiyordu.
//
// ── KORUNAN KARARLAR ──────────────────────────────────────────────────────
//   1. 404 bir HATA DEGILDIR. Sunucu "yok" ile "yetkisiz"i BILEREK ayirmaz
//      (varlik sizmasin diye); istemci de ayirmaz ve `null` doner.
//   2. GERCEK hatalar (500, 503) FIRLATILIR. Sessizce bos donmek bozuk bir
//      uc noktayi "baglam yok" gibi gosterirdi.
//   3. Yaricap ISTEMCIDE de kelepcelenir — sunucu zaten kelepceler, ama
//      istemcinin sinirsiz istek uretmesinin bir anlami yok.
//   4. Yanit DUZ METINDIR; istemci isaretleme URETMEZ ve beklemez.

import { describe, it, expect, vi } from 'vitest';
import {
  fetchSearchContext, MAX_CONTEXT_RADIUS,
} from '../js/core/search/unified-search-client.ts';

const msg = (over: Record<string, unknown> = {}) => ({
  _id: 'm1', userId: 'u1', displayName: 'Ayse',
  content: 'merhaba', createdAt: 1000, isAnchor: false, ...over,
});

const response = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);

const okBody = (messages: unknown[]) => ({ source: 'channel', channelId: 'c1', messages });

// ════════════════════════════════════════════════════════════════════════════
describe('fetchSearchContext — istek', () => {
  it('kimlik ve kaynak sorguya konur', async () => {
    const api = response(okBody([msg()]));
    await fetchSearchContext(api, 'm1', 'channel');

    const url = api.mock.calls[0][0] as string;
    expect(url).toContain('/api/search/context?');
    expect(url).toContain('id=m1');
    expect(url).toContain('source=channel');
  });

  it('yaricap UST SINIRA kelepcelenir', async () => {
    const api = response(okBody([msg()]));
    await fetchSearchContext(api, 'm1', 'dm', { radius: 9999 });

    expect(api.mock.calls[0][0]).toContain(`radius=${MAX_CONTEXT_RADIUS}`);
  });

  it('yaricap ALT SINIRA kelepcelenir', async () => {
    const api = response(okBody([msg()]));
    await fetchSearchContext(api, 'm1', 'dm', { radius: -5 });

    expect(api.mock.calls[0][0]).toContain('radius=1');
  });

  it('kimlik yoksa ISTEK ATILMAZ', async () => {
    const api = response(okBody([msg()]));
    expect(await fetchSearchContext(api, '', 'channel')).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  it('iptal sinyali gecirilir', async () => {
    const api = response(okBody([msg()]));
    const controller = new AbortController();
    await fetchSearchContext(api, 'm1', 'channel', { signal: controller.signal });

    expect(api.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('fetchSearchContext — yanit', () => {
  it('satirlari cozer ve capayi korur', async () => {
    const api = response(okBody([
      msg({ _id: 'a', content: 'once' }),
      msg({ _id: 'b', content: 'ISABET', isAnchor: true }),
      msg({ _id: 'c', content: 'sonra' }),
    ]));

    const res = await fetchSearchContext(api, 'b', 'channel');

    expect(res?.messages.map(m => m._id)).toEqual(['a', 'b', 'c']);
    expect(res?.messages.filter(m => m.isAnchor)).toHaveLength(1);
    expect(res?.channelId).toBe('c1');
  });

  it('bozuk satirlar DUSURULUR, saglamlar kalir', async () => {
    const api = response(okBody([
      msg({ _id: 'a' }), null, 'metin', { yok: true }, msg({ _id: 'b' }),
    ]));

    const res = await fetchSearchContext(api, 'a', 'channel');
    expect(res?.messages.map(m => m._id)).toEqual(['a', 'b']);
  });

  it('eksik alanlar guvenli varsayilana duser', async () => {
    const api = response(okBody([{ _id: 'a' }]));
    const res = await fetchSearchContext(api, 'a', 'channel');

    expect(res?.messages[0]).toEqual({
      _id: 'a', userId: '', displayName: null,
      // Final21 Phase 16: a response without `contentFormat` is LEGACY (0), so the text is
      // decoded once. Defaulting to RAW instead would show old messages as "a &lt; b".
      content: '', contentFormat: 0, createdAt: 0, isAnchor: false,
    });
  });

  it('`isAnchor` yalnizca GERCEK true ile isaretlenir', async () => {
    // 'true', 1, 'yes' gibi degerler capa YAPMAZ; aksi halde sunucudan
    // gelen herhangi bir dogruluk-benzeri deger vurgulamayi kaydirirdi.
    const api = response(okBody([
      msg({ _id: 'a', isAnchor: 'true' }),
      msg({ _id: 'b', isAnchor: 1 }),
      msg({ _id: 'c', isAnchor: true }),
    ]));

    const res = await fetchSearchContext(api, 'c', 'channel');
    expect(res?.messages.filter(m => m.isAnchor).map(m => m._id)).toEqual(['c']);
  });

  it('BOS pencere `null` doner — cizecek bir sey yok', async () => {
    expect(await fetchSearchContext(response(okBody([])), 'm1', 'channel')).toBeNull();
  });

  it('`messages` dizi degilse `null` doner', async () => {
    expect(await fetchSearchContext(response({ messages: 'bozuk' }), 'm1', 'channel')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('fetchSearchContext — hata disiplini', () => {
  it('404 HATA DEGILDIR — `null` doner', async () => {
    // Sunucu "yok" ile "yetkisiz"i ayirmaz. Istemci de ayirmaz ve bunu
    // beklenen bir sonuc olarak isler; firlatirsa panel gereksiz yere
    // hata gosterirdi.
    const api = response({ error: 'Baglam bulunamadi.' }, false, 404);
    await expect(fetchSearchContext(api, 'm1', 'channel')).resolves.toBeNull();
  });

  it('GERCEK hata FIRLATILIR ve durum kodu tasinir', async () => {
    for (const status of [500, 503, 429]) {
      const api = response({ error: 'x' }, false, status);
      await expect(fetchSearchContext(api, 'm1', 'channel'))
        .rejects.toMatchObject({ status });
    }
  });

  it('400 FIRLATILIR — sessizce yutulmaz', async () => {
    // 400 bir ISTEMCI kusurudur (gecersiz kaynak); sessizce `null` donmek
    // onu gizler.
    const api = response({ error: 'Gecersiz kaynak.' }, false, 400);
    await expect(fetchSearchContext(api, 'm1', 'channel')).rejects.toMatchObject({ status: 400 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('fetchSearchContext — icerik DUZ METINDIR', () => {
  it('istemci isaretleme URETMEZ', async () => {
    // Icerik oldugu gibi tasinir; cizim Svelte metin dugumleriyle yapilir.
    // Burada bir yerde HTML uretilseydi, panel `{@html}` yoluna acik olurdu.
    const nasty = '<img src=x onerror=alert(1)>';
    const api = response(okBody([msg({ content: nasty })]));

    const res = await fetchSearchContext(api, 'm1', 'channel');
    expect(res?.messages[0].content).toBe(nasty);   // ne kacisli ne yorumlanmis
  });
});
