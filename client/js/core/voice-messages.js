// core/voice-messages.js
// Sesli mesaj kaydı ve gönderimi

let voiceRecorder  = null;
let voiceChunks    = [];
let voiceRecording = false;

async function startVoiceRecord() {
  if (voiceRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks  = [];
    voiceRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    voiceRecorder.ondataavailable = e => { if (e.data.size > 0) voiceChunks.push(e.data); };
    voiceRecorder.onstop = sendVoiceMessage;
    voiceRecorder.start();
    voiceRecording = true;
    const btn = document.getElementById('btn-voice-msg');
    if (btn) { btn.style.color = 'var(--red)'; btn.style.transform = 'scale(1.2)'; }
    toast('🎤 Kayıt başladı... Bırakınca gönderilir', '');
  } catch {
    toast('Mikrofon erişimi reddedildi', 'error');
  }
}

function stopVoiceRecord() {
  if (!voiceRecording || !voiceRecorder) return;
  voiceRecorder.stop();
  voiceRecorder.stream?.getTracks().forEach(t => t.stop());
  voiceRecording = false;
  const btn = document.getElementById('btn-voice-msg');
  if (btn) { btn.style.color = ''; btn.style.transform = ''; }
}

async function sendVoiceMessage() {
  if (!voiceChunks.length || !currentChannel) return;
  const blob = new Blob(voiceChunks, { type: 'audio/webm' });
  if (blob.size < 1000) return toast('Kayıt çok kısa', 'error');
  const formData = new FormData();
  formData.append('audio', blob, 'voice.webm');
  formData.append('channelId', currentChannel._id);
  formData.append('serverId', currentServer._id);
  formData.append('duration', '0');
  try {
    const tkn = localStorage.getItem('token');
    const r = await fetch(`${API}/api/voice-messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tkn}` },
      body: formData,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    toast('🎤 Sesli mesaj gönderildi', 'success');
  } catch (e) {
    toast('Sesli mesaj gönderilemedi: ' + e.message, 'error');
  }
}

export {
  sendVoiceMessage,
  startVoiceRecord,
  stopVoiceRecord,
};

