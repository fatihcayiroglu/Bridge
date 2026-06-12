# Sprint 100 — Tip Güvenliği Tamamlama (music.ts)

> **Hedef:** Sprint 99 kod denetiminde tespit edilen `server/music.ts` tip açıklarını kapatmak; projeyi `strict: true` altında tam tip-güvenli hale getirmek.

---

## 1. 🔴 `server/music.ts` — Implicit `any` Parametreler Giderildi

### Problem

Sprint 99'da `server/routes/music.ts → server/music.ts` taşıması yapılmış; import kırıkları düzeltilmişti.  
Ancak dosya içinde 4 fonksiyon untyped parametre taşıyordu — `strict: true` + `noImplicitAny: true` altında TypeScript derleme hatası üretir:

| Fonksiyon | Sorunlu Parametre |
|-----------|-------------------|
| `getVideoInfo(url)` | `url: any` |
| `clearQueue(channelId)` | `channelId: any` |
| `handleMusicCommand(command, args, channelId, io)` | tüm parametreler `any` |
| `skipCurrent` | return type `void` — ama `MusicTrack \| null` döndürüyor |

Ek olarak `const queues = {}` index signature eksikti → `queues[channelId]` erişimleri implicit `any`.

### Değişiklikler

**Yeni interface'ler eklendi:**

```ts
export interface MusicTrack {
  title:        string;
  duration:     number;
  url:          string;
  streamUrl?:   string;
  requestedBy?: string;
}

export interface MusicQueue {
  current: MusicTrack | null;
  queue:   MusicTrack[];
}

export type MusicCommandResult =
  | { nowPlaying: MusicTrack }
  | { queued: MusicTrack; position: number }
  | { stopped: true }
  | { current: MusicTrack | null; queue: MusicTrack[] }
  | { commands: string[] }
  | { error: string }
  | false;
```

**`queues` index signature:**
```ts
// Önce:
const queues = {};
// Sonra:
const queues: Record<string, MusicQueue> = {};
```

**`skipCurrent` return type düzeltildi:**
```ts
// Önce:
function skipCurrent(channelId: string): void { ... return q.current; }
// Sonra:
export function skipCurrent(channelId: string): MusicTrack | null { ... return q.current; }
```

**`handleMusicCommand` tam tip imzası:**
```ts
export async function handleMusicCommand(
  command:   string,
  args:      string[],
  channelId: string,
  _io:       unknown,
): Promise<MusicCommandResult>
```

---

## 2. 🟠 `server/socket/handlers/music.ts` — `catch` Bloğu Tip Güvenliği

### Problem

```ts
} catch (e) {
  const safeMsg = (e.message || '').startsWith(...) ...
```

`catch` parametresi `unknown` tipindedir; `e.message` doğrudan erişim TypeScript 4.0+ hata verir.

### Değişiklik

```ts
} catch (e: unknown) {
  const msg     = e instanceof Error ? e.message : '';
  const safeMsg = (msg.startsWith('Only YouTube') || msg.startsWith('Could not'))
    ? msg
    : 'Could not process that URL.';
```

---

## 3. 🟡 `server/socket/handlers/music.ts` — Import Temizliği

`import` satırı `type` prefix'li hale getirildi; `MusicTrack` interface socket handler'da da kullanılıyor:

```ts
import type { Server, Socket } from 'socket.io';
import { ..., type MusicTrack } from '../../music';
```

Gereksiz `// @ts-ignore` / inline import kaldırıldı.

---

## Özet

| # | Tür | Dosya | Açıklama |
|---|-----|-------|----------|
| 1 | 🔴 Kritik | `server/music.ts` | 4 untyped param + index signature + yanlış return type |
| 2 | 🟠 Orta | `server/socket/handlers/music.ts` | `catch (e: unknown)` + instanceof guard |
| 3 | 🟡 Küçük | `server/socket/handlers/music.ts` | `import type`, `MusicTrack` kullanımı |

## Etkilenen Dosyalar

| Dosya | Değişiklik |
|-------|------------|
| `server/music.ts` | Interface'ler eklendi, tüm fonksiyonlar tam tipli |
| `server/socket/handlers/music.ts` | `catch` guard + `import type` |
| `SPRINT100_CHANGES.md` | Bu dosya |

## Sprint 99 Sonrası Durum

Sprint 99 + Sprint 100 tamamlandığında `server/` dizini `npx tsc -p server/tsconfig.json --noEmit` ile sıfır hata verir.
