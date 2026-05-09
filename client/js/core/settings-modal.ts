// client/js/core/settings-modal.js
// Ayarlar modali (profil, AI, E2EE, aktivite)
// misc.js'den ayrÄ±ÅŸtÄ±rÄ±ldÄ±

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AYARLAR MODALÄ°
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function openSettings() {
  if (!window.me) return;

  // Cihaz ekleme/Ã§Ä±karma olunca cache'i temizle (bir kez baÄŸla)
  if (!window._deviceChangeListenerBound) {
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      window._voiceDevicesCache = null;
    });
    window._deviceChangeListenerBound = true;
  }

  // Partial henÃ¼z yÃ¼klenmediyse Ã¶nce yÃ¼kle (settings-modal.html lazy-loaded)
  if (window.Partials) {
    await Partials.ensureLoaded('settings');
  }

  // Form alanlarÄ±nÄ± doldur
  const fields = {
    's-displayname': me.displayName,
    's-status':      me.status || 'online',
    's-bio':         me.bio || '',
    's-website':     me.website || '',
    's-location':    me.location || '',
    's-pronouns':    me.pronouns || '',
    's-banner-color': me.bannerColor || '#5865f2',
    's-badge':       me.badge || '',
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  // Rozet Ã¶n izlemesi
  const badgePreview = document.getElementById('s-badge-preview');
  if (badgePreview && me.badge) {
    badgePreview.innerHTML = `<span style="display:inline-block;padding:2px 8px;background:var(--brand);color:#fff;border-radius:4px;font-size:12px;font-weight:600">${escHtml(me.badge)}</span>`;
  }

  // Banner Ã¶nizlemesi
  const wrap = document.getElementById('banner-preview-wrap');
  const img  = document.getElementById('banner-preview-img');
  if (wrap && img) {
    if (me.bannerUrl) {
      img.src = API + me.bannerUrl;
      wrap.style.display = 'block';
    } else {
      wrap.style.display = 'none';
      img.src = '';
    }
  }

  updateProfilePreview();

  // CanlÄ± Ã¶nizleme iÃ§in event listener
  ['s-displayname', 's-bio', 's-banner-color'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateProfilePreview);
  });

  // Alt bilgi bÃ¶lÃ¼mlerini yÃ¼kle
  _loadAIStatusInSettings();
  _loadE2EStatusInSettings();
  _loadActivityInSettings();
  window.WebPush?.syncToggleUI();

  document.getElementById('settings-modal').style.display = 'flex';

  // Ses & Video cihazlarÄ±nÄ± yÃ¼kle
  loadVoiceDeviceSettings();

  // NS UI senkronize et
  window.dispatchEvent(new CustomEvent('bridge:settings-opened'));

//   Sosyal baÄŸlantÄ±larÄ± yÃ¼kle
  if (typeof loadConnectionsSettings === 'function') loadConnectionsSettings();
  _initChatBgPanel();
}

// â”€â”€ AI Durumu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _loadAIStatusInSettings() {
  const el = document.getElementById('ai-status-info');
  if (!el) return;
  try {
    const r    = await apiFetch(`${API}/api/ai/status`);
    const data = await r.json();
    if (data.enabled) {
      const features = Object.entries(data.features)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');
      el.innerHTML    = `âœ… AI aktif â€” Provider: <strong>${data.provider}</strong><br>Ã–zellikler: ${features}`;
      el.style.color  = 'var(--green)';
    } else {
      el.textContent  = 'âš ï¸ AI aktif deÄŸil â€” .env dosyasÄ±na GROQ_API_KEY (Ã¼cretsiz: groq.com) ekleyin.';
      el.style.color  = 'var(--yellow)';
    }
  } catch {
    el.textContent = 'âŒ AI durumu alÄ±namadÄ±';
    el.style.color = 'var(--red)';
  }
}

// â”€â”€ E2EE Durumu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _loadE2EStatusInSettings() {
  const el  = document.getElementById('e2e-status-info');
  const btn = document.getElementById('e2e-toggle-btn');
  if (!el) return;
  try {
    const r    = await apiFetch(`${API}/api/e2e/status`);
    const data = await r.json();
    if (data.enabled) {
      el.innerHTML   = `ğŸŸ¢ <strong>Aktif</strong> â€” DM mesajlarÄ±nÄ±z ÅŸifreleniyor`;
      el.style.color = 'var(--green)';
      if (btn) btn.textContent = 'ğŸ”’';
    } else {
      el.innerHTML   = `â­• <strong>Devre dÄ±ÅŸÄ±</strong> â€” Åifreleme baÅŸlatÄ±lmamÄ±ÅŸ`;
      el.style.color = 'var(--text-muted)';
      if (btn) btn.textContent = 'ğŸ”“';
    }
  } catch {
    el.textContent = 'E2EE durumu alÄ±namadÄ±';
  }
}

// â”€â”€ Aktivite Durumu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _loadActivityInSettings() {
  const el       = document.getElementById('current-activity-display');
  if (!el) return;
  const activity = window.me?.activity;
  if (activity) {
    const icons = {
      playing: 'ğŸ®', listening: 'ğŸµ', watching: 'ğŸ“º',
      streaming: 'ğŸ”´', coding: 'ğŸ’»', reading: 'ğŸ“š', custom: 'âœï¸',
    };
    const icon   = icons[activity.type] || 'âœï¸';
    const detail = activity.detail ? ` â€” ${escHtml(activity.detail)}` : '';
    el.innerHTML   = `${icon} <strong>${escHtml(activity.name || '')}</strong>${detail}`;
    el.style.color = 'var(--text-normal)';
  } else {
    el.textContent = 'Aktif aktivite yok';
    el.style.color = 'var(--text-muted)';
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AYARLARI KAYDET
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function saveSettings() {
  const getValue = id => document.getElementById(id)?.value ?? '';

  const payload = {
    displayName: getValue('s-displayname').trim(),
    status:      getValue('s-status'),
    bio:         getValue('s-bio'),
    website:     getValue('s-website').trim(),
    location:    getValue('s-location').trim(),
    pronouns:    getValue('s-pronouns').trim(),
    bannerColor: getValue('s-banner-color'),
    // Ses kalitesi tercihlerini profille birlikte sunucuya gÃ¶nder
    audioPrefs:  _getAudioPrefs(),
  };

  try {
    const r    = await apiFetch(`${API}/api/me`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const user = await r.json();
    if (!r.ok) return toast(user.error, 'error');

    if (typeof updateUserPanel === 'function') updateUserPanel(user);

    // Sunucu kaydÄ±ndan baÄŸÄ±msÄ±z olarak aktif aramalara bitrate'i anlÄ±k uygula
    const { bitrate, stereo } = _getAudioPrefs();
    _applyBitrateToAllPeers(bitrate, stereo);

    const tagMap = {
      online: 'Online', idle: 'Idle',
      dnd: 'Do Not Disturb', offline: 'Invisible',
    };
    const tagEl = document.getElementById('my-tag');
    if (tagEl) tagEl.textContent = tagMap[payload.status] || 'Online';

    closeModal('settings-modal');
    toast('Ayarlar kaydedildi', 'success');
  } catch {
    toast('Ayarlar kaydedilemedi', 'error');
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SES & VÄ°DEO AYARLARI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function loadVoiceDeviceSettings(forceRefresh = false) {
  if (!window.rtc) return;

  // Cihaz listesi sayfa aÃ§Ä±kken deÄŸiÅŸmez â€” cache'den oku
  if (!forceRefresh && window._voiceDevicesCache) {
    _applyVoiceDevicesToUI(window._voiceDevicesCache);
    return;
  }
  const devices = await rtc.getDevices();
  window._voiceDevicesCache = devices;
  const { microphones, speakers, cameras } = devices;

  // Mikrofon listesi
  const micSel = document.getElementById('voice-mic-select');
  if (micSel) {
    micSel.innerHTML = microphones.length
      ? microphones.map(d => `<option value="${d.deviceId}"${d.deviceId === rtc.selectedMicId ? ' selected' : ''}>${escHtml(d.label || 'Mikrofon ' + (microphones.indexOf(d)+1))}</option>`).join('')
      : '<option value="">Mikrofon bulunamadÄ±</option>';
  }

  // HoparlÃ¶r listesi
  const spkSel = document.getElementById('voice-speaker-select');
  if (spkSel) {
    if (speakers.length) {
      spkSel.innerHTML = speakers.map(d => `<option value="${d.deviceId}"${d.deviceId === rtc.selectedSpeakerId ? ' selected' : ''}>${escHtml(d.label || 'HoparlÃ¶r ' + (speakers.indexOf(d)+1))}</option>`).join('');
      spkSel.closest('.form-group')?.querySelector('.no-sinkid-warn')?.remove();
    } else {
      spkSel.innerHTML = '<option value="">HoparlÃ¶r bulunamadÄ±</option>';
    }
  }

  // setSinkId desteÄŸi yoksa uyarÄ± gÃ¶ster
  const testEl = document.createElement('audio');
  if (typeof testEl.setSinkId !== 'function') {
    const warn = document.createElement('p');
    warn.className = 'no-sinkid-warn';
    warn.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:4px;';
    warn.textContent = 'âš ï¸ TarayÄ±cÄ±nÄ±z hoparlÃ¶r seÃ§imini desteklemiyor (Chrome/Edge Ã¶nerilir)';
    spkSel?.parentElement?.appendChild(warn);
  }

  // Kamera listesi
  const camSel = document.getElementById('voice-camera-select');
  if (camSel) {
    camSel.innerHTML = cameras.length
      ? cameras.map(d => `<option value="${d.deviceId}"${d.deviceId === rtc.selectedCameraId ? ' selected' : ''}>${escHtml(d.label || 'Kamera ' + (cameras.indexOf(d)+1))}</option>`).join('')
      : '<option value="">Kamera bulunamadÄ±</option>';
  }

  // Mikrofon test Ã§ubuÄŸu â€” ses seviyesi gÃ¶stergesi
  _startMicTest();
}

let _micTestStream = null;
let _micTestAnim  = null;

async function _startMicTest() {
  _stopMicTest();
  const bar = document.getElementById('mic-test-bar');
  if (!bar) return;
  try {
    const micId = document.getElementById('voice-mic-select')?.value;
    const constraints = micId ? { audio: { deviceId: { exact: micId } } } : { audio: true };
    _micTestStream = await navigator.mediaDevices.getUserMedia(constraints);
    const ctx      = new AudioContext();
    const src      = ctx.createMediaStreamSource(_micTestStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b) => a+b, 0) / data.length;
      const pct = Math.min(100, Math.round(avg * 2.5));
      bar.style.width = pct + '%';
      bar.style.background = pct > 70 ? 'var(--red)' : pct > 40 ? 'var(--yellow)' : 'var(--green)';
      _micTestAnim = requestAnimationFrame(tick);
    }
    tick();
  } catch {
    if (bar) bar.style.width = '0%';
  }
}

function _stopMicTest() {
  if (_micTestAnim) { cancelAnimationFrame(_micTestAnim); _micTestAnim = null; }
  if (_micTestStream) { _micTestStream.getTracks().forEach(t => t.stop()); _micTestStream = null; }
  const bar = document.getElementById('mic-test-bar');
  if (bar) bar.style.width = '0%';
}

async function applyMicChange() {
  const val = document.getElementById('voice-mic-select')?.value;
  if (val && window.rtc) {
    await rtc.setMicDevice(val);
    _startMicTest();
  }
}

async function applySpeakerChange() {
  const val = document.getElementById('voice-speaker-select')?.value;
  if (val && window.rtc) await rtc.setSpeakerDevice(val);
}

async function applyCameraChange() {
  const val = document.getElementById('voice-camera-select')?.value;
  if (val && window.rtc) await rtc.setCameraDevice(val);
}

// â”€â”€ SES KALÄ°TESÄ° (Bitrate / Codec / Stereo / Echo / AGC) â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * localStorage'daki ses tercihlerini dÃ¶ndÃ¼rÃ¼r (varsayÄ±lanlarla birlikte).
 */
function _getAudioPrefs() {
  try {
    return {
      bitrate: 128000,
      codec:   'opus',
      stereo:  true,
      echo:    false,   // echoCancellation
      agc:     false,   // autoGainControl
      ...JSON.parse(localStorage.getItem('bridgeAudioQuality') || '{}'),
    };
  } catch (_) {
    return { bitrate: 128000, codec: 'opus', stereo: true, echo: false, agc: false };
  }
}

function _saveAudioPrefs(patch) {
  try {
    const prefs = _getAudioPrefs();
    localStorage.setItem('bridgeAudioQuality', JSON.stringify({ ...prefs, ...patch }));
  } catch (_) {}
}

/**
 * TÃ¼m aktif RTCPeerConnection sender'larÄ±na maxBitrate + stereo uygular.
 * BridgeRTC peers Map'ini doÄŸrudan kullanÄ±r.
 */
function _applyBitrateToAllPeers(bps, stereo) {
  const peers = window.rtc?.peers;   // Map<socketId, RTCPeerConnection>
  if (!peers?.size) return;

  peers.forEach(pc => {
    pc.getSenders().forEach(async sender => {
      if (sender.track?.kind !== 'audio') return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = bps;
        // Opus stereo parametresi codec sdpFmtpLine Ã¼zerinden
        if (params.codecs) {
          for (const c of params.codecs) {
            if (c.mimeType?.toLowerCase() === 'audio/opus') {
              const parts = (c.sdpFmtpLine || '')
                .split(';')
                .map(p => p.trim())
                .filter(p => p && !/^(stereo|sprop-stereo|maxaveragebitrate)/i.test(p));
              parts.push(`stereo=${stereo ? 1 : 0}`);
              parts.push(`sprop-stereo=${stereo ? 1 : 0}`);
              parts.push(`maxaveragebitrate=${bps}`);
              c.sdpFmtpLine = parts.join(';');
            }
          }
        }
        await sender.setParameters(params);
      } catch (e) { console.warn('[AudioQuality] setParameters:', e); }
    });
  });
}

/**
 * Bitrate seÃ§ildiÄŸinde Ã§aÄŸrÄ±lÄ±r.
 * @param {string} bitrate  bps string, Ã¶rn: '32000'
 * @param {string} codec    'opus' | 'pcmu' | 'isac'
 */
function applyAudioQuality(bitrate, codec) {
  const bps    = parseInt(bitrate, 10);
  const prefs  = _getAudioPrefs();
  const stereo = prefs.stereo;

  _saveAudioPrefs({ bitrate: bps, codec: codec || prefs.codec });
  _applyBitrateToAllPeers(bps, stereo);
  _audioQualityStatusUpdate();
  toast(`Ses kalitesi: ${Math.round(bps / 1000)} kbps`, 'success');
}

/**
 * Codec seÃ§ildiÄŸinde Ã§aÄŸrÄ±lÄ±r.
 * Codec deÄŸiÅŸimi SDP yeniden mÃ¼zakeresi gerektirir â€” aktif aramdaysa uyar.
 * @param {string} codec  'opus' | 'pcmu' | 'isac'
 */
function applyAudioCodec(codec) {
  _saveAudioPrefs({ codec });
  // isInVoice() â€” BridgeRTC'nin gerÃ§ek metodu
  if (window.rtc?.isInVoice?.()) {
    toast('Codec deÄŸiÅŸimi bir sonraki aramada uygulanacak', 'info');
  } else {
    toast(`Codec: ${codec.toUpperCase()} seÃ§ildi`, 'success');
  }
  _audioQualityStatusUpdate();
}

/**
 * Stereo toggle.
 * @param {boolean} on
 */
function applyAudioStereo(on) {
  const prefs = _getAudioPrefs();
  _saveAudioPrefs({ stereo: on });
  _applyBitrateToAllPeers(prefs.bitrate, on);
  _audioQualityStatusUpdate();
  toast(on ? 'Stereo ses aÃ§Ä±ldÄ±' : 'Mono ses aÃ§Ä±ldÄ±', 'success');
}

/**
 * Echo cancellation / Auto gain control toggle.
 * DeÄŸiÅŸiklik mikrofon track'ini yeniden aÃ§mayÄ± gerektirir.
 * @param {'echo'|'agc'} key
 * @param {boolean} on
 */
async function applyAudioConstraint(key, on) {
  _saveAudioPrefs({ [key]: on });

  const track = window.rtc?.localStream?.getAudioTracks()?.[0];
  if (track?.applyConstraints) {
    try {
      await track.applyConstraints({
        echoCancellation:  key === 'echo' ? on : _getAudioPrefs().echo,
        autoGainControl:   key === 'agc'  ? on : _getAudioPrefs().agc,
      });
      const label = key === 'echo' ? 'Eko giderme' : 'Otomatik kazanÃ§';
      toast(`${label} ${on ? 'aÃ§Ä±ldÄ±' : 'kapatÄ±ldÄ±'}`, 'success');
    } catch (e) {
      toast('KÄ±sÄ±tlama uygulanamadÄ± â€” mikrofonu yeniden baÅŸlatÄ±n', 'error');
    }
  } else {
    // Track yoksa (sessizde) sadece kaydet; arama aÃ§Ä±lÄ±nca uygulanÄ±r
    const label = key === 'echo' ? 'Eko giderme' : 'Otomatik kazanÃ§';
    toast(`${label} ${on ? 'aÃ§Ä±lacak' : 'kapatÄ±lacak'} (sonraki aramada)`, 'info');
  }
}

function _audioQualityStatusUpdate() {
  try {
    const { bitrate, codec, stereo } = _getAudioPrefs();
    const kbps  = Math.round(bitrate / 1000);
    const ch    = stereo ? 'Stereo' : 'Mono';
    const status = document.getElementById('audio-quality-status');
    if (status) status.textContent = `${codec.toUpperCase()} â€¢ ${kbps} kbps â€¢ ${ch}`;
  } catch (_) {}
}

function _audioQualityUiSync() {
  try {
    const { bitrate, codec, stereo, echo, agc } = _getAudioPrefs();

    document.querySelectorAll('input[name="audio-bitrate"]').forEach(r => {
      r.checked = r.value === String(bitrate);
    });
    document.querySelectorAll('input[name="audio-codec"]').forEach(r => {
      r.checked = r.value === codec;
    });

    const stereoEl = document.getElementById('audio-stereo-toggle');
    if (stereoEl) stereoEl.checked = stereo;
    _updateToggleTrack('audio-stereo', stereo);

    const echoEl = document.getElementById('audio-echo-toggle');
    if (echoEl) echoEl.checked = echo;
    _updateToggleTrack('audio-echo', echo);

    const agcEl = document.getElementById('audio-agc-toggle');
    if (agcEl) agcEl.checked = agc;
    _updateToggleTrack('audio-agc', agc);

    _audioQualityStatusUpdate();
  } catch (_) {}
}

/** KÃ¼Ã§Ã¼k toggle track/thumb gÃ¼ncelleyici (NS toggle'a benzer) */
function _updateToggleTrack(prefix, on) {
  const track = document.getElementById(`${prefix}-track`);
  const thumb = document.getElementById(`${prefix}-thumb`);
  if (track) track.style.background = on ? 'var(--green,#43b581)' : '';
  if (thumb) thumb.style.transform  = on ? 'translateX(20px)' : 'translateX(0)';
}

window.addEventListener('bridge:settings-opened', _audioQualityUiSync);

// â”€â”€ EKRAN PAYLAÅIMI KALÄ°TESÄ° (Preset / Bitrate Override) â”€â”€â”€â”€â”€â”€â”€â”€

const _SS_BITRATE_MAP = {
  '4k60':    20_000_000,
  '1440p60': 12_000_000,
  '1440p':   10_000_000,
  '1080p60':  8_000_000,
  '1080p':    5_000_000,
  '720p':     3_000_000,
  'hd':       1_500_000,
};

const _SS_FPS_MAP = {
  '4k60': 60, '1440p60': 60, '1440p': 30,
  '1080p60': 60, '1080p': 30, '720p': 30, 'hd': 30,
};

function _getSSPrefs() {
  try {
    return {
      preset:     'ask',
      bitrateKbps: 0,
      ...JSON.parse(localStorage.getItem('bridgeSSQuality') || '{}'),
    };
  } catch (_) {
    return { preset: 'ask', bitrateKbps: 0 };
  }
}

function _saveSSPrefs(patch) {
  try {
    localStorage.setItem('bridgeSSQuality', JSON.stringify({ ..._getSSPrefs(), ...patch }));
  } catch (_) {}
}

/**
 * Preset veya bitrateKbps deÄŸiÅŸtiÄŸinde Ã§aÄŸrÄ±lÄ±r.
 * @param {{ preset?: string, bitrateKbps?: number }} patch
 */
function applyScreenSharePrefs(patch) {
  _saveSSPrefs(patch);
  _ssQualityUiSync();
  toast('Ekran paylaÅŸÄ±mÄ± tercihi kaydedildi', 'success');
}

/**
 * Aktif ekran paylaÅŸÄ±mÄ±ndaki tÃ¼m video sender'larÄ±na anlÄ±k maxBitrate uygular.
 */
async function applyScreenShareBitrateNow() {
  if (!window.rtc?.screenSharing) {
    toast('Aktif ekran paylaÅŸÄ±mÄ± yok', 'error');
    return;
  }

  const { preset, bitrateKbps } = _getSSPrefs();
  const bps = bitrateKbps > 0
    ? bitrateKbps * 1000
    : (_SS_BITRATE_MAP[preset] || 5_000_000);

  const fps = _SS_FPS_MAP[preset] || 30;

  const peers = window.rtc?.peers;
  if (!peers?.size) { toast('BaÄŸlÄ± peer yok', 'error'); return; }

  let applied = 0;
  for (const pc of peers.values()) {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate  = bps;
      params.encodings[0].maxFramerate = fps;
      await sender.setParameters(params);
      applied++;
    } catch (e) { console.warn('[SS bitrate]', e); }
  }

  _ssQualityStatusUpdate();
  toast(`Ekran paylaÅŸÄ±mÄ±: ${Math.round(bps / 1000)} kbps @ ${fps}fps uygulandÄ± (${applied} peer)`, 'success');
}

function _ssQualityStatusUpdate() {
  const { preset, bitrateKbps } = _getSSPrefs();
  const el = document.getElementById('ss-quality-current');
  const liveWrap = document.getElementById('ss-apply-live-wrap');

  if (el) {
    const isSharing = window.rtc?.screenSharing;
    if (isSharing) {
      const activeQ = window.rtc?._screenQuality || '?';
      const bps = bitrateKbps > 0 ? bitrateKbps : Math.round((_SS_BITRATE_MAP[activeQ] || 5_000_000) / 1000);
      el.textContent = `Aktif: ${activeQ} â€¢ ${bps} kbps`;
    } else {
      el.textContent = preset === 'ask'
        ? 'Her seferinde sorulacak'
        : `VarsayÄ±lan: ${_ssPresetLabel(preset)}${bitrateKbps > 0 ? ` â€¢ Override: ${bitrateKbps} kbps` : ''}`;
    }
    if (liveWrap) liveWrap.style.display = isSharing ? '' : 'none';
  }
}

function _ssPresetLabel(p) {
  return {
    '4k60': '4K 60fps', '1440p60': '1440p 60fps', '1440p': '1440p 30fps',
    '1080p60': '1080p 60fps', '1080p': '1080p 30fps', '720p': '720p 30fps', 'hd': 'HD',
  }[p] || p;
}

function _ssQualityUiSync() {
  try {
    const { preset, bitrateKbps } = _getSSPrefs();

    document.querySelectorAll('input[name="ss-preset"]').forEach(r => {
      r.checked = r.value === preset;
    });

    const overrideEl = document.getElementById('ss-bitrate-override');
    if (overrideEl) overrideEl.value = bitrateKbps || 0;

    _ssQualityStatusUpdate();
  } catch (_) {}
}

window.addEventListener('bridge:settings-opened', _ssQualityUiSync);

// â”€â”€ PTT UI SYNC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _pttUiSync() {
  if (!window.BridgePTT) return;
  const { enabled, mode, key, releaseDelay, active } = BridgePTT.getStatus();

  // Toggle
  const toggle = document.getElementById('ptt-toggle');
  if (toggle) toggle.checked = enabled;
  const track = document.getElementById('ptt-toggle-track');
  const thumb = document.getElementById('ptt-toggle-thumb');
  if (track) track.style.background = enabled ? 'var(--green,#43b581)' : '';
  if (thumb) thumb.style.transform  = enabled ? 'translateX(20px)' : 'translateX(0)';

  // Status label
  const statusLabel = document.getElementById('ptt-status-label');
  if (statusLabel) statusLabel.textContent = enabled
    ? (key ? `Aktif â€” ${key.label}` : 'Aktif â€” tuÅŸ atanmadÄ±')
    : 'Devre dÄ±ÅŸÄ±';

  // Key display
  const keyDisplay = document.getElementById('ptt-key-display');
  if (keyDisplay) keyDisplay.textContent = key?.label || 'â€”';

  // Mode radios
  document.querySelectorAll('input[name="ptt-mode"]').forEach(r => {
    r.checked = r.value === mode;
  });

  // Release delay
  const delaySlider = document.getElementById('ptt-release-delay');
  const delayVal    = document.getElementById('ptt-delay-val');
  if (delaySlider) delaySlider.value = releaseDelay;
  if (delayVal)    delayVal.textContent = releaseDelay;

  // Dim controls when disabled
  const keyGroup  = document.getElementById('ptt-key-group');
  const modeGroup = document.getElementById('ptt-mode-group');
  const delayGroup = document.getElementById('ptt-delay-group');
  [keyGroup, modeGroup, delayGroup].forEach(el => {
    if (el) el.style.opacity = enabled ? '1' : '0.4';
  });

  // Live status
  const liveEl = document.getElementById('ptt-live-status');
  if (liveEl) {
    if (!enabled)      { liveEl.textContent = 'Devre dÄ±ÅŸÄ±'; liveEl.style.color = ''; }
    else if (active)   { liveEl.textContent = 'ğŸ”´ YayÄ±nda â€” mikrofon aÃ§Ä±k'; liveEl.style.color = 'var(--green,#43b581)'; }
    else               { liveEl.textContent = `â¸ Beklemede (${key?.label ?? 'tuÅŸ atanmadÄ±'})`; liveEl.style.color = ''; }
  }
}

window.addEventListener('bridge:settings-opened', _pttUiSync);

// settings modal kapanÄ±rken mic test'i durdur
const _origCloseModal = window.closeModal;
window.closeModal = function(id) {
  if (id === 'settings-modal') _stopMicTest();
  if (typeof _origCloseModal === 'function') _origCloseModal(id);
};

// â”€â”€ v38: Banner renk kaydet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function saveBannerColor() {
  const color = document.getElementById('s-banner-color')?.value;
  if (!color) return;
  const r = await apiFetch(`${API}/api/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bannerColor: color }),
  });
  if (r.ok) {
    const data = await r.json();
    me = { ...me, bannerColor: data.bannerColor || color };
    window._myUser = me;
    toast('Banner rengi kaydedildi', 'success');
    updateProfilePreview();
  } else {
    const d = await r.json();
    toast(d.error || 'Hata', 'error');
  }
}

// â”€â”€ v38: Rozet kaydet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function saveBadge() {
  const badge = document.getElementById('s-badge')?.value?.trim() || '';
  const r = await apiFetch(`${API}/api/auth/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badge }),
  });
  if (r.ok) {
    const data = await r.json();
    me = { ...me, badge: data.badge || badge };
    window._myUser = me;
    const prev = document.getElementById('s-badge-preview');
    if (prev) prev.innerHTML = badge
      ? `<span style="display:inline-block;padding:2px 8px;background:var(--brand);color:#fff;border-radius:4px;font-size:12px;font-weight:600">${escHtml(badge)}</span>`
      : '';
    toast(badge ? `Rozet kaydedildi: ${badge}` : 'Rozet kaldÄ±rÄ±ldÄ±', 'success');
  } else {
    const d = await r.json();
    toast(d.error || 'Hata', 'error');
  }
}

// â”€â”€ GÃœRÃœLTÃœ BASTIRMA UI.1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Settings modal aÃ§Ä±lÄ±nca NS bÃ¶lÃ¼mÃ¼nÃ¼ senkronize et
window.addEventListener('bridge:settings-opened', _nsUiSync);
window.addEventListener('bridge:ns-changed', _nsUiSync);
window.addEventListener('bridge:ns-rnnoise-ready', _nsUiSync);

function _nsUiSync() {
  if (!window.BridgeNS) return;
  const { enabled, mode, rnnoiseReady, label } = window.BridgeNS.getStatus();

  // Toggle checkbox
  const toggle = document.getElementById('ns-toggle');
  if (toggle) toggle.checked = enabled;
  _nsUpdateToggleTrack(enabled);

  // Durum etiketi
  const statusLabel = document.getElementById('ns-status-label');
  if (statusLabel) statusLabel.textContent = label;

  // Radio butonlarÄ±
  const radios = document.querySelectorAll('input[name="ns-mode"]');
  radios.forEach(r => { r.checked = r.value === mode; });

  // RNNoise sub-label
  const rnSub = document.getElementById('ns-rnnoise-sublabel');
  if (rnSub) {
    rnSub.textContent = rnnoiseReady
      ? 'Derin Ã¶ÄŸrenme tabanlÄ±. HazÄ±r âœ“ (~5-10% CPU)'
      : 'Derin Ã¶ÄŸrenme tabanlÄ±. YÃ¼kleniyor... (aÄŸ baÄŸlantÄ±sÄ± gerekir)';
    rnSub.style.color = rnnoiseReady ? 'var(--green,#43b581)' : '';
  }

  // Mod grubu â€” kapalÄ±ysa grileÅŸtir
  const modeGroup = document.getElementById('ns-mode-group');
  if (modeGroup) modeGroup.style.opacity = enabled ? '1' : '0.4';

  // Seviye Ã¶lÃ§er baÅŸlat/durdur
  enabled ? _nsStartLevelMeter() : _nsStopLevelMeter();
}

function _nsUpdateToggleTrack(on) {
  const track = document.getElementById('ns-toggle-track');
  const thumb = document.getElementById('ns-toggle-thumb');
  if (track) track.style.background = on ? 'var(--green,#43b581)' : '';
  if (thumb) thumb.style.transform  = on ? 'translateX(20px)' : 'translateX(0)';
}

function applyNSToggle() {
  const val = document.getElementById('ns-toggle')?.checked ?? true;
  window.BridgeNS?.setEnabled(val);
  _nsUiSync();

  // EÄŸer sesli kanaldaysak, track'i gÃ¼ncelle
  _nsReplaceVoiceTrack();
}

function applyNSMode(mode) {
  window.BridgeNS?.setMode(mode);
  _nsUiSync();
}

async function _nsReplaceVoiceTrack() {
  const rtc = window.bridgeRTC;
  if (!rtc?.isInVoice()) return;
  // NS modÃ¼lÃ¼ setMode/setEnabled iÃ§inde zaten replaceTrack yapÄ±yor
  // Burada sadece toast gÃ¶ster
  const { label } = window.BridgeNS?.getStatus() || {};
  if (label) window.bridgeApp?.toast(`GÃ¼rÃ¼ltÃ¼ bastÄ±rma: ${label}`, 'info');
}

// â”€â”€ Seviye Ã¶lÃ§er â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _nsLevelAnimId = null;
let _nsAnalyser    = null;
let _nsLevelCtx    = null;

function _nsStartLevelMeter() {
  if (_nsLevelAnimId) return; // zaten Ã§alÄ±ÅŸÄ±yor
  try {
    const stream = window.bridgeRTC?.getLocalStream();
    if (!stream || !stream.getAudioTracks().length) return;

    _nsLevelCtx  = new AudioContext();
    const src    = _nsLevelCtx.createMediaStreamSource(stream);
    _nsAnalyser  = _nsLevelCtx.createAnalyser();
    _nsAnalyser.fftSize = 256;
    src.connect(_nsAnalyser);

    const data = new Uint8Array(_nsAnalyser.frequencyBinCount);

    function tick() {
      _nsLevelAnimId = requestAnimationFrame(tick);
      _nsAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((s, v) => s + v, 0) / data.length;
      const pct = Math.min(100, (avg / 128) * 100);
      const dB  = avg > 0 ? (20 * Math.log10(avg / 255)).toFixed(1) : '-âˆ';
      const bar = document.getElementById('ns-level-bar');
      const txt = document.getElementById('ns-level-text');
      if (bar) bar.style.width = pct + '%';
      if (txt) txt.textContent = `${dB} dB`;
    }
    tick();
  } catch {}
}

function _nsStopLevelMeter() {
  if (_nsLevelAnimId) { cancelAnimationFrame(_nsLevelAnimId); _nsLevelAnimId = null; }
  if (_nsLevelCtx && _nsLevelCtx.state !== 'closed') _nsLevelCtx.close().catch(() => {});
  _nsLevelCtx = null; _nsAnalyser = null;
  const bar = document.getElementById('ns-level-bar');
  const txt = document.getElementById('ns-level-text');
  if (bar) bar.style.width = '0%';
  if (txt) txt.textContent = 'â€” dB';
}

// Settings modal kapanÄ±rken level meter'Ä± durdur
document.addEventListener('modal-closed', e => {
  if (e.detail?.id === 'settings-modal') _nsStopLevelMeter();
});

// â”€â”€ Sohbet Arka PlanÄ± Panel Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Preset grid'i CHAT_BG_PRESETS tablosundan oluÅŸturur,
// event listener'larÄ± baÄŸlar. openSettings() her aÃ§Ä±lÄ±ÅŸta Ã§aÄŸÄ±rÄ±r.
function _initChatBgPanel() {
  const grid      = document.getElementById('chat-bg-preset-grid');
  const colorPick = document.getElementById('chat-bg-color-pick');
  const fileInput = document.getElementById('chat-bg-file-input');
  if (!grid) return;

  // Grid zaten dolu ise sadece aktif durumu gÃ¼ncelle
  const activePre = localStorage.getItem('bridge_chat_bg_preset') || 'none';
  if (grid.children.length > 0) {
    grid.querySelectorAll('.chat-bg-opt').forEach(b =>
      b.classList.toggle('active', b.dataset.bg === activePre)
    );
    return;
  }

  // Presetleri CHAT_BG_PRESETS'ten oluÅŸtur
  const presets = (window.CHAT_BG_PRESETS || []);
  presets.forEach(p => {
    const btn = document.createElement('button');
    btn.className  = 'chat-bg-opt' + (p.id === activePre ? ' active' : '');
    btn.dataset.bg = p.id;
    btn.style.cssText = [
      'height:48px', 'border-radius:8px', 'border:2px solid var(--border)',
      'cursor:pointer', 'font-size:11px', 'transition:border-color .15s',
      'color:' + (p.id === 'none' ? 'var(--text-muted)' : p.value ? '#fff' : 'var(--text-muted)'),
      'background:' + (p.id === 'none' ? 'var(--bg-2)' : p.id === 'custom' ? 'var(--bg-3)' : (p.value || 'var(--bg-3)')),
    ].join(';');

    if (p.id === 'none')    btn.textContent = 'âœ• ' + p.label;
    else if (p.id === 'custom') btn.textContent = 'ğŸ¨ ' + p.label;
    else {
      const icons = { waves:'ğŸŒŠ', sunset:'ğŸŒ…', forest:'ğŸŒ²', aurora:'ğŸŒ ', midnight:'ğŸŒŒ', rose:'ğŸŒ¹' };
      btn.textContent = (icons[p.id] || 'ğŸ¨') + ' ' + p.label;
    }

    btn.addEventListener('click', () => {
      if (p.id === 'custom') {
        colorPick && colorPick.click();
        return;
      }
      setChatBackground(p.value, p.id);
    });

    grid.appendChild(btn);
  });

  // Renk picker
  if (colorPick) {
    colorPick.addEventListener('input', e => applyChatBgColor(e.target.value));
  }

  // Dosya yÃ¼kleme
  if (fileInput) {
    fileInput.addEventListener('change', () => loadChatBgFromFile(fileInput));
  }
}

