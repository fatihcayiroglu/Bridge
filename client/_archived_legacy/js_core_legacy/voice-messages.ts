// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VoiceMessagesPanel.svelte
//              client/js/core/voice-messages-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { apiFetch } from './api-fetch.js';
import { getAPI, getCurrentChannel, getCurrentServer } from './globals.js';
import { toast } from './utils.js';
// core/voice-messages.ts
// Sesli mesaj kaydı ve gönderimi

let voiceRecorder:  MediaRecorder | null = null;
let voiceChunks:    BlobPart[]           = [];
let voiceRecording: boolean              = false;

export async function startVoiceRecord(): Promise<void> {
  if (voiceRecording) return;
  try {
    const stream  = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks   = [];
    voiceRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    voiceRecorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) voiceChunks.push(e.data); };
    voiceRecorder.onstop          = sendVoiceMessage;
    voiceRecorder.start();
    voiceRecording = true;

    const btn = document.getElementById('btn-voice-msg') as HTMLElement | null;
    if (btn) { btn.style.color = 'var(--red)'; btn.style.transform = 'scale(1.2)'; }
    toast('🎤 Kayıt başladı... Bırakınca gönderilir', 'info');
  } catch {
    toast('Mikrofon erişimi reddedildi', 'error');
  }
}

export function stopVoiceRecord(): void {
  if (!voiceRecording || !voiceRecorder) return;
  voiceRecorder.stop();
  (voiceRecorder as { stream?: MediaStream }).stream?.getTracks().forEach((t) => t.stop());
  voiceRecording = false;
  const btn = document.getElementById('btn-voice-msg') as HTMLElement | null;
  if (btn) { btn.style.color = ''; btn.style.transform = ''; }
}

export async function sendVoiceMessage(): Promise<void> {
  const currentChannel = getCurrentChannel() as { _id: string; serverId?: string } | null;
  const currentServer  = getCurrentServer()  as { _id: string } | null;
  if (!voiceChunks.length || !currentChannel) return;

  const blob = new Blob(voiceChunks, { type: 'audio/webm' });
  if (blob.size < 1000) { toast('Kayıt çok kısa', 'error'); return; }

  const formData = new FormData();
  formData.append('audio',     blob, 'voice.webm');
  formData.append('channelId', currentChannel._id);
  formData.append('serverId',  currentServer._id);
  formData.append('duration',  '0');

  try {
    const tkn = localStorage.getItem('token') ?? '';
    const r   = await apiFetch(`${getAPI()}/api/voice-messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tkn}` },
      body:    formData,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    toast('🎤 Sesli mesaj gönderildi', 'success');
  } catch (e: unknown) {
    toast('Sesli mesaj gönderilemedi: ' + (e instanceof Error ? e.message : String(e)), 'error');
  }
}
