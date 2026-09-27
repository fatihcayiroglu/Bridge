// client/js/core/dm-call/dm-call-protocol.ts
//
// FAZ 8/1 — DM ARAMA SINYALLESME SOZLESMESI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `DmCallPanel.svelte` sunucununkinden FARKLI bir protokol konusuyordu. Uc
// bagimsiz kopukluk vardi ve her biri tek basina aramayi olduruyordu:
//
//   1. `callId`i ISTEMCI uretiyordu (`call_<ts>_<rand>`). Sunucu `dm:call:start`
//      aldiginda KENDI uuid'sini uretir ve `dm:call:outgoing` ile geri bildirir;
//      istemcinin uydurdugu kimlik `activeDmCalls`te HIC bulunmaz, bu yuzden
//      sonraki her sinyal `callParticipant()` denetiminde sessizce dusurulurdu.
//   2. `dm:call:start` govdesi `{ targetUserId, offer }` gonderiyordu; sunucu
//      semasi `{ toUserId, type }` bekler (middleware/validate.ts:284) ve
//      teklifi AYRI bir `dm:call:offer` olayinda alir.
//   3. Yanit yolu iki yerden kopuktu: istemci `{ callId, answer }` gonderiyordu
//      ama sunucu `targetUserId` de ister (`signalPeer` onsuz null doner) ve
//      istemci `dm:call:answered` dinliyordu — sunucu boyle bir olay YAYMAZ
//      (`dm:call:accepted` ve `dm:call:answer` yayar).
//
// Sonuc: arama CALARDI ama HICBIR ZAMAN baglanmazdi.
//
// ── BU MODULUN ISI ────────────────────────────────────────────────────────
// Protokolu tek yerde, WebRTC ve DOM'dan bagimsiz olarak tutmak. Boylece
// sozlesme gercek tarayici olmadan test edilebilir ve sunucu semasiyla
// karsilastirilabilir. WebRTC ve arayuz bilesende kalir.
//
// ── YETKI ─────────────────────────────────────────────────────────────────
// Yetkilendirme SUNUCUDADIR: `callParticipant()` cagiranin o gorusmenin iki
// ucundan biri oldugunu, `signalPeer()` de hedefin DIGER uc oldugunu dogrular.
// Bu modul o denetimleri ATLAMAZ; yalnizca sunucunun bekledigi alanlari
// dogru doldurur. Eksik alan gondermek denetimi atlatmaz — sessizce dusurur.

/** Sunucunun kabul ettigi olaylar (socket/handlers/dm.ts). */
export const OUTBOUND = {
  start:   'dm:call:start',
  accept:  'dm:call:accept',
  decline: 'dm:call:decline',
  end:     'dm:call:end',
  offer:   'dm:call:offer',
  answer:  'dm:call:answer',
  ice:     'dm:call:ice',
} as const;

/** Sunucunun yaydigi olaylar. */
export const INBOUND = {
  incoming: 'dm:call:incoming',
  outgoing: 'dm:call:outgoing',
  accepted: 'dm:call:accepted',
  ready:    'dm:call:ready',
  declined: 'dm:call:declined',
  missed:   'dm:call:missed',
  offer:    'dm:call:offer',
  answer:   'dm:call:answer',
  ice:      'dm:call:ice',
  ended:    'dm:call:ended',
} as const;

export type CallType = 'voice' | 'video';
export type CallRole = 'caller' | 'callee';
export type CallStatus = 'idle' | 'ringing' | 'connecting' | 'active' | 'ended';

export interface CallSession {
  callId: string;
  /** Karsi tarafin KULLANICI kimligi — her sinyalde ZORUNLU. */
  peerUserId: string;
  type: CallType;
  role: CallRole;
}

// ── Giden govdeler ─────────────────────────────────────────────────────────
//
// Her biri sunucu semasiyla BIREBIR ayni alan adlarini kullanir. Alan adini
// burada tek yerde tutmak, uc ayri cagri yerinde sessizce sapmayi onler.

/** `dm:call:start` — DIKKAT: `toUserId`, `targetUserId` DEGIL. Teklif YOK. */
export function startPayload(toUserId: string, type: CallType) {
  return { toUserId, type };
}

/** `dm:call:accept` / `dm:call:decline` / `dm:call:end` — yalnizca `callId`. */
export function callIdPayload(callId: string) {
  return { callId };
}

/** `dm:call:offer` — `targetUserId` olmadan sunucu sinyali DUSURUR. */
export function offerPayload(session: CallSession, offer: unknown) {
  return { callId: session.callId, targetUserId: session.peerUserId, offer };
}

/** `dm:call:answer` — ayni sekilde `targetUserId` zorunludur. */
export function answerPayload(session: CallSession, answer: unknown) {
  return { callId: session.callId, targetUserId: session.peerUserId, answer };
}

/** `dm:call:ice` — ayni. */
export function icePayload(session: CallSession, candidate: unknown) {
  return { callId: session.callId, targetUserId: session.peerUserId, candidate };
}

// ── Gelen govdeler ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface IncomingCall {
  callId: string;
  type: CallType;
  callerId: string;
  callerDisplayName: string;
  callerAvatarColor?: string;
}

/**
 * `dm:call:incoming` govdesini cozer.
 *
 * Eski istemci `callerName` / `callerAvatar` okuyordu; sunucu
 * `callerDisplayName` / `callerAvatarColor` yayar. Yanlis alan adi, gelen
 * arama ekraninda ISIMSIZ bir arayan demekti.
 */
export function parseIncoming(payload: unknown): IncomingCall | null {
  const data = asRecord(payload);
  const callId = String(data?.callId ?? '');
  const callerId = String(data?.callerId ?? '');
  if (!callId || !callerId) return null;

  const type = data?.type === 'video' ? 'video' : 'voice';
  return {
    callId,
    type,
    callerId,
    callerDisplayName: String(data?.callerDisplayName ?? ''),
    callerAvatarColor: typeof data?.callerAvatarColor === 'string' ? data.callerAvatarColor : undefined,
  };
}

export interface ReadySignal { callId: string; role: CallRole; type: CallType }

/**
 * `dm:call:ready` — WebRTC'nin BASLAMA isareti.
 *
 * Kritik: TEKLIFI kim uretecegini bu olay belirler. Sunucu her iki tarafa da
 * kendi rolunu soyler; yalnizca `caller` teklif olusturur. Eski istemci bu
 * olayi hic dinlemiyor ve teklifi `start` ile birlikte gonderiyordu — yani
 * karsi taraf daha kabul etmeden.
 */
export function parseReady(payload: unknown): ReadySignal | null {
  const data = asRecord(payload);
  const callId = String(data?.callId ?? '');
  if (!callId) return null;
  const role: CallRole = data?.role === 'caller' ? 'caller' : 'callee';
  return { callId, role, type: data?.type === 'video' ? 'video' : 'voice' };
}

/** `dm:call:outgoing` — sunucunun urettigi KANONIK `callId`. */
export function parseOutgoing(payload: unknown): { callId: string; type: CallType; toUserId: string } | null {
  const data = asRecord(payload);
  const callId = String(data?.callId ?? '');
  if (!callId) return null;
  return {
    callId,
    type: data?.type === 'video' ? 'video' : 'voice',
    toUserId: String(data?.toUserId ?? ''),
  };
}

/** Yalnizca AKTIF gorusmenin sinyalleri kabul edilir. */
export function isForCall(session: CallSession | null, payload: unknown): boolean {
  if (!session) return false;
  const callId = asRecord(payload)?.callId;
  return typeof callId === 'string' && callId === session.callId;
}

/** `dm:call:accepted` govdesi — arayan tarafa gosterilecek ad. */
export function parseAccepted(payload: unknown): { callId: string; calleeDisplayName: string } | null {
  const data = asRecord(payload);
  const callId = String(data?.callId ?? '');
  if (!callId) return null;
  return { callId, calleeDisplayName: String(data?.calleeDisplayName ?? '') };
}
