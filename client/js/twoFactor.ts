// client/js/twoFactor.js â€” 2FA Kurulum UI

async function open2FASettings() {
  const existing = document.getElementById('twofa-modal');
  if (existing) { existing.remove(); return; }

  // Mevcut durumu Ã§ek
  const r = await apiFetch(`${API}/api/2fa/status`);
  const status = await r.json();

  const modal = document.createElement('div');
  modal.id = 'twofa-modal';
  modal.className = 'modal-overlay';

  if (status.enabled) {
    modal.innerHTML = `
      <div class="modal-card" style="max-width:440px;width:95%;">
        <h2>ğŸ” Ä°ki FaktÃ¶rlÃ¼ DoÄŸrulama</h2>
        <div style="background:#1a3a1a;border:1px solid #57f287;border-radius:8px;padding:14px;margin-bottom:16px;">
          <div style="color:#57f287;font-weight:600;">âœ… 2FA Aktif</div>
          <div style="color:#aaa;font-size:13px;margin-top:4px;">Yedek kod kaldÄ±: ${status.backupRemaining}</div>
        </div>
        <p style="color:var(--text-muted);font-size:13px;">2FA'yÄ± kaldÄ±rmak iÃ§in mevcut doÄŸrulayÄ±cÄ± kodunu girin:</p>
        <input id="twofa-disable-code" class="input" placeholder="6 haneli kod" maxlength="6"
          style="width:100%;margin-bottom:12px;letter-spacing:4px;font-size:18px;text-align:center;" />
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('twofa-modal').remove()">Ä°ptal</button>
          <button class="btn" style="background:#e8432d;" onclick="disable2FA()">2FA'yÄ± KaldÄ±r</button>
        </div>
      </div>`;
  } else {
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%;">
        <h2>ğŸ” 2FA Kurulumu</h2>
        <div id="twofa-step1">
          <p style="color:var(--text-muted);font-size:14px;">
            Google Authenticator, Authy veya benzeri bir uygulama kullanarak hesabÄ±nÄ± koru.
          </p>
          <button class="btn" onclick="start2FASetup()" style="width:100%;margin-top:8px;">
            BaÅŸlat â†’
          </button>
          <div class="modal-footer" style="margin-top:12px;">
            <button class="btn btn-secondary" onclick="document.getElementById('twofa-modal').remove()">Ä°ptal</button>
          </div>
        </div>
      </div>`;
  }
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

async function start2FASetup() {
  const r    = await apiFetch(`${API}/api/2fa/setup`, { method: 'POST' });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Kurulum baÅŸlatÄ±lamadÄ±', 'error');

  const step1 = document.getElementById('twofa-step1');
  if (!step1) return;

  step1.innerHTML = `
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">
      1. Authenticator uygulamanÄ± aÃ§<br>
      2. Yeni hesap ekle â†’ QR kodu tara<br>
      3. QR tarayamÄ±yorsan kodu manuel gir
    </p>

    <!-- QR Kodu - QRCode.js CDN ile -->
    <div style="display:flex;justify-content:center;margin-bottom:12px;">
      <div id="twofa-qr" style="background:#fff;padding:12px;border-radius:8px;"></div>
    </div>

    <div style="background:var(--bg-3);border-radius:8px;padding:10px;margin-bottom:12px;text-align:center;">
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:4px;">Manuel GiriÅŸ Kodu:</div>
      <div style="font-family:monospace;font-size:15px;letter-spacing:2px;color:var(--brand);word-break:break-all;">${data.secret}</div>
    </div>

    <label style="display:block;color:var(--text-muted);font-size:13px;margin-bottom:6px;">DoÄŸrulama Kodu (uygulamadaki 6 haneli kod):</label>
    <input id="twofa-code" class="input" placeholder="000000" maxlength="6"
      style="width:100%;letter-spacing:4px;font-size:20px;text-align:center;margin-bottom:12px;" />

    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="document.getElementById('twofa-modal').remove()">Ä°ptal</button>
      <button class="btn" onclick="verify2FA()">âœ… DoÄŸrula & AktifleÅŸtir</button>
    </div>`;

  // QR kodu oluÅŸtur (qrcode.js kÃ¼tÃ¼phanesi yoksa otpauth URL yaz)
  try {
    if (typeof QRCode !== 'undefined') {
      new QRCode(document.getElementById('twofa-qr'), {
        text: data.otpauthUrl, width: 180, height: 180,
      });
    } else {
      // Fallback: link olarak gÃ¶ster
      document.getElementById('twofa-qr').innerHTML =
        `<a href="${data.otpauthUrl}" style="font-size:11px;color:var(--brand);">Authenticator'da AÃ§</a>`;
    }
  } catch {}

  // Kodu kaydet
  window._twofa_url = data.otpauthUrl;
}

async function verify2FA() {
  const code = document.getElementById('twofa-code')?.value.trim();
  if (!code || code.length < 6) return toast('6 haneli kodu girin', 'error');

  const r    = await apiFetch(`${API}/api/2fa/verify`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ code })
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Kod geÃ§ersiz', 'error');

  // Yedek kodlarÄ± gÃ¶ster
  const modal = document.getElementById('twofa-modal');
  if (modal) {
    modal.querySelector('.modal-card').innerHTML = `
      <h2>âœ… 2FA AktifleÅŸtirildi!</h2>
      <div style="background:#1a3a1a;border:1px solid #57f287;border-radius:8px;padding:14px;margin-bottom:16px;">
        <div style="color:#57f287;font-weight:600;">Ä°ki faktÃ¶rlÃ¼ doÄŸrulama aÃ§Ä±k</div>
      </div>
      <p style="color:#e8432d;font-weight:600;">âš ï¸ Yedek KodlarÄ±nÄ± Kaydet!</p>
      <p style="color:var(--text-muted);font-size:13px;">Telefonuna eriÅŸimini kaybedersen bu kodlarÄ± kullan. Her kod bir kez kullanÄ±labilir.</p>
      <div style="background:var(--bg-3);border-radius:8px;padding:12px;margin:12px 0;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        ${data.backupCodes.map(c => `<code style="font-family:monospace;font-size:14px;color:var(--brand);">${c}</code>`).join('')}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('twofa-modal').remove()">AnladÄ±m, Kaydettim</button>
      </div>`;
  }
  toast('2FA aktif! Yedek kodlarÄ±nÄ± sakla ğŸ”', 'success');
}

async function disable2FA() {
  const code = document.getElementById('twofa-disable-code')?.value.trim();
  if (!code) return toast('Kodu girin', 'error');

  const r = await apiFetch(`${API}/api/2fa`, {
    method: 'DELETE', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ code })
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'GeÃ§ersiz kod', 'error');

  document.getElementById('twofa-modal')?.remove();
  toast('2FA kaldÄ±rÄ±ldÄ±', 'success');
}

// Email doÄŸrulama UI
async function openEmailSettings() {
  const existing = document.getElementById('email-modal');
  if (existing) { existing.remove(); return; }

  const me = await apiFetch(`${API}/api/me`).then(r=>r.json()).catch(()=>({}));

  const modal = document.createElement('div');
  modal.id = 'email-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:440px;width:95%;">
      <h2>ğŸ“§ E-posta AyarlarÄ±</h2>
      ${me.email ? `
        <div style="background:var(--bg-3);border-radius:8px;padding:12px;margin-bottom:16px;">
          <div style="font-weight:600;">${escHtml(me.email)}</div>
          <div style="color:${me.emailVerified?'#57f287':'#faa61a'};font-size:13px;margin-top:4px;">
            ${me.emailVerified ? 'âœ… DoÄŸrulandÄ±' : 'âš ï¸ DoÄŸrulanmadÄ±'}
          </div>
          ${!me.emailVerified ? `<button onclick="resendVerification()" class="btn btn-secondary" style="margin-top:8px;padding:4px 12px;font-size:12px;">Yeniden GÃ¶nder</button>` : ''}
        </div>` : `<p style="color:var(--text-muted);font-size:13px;">HenÃ¼z e-posta eklenmemiÅŸ.</p>`}
      <label class="settings-label">${me.email ? 'E-postayÄ± DeÄŸiÅŸtir' : 'E-posta Ekle'}</label>
      <input id="email-input" class="input" type="email" placeholder="ornek@mail.com"
        style="width:100%;margin-bottom:12px;" value="${escHtml(me.email||'')}" />
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('email-modal').remove()">Ä°ptal</button>
        <button class="btn" onclick="saveEmail()">ğŸ’¾ Kaydet & DoÄŸrula</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

async function saveEmail() {
  const email = document.getElementById('email-input')?.value.trim();
  if (!email) return toast('E-posta girin', 'error');
  const r = await apiFetch(`${API}/api/email/add`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email })
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Kaydedilemedi', 'error');
  document.getElementById('email-modal')?.remove();
  toast(data.message || 'DoÄŸrulama e-postasÄ± gÃ¶nderildi ğŸ“§', 'success');
}

async function resendVerification() {
  const r = await apiFetch(`${API}/api/email/resend`, { method: 'POST' });
  if (r.ok) toast('DoÄŸrulama e-postasÄ± gÃ¶nderildi', 'success');
  else toast('GÃ¶nderilemedi', 'error');
}

