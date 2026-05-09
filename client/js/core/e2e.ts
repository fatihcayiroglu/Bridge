// client/js/core/e2e.js Ä°stemci TarafÄ± UÃ§tan Uca Åifreleme
// Web Crypto API kullanÄ±r â€” tÃ¼m modern tarayÄ±cÄ±larda Ã§alÄ±ÅŸÄ±r
// Private key ASLA sunucuya gÃ¶nderilmez, sadece IndexedDB'de kalÄ±r

'use strict';

window.BridgeE2E = (() => {
  const DB_NAME    = 'BridgeE2E';
  const DB_VERSION = 1;
  const STORE_NAME = 'keys';
  let _status      = { ready: false, enabled: false };

  // apiFetch â€” auth.js'de tanÄ±mlÄ± global; eksikse erken hata ver
  function _apiFetch(url, opts) {
    if (typeof apiFetch !== 'function') {
      throw new Error('[E2EE] apiFetch bulunamadÄ± â€” auth.js, e2e.js\'den Ã¶nce yÃ¼klenmeli');
    }
    return apiFetch(url, opts);
  }

  // â”€â”€ IndexedDB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function savePrivateKey(userId, privateKeyB64) {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ id: `pk_${userId}`, key: privateKeyB64 });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function loadPrivateKey(userId) {
    try {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(`pk_${userId}`);
        req.onsuccess = () => resolve(req.result?.key || null);
        req.onerror   = () => resolve(null);
      });
    } catch { return null; }
  }

  async function deletePrivateKey(userId) {
    const db = await openDB();
    return new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(`pk_${userId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  // â”€â”€ ANAHTAR ÃœRETÄ°MÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // generateKeyPair() â†’ ECDH key (ÅŸifreleme/anahtar tÃ¼retme iÃ§in)
  // generateSigningKeyPair() â†’ ECDSA key (imzalama iÃ§in)
  // Web Crypto API aynÄ± key'i hem ECDH hem ECDSA iÃ§in kullanamaz;
  // kullanÄ±m amacÄ±na gÃ¶re ayrÄ± key pair Ã¼retmek zorunludur.

  async function generateKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, // extractable
      ['deriveKey', 'deriveBits']
    );

    const publicKeyBuf  = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyBuf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    return {
      publicKey:  bufToB64(publicKeyBuf),
      privateKey: bufToB64(privateKeyBuf),
    };
  }

  // ECDSA key pair â€” yalnÄ±zca imzalama iÅŸlemleri iÃ§in (X3DH signed prekey)
  async function generateSigningKeyPair() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const publicKeyBuf  = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyBuf = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    return {
      publicKey:  bufToB64(publicKeyBuf),
      privateKey: bufToB64(privateKeyBuf),
    };
  }

  // â”€â”€ ÅÄ°FRELEME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Her mesaj iÃ§in ayrÄ± ephemeral anahtar (Forward Secrecy)
  async function encryptMessage(plaintext, recipientPublicKeyB64) {
    // AlÄ±cÄ±nÄ±n public key'ini import et
    const recipientKey = await crypto.subtle.importKey(
      'spki',
      b64ToBuf(recipientPublicKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );

    // Ephemeral anahtar Ã§ifti (her mesaj iÃ§in benzersiz)
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']
    );

    // PaylaÅŸÄ±lan AES anahtarÄ± tÃ¼ret
    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: recipientKey },
      ephemeral.privateKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt']
    );

    // AES-GCM ÅŸifreleme
    const iv       = crypto.getRandomValues(new Uint8Array(12));
    const encoded  = new TextEncoder().encode(plaintext);
    const ctBuf    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);

    // Ephemeral public key'i export et
    const ephPubBuf = await crypto.subtle.exportKey('spki', ephemeral.publicKey);

    return {
      ct:  bufToB64(ctBuf),       // ciphertext
      iv:  bufToB64(iv),
      epk: bufToB64(ephPubBuf),   // ephemeral public key
      v:   1,                     // version
    };
  }

  // â”€â”€ ÅÄ°FRE Ã‡Ã–ZME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function decryptMessage(encrypted, privateKeyB64) {
    const { ct, iv, epk } = encrypted;

    const myPrivateKey = await crypto.subtle.importKey(
      'pkcs8', b64ToBuf(privateKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, ['deriveKey']
    );

    const ephKey = await crypto.subtle.importKey(
      'spki', b64ToBuf(epk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );

    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: ephKey },
      myPrivateKey,
      { name: 'AES-GCM', length: 256 },
      false, ['decrypt']
    );

    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(iv) },
      sharedKey,
      b64ToBuf(ct)
    );

    return new TextDecoder().decode(plainBuf);
  }

  // â”€â”€ KURULUM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function setup(userId) {
    const existing = await loadPrivateKey(userId);
    if (existing) {
      _status = { ready: true, enabled: true };
      return { alreadySetup: true };
    }

    // ECDH key pair â†’ ÅŸifreleme / anahtar tÃ¼retme
    const { publicKey, privateKey } = await generateKeyPair();
    await savePrivateKey(userId, privateKey);
    // ECDH public key IndexedDB'ye de sakla (x3dhSetup'ta kullanÄ±lÄ±r)
    await _x3dhSave(`identity_pub_${userId}`, publicKey);

    // ECDSA key pair â†’ imzalama (signed prekey imzalamak iÃ§in)
    const signingPair = await generateSigningKeyPair();
    await _x3dhSave(`signing_priv_${userId}`, signingPair.privateKey);
    await _x3dhSave(`signing_pub_${userId}`,  signingPair.publicKey);

    // Sunucuya ECDH public key gÃ¶nder (DM ÅŸifreleme iÃ§in)
    const res = await _apiFetch(`${API}/api/e2e/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, algorithm: 'P-256' }),
    });

    if (!res.ok) throw new Error('Failed to register public key');

    _status = { ready: true, enabled: true };
    console.log('[E2EE] âœ… Kurulum tamamlandÄ±. Private key cihazÄ±nÄ±zda kalÄ±yor.');
    toast('ğŸ”’ UÃ§tan uca ÅŸifreleme aktif!', 'success');
    return { success: true };
  }

  async function disable(userId) {
    await deletePrivateKey(userId);
    await _apiFetch(`${API}/api/e2e/keys`, { method: 'DELETE' });
    _status = { ready: false, enabled: false };
    toast('ğŸ”“ Åifreleme devre dÄ±ÅŸÄ± bÄ±rakÄ±ldÄ±', 'info');
  }

  // â”€â”€ DM YARDIMCILARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function encryptDM(plaintext, recipientId, myUserId) {
    if (!_status.enabled) return { encrypted: false, content: plaintext };

    // AlÄ±cÄ±nÄ±n public key'ini al
    const res  = await _apiFetch(`${API}/api/e2e/keys/${recipientId}`);
    const data = await res.json();
    if (!data.hasKey) return { encrypted: false, content: plaintext }; // AlÄ±cÄ± E2EE kurmamÄ±ÅŸ

    const encrypted = await encryptMessage(plaintext, data.publicKey);
    return { encrypted: true, e2e: encrypted, content: 'ğŸ”’ Åifreli mesaj' };
  }

  async function decryptDM(e2eData, myUserId) {
    const privateKey = await loadPrivateKey(myUserId);
    if (!privateKey) return null;
    try {
      return await decryptMessage(e2eData, privateKey);
    } catch (err) {
      console.warn('[E2EE] Åifre Ã§Ã¶zme baÅŸarÄ±sÄ±z:', err.message);
      return null;
    }
  }

  // â”€â”€ UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function openE2ESettings() {
    const userId = window.me?.id;
    if (!userId) return toast('GiriÅŸ yapmanÄ±z gerekiyor', 'error');

    const existing = await loadPrivateKey(userId);
    const enabled  = !!existing;

    const modal = document.createElement('div');
    modal.id = 'e2e-settings-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%;">
        <h2 style="margin-bottom:4px;">ğŸ”’ UÃ§tan Uca Åifreleme</h2>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
          MesajlarÄ±nÄ±z ÅŸifrelenir ve sadece siz ve karÅŸÄ± taraf okuyabilir.
          Sunucu iÃ§eriÄŸi hiÃ§bir zaman gÃ¶remez.
        </p>
        <div style="background:var(--bg-3);border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <span style="font-size:24px;">${enabled ? 'ğŸŸ¢' : 'â­•'}</span>
            <div>
              <div style="font-weight:700;">${enabled ? 'Aktif' : 'Devre DÄ±ÅŸÄ±'}</div>
              <div style="color:var(--text-muted);font-size:12px;">
                ${enabled ? "DM'leriniz ÅŸifreleniyor" : 'Åifreleme baÅŸlatÄ±lmamÄ±ÅŸ'}
              </div>
            </div>
          </div>
          ${enabled ? '<div style="font-size:12px;color:var(--text-muted);background:var(--bg-2);padding:8px;border-radius:6px;">âœ… Private key cihazÄ±nÄ±zda gÃ¼vende<br>âœ… Sunucu mesajlarÄ±nÄ±zÄ± okuyamaz<br>âœ… Her mesaj iÃ§in benzersiz ÅŸifreleme (Forward Secrecy)</div>' : ''}
        </div>
        ${enabled ? `
        <div style="border-top:1px solid var(--border);padding-top:16px;margin-bottom:16px;">
          <div style="font-weight:600;margin-bottom:10px;">ğŸ—ï¸ Anahtar YÃ¶netimi</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
            Private key'inizi yedekleyerek baÅŸka cihazlarda kullanabilirsiniz.
            DosyayÄ± gÃ¼venli bir yerde saklayÄ±n â€” kaybolursa ÅŸifreli mesajlarÄ±nÄ±za eriÅŸemezsiniz.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn" style="flex:1;min-width:140px;" onclick="window.BridgeE2E._exportKey()">ğŸ“¥ Key'i Ä°ndir (.pem)</button>
            <label class="btn btn-secondary" style="flex:1;min-width:140px;cursor:pointer;text-align:center;">
              ğŸ“¤ Key'i YÃ¼kle
              <input type="file" accept=".pem,.txt" style="display:none" onchange="window.BridgeE2E._importKey(this)">
            </label>
          </div>
        </div>` : ''}
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="document.getElementById('e2e-settings-modal').remove()">Kapat</button>
          ${enabled
            ? `<button class="btn" style="background:var(--red);" onclick="window.BridgeE2E.disable('${userId}').then(()=>document.getElementById('e2e-settings-modal').remove())">ğŸ”“ Devre DÄ±ÅŸÄ± BÄ±rak</button>`
            : `<button class="btn" onclick="window.BridgeE2E.setup('${userId}').then(()=>document.getElementById('e2e-settings-modal').remove())">ğŸ”’ Åifrelemeyi EtkinleÅŸtir</button>`
          }
        </div>
      </div>`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }

  // â”€â”€ v73: KEY EXPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _exportKey() {
    const userId = window.me?.id;
    if (!userId) return;
    const key = await loadPrivateKey(userId);
    if (!key) return toast('Private key bulunamadÄ±', 'error');
    const pem = `-----BEGIN BRIDGE PRIVATE KEY-----\n${key}\n-----END BRIDGE PRIVATE KEY-----`;
    const blob = new Blob([pem], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bridge-e2e-key-${userId.slice(-6)}.pem`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('Key indirildi â€” gÃ¼venli bir yerde saklayÄ±n!', 'success');
  }

  // â”€â”€ v73: KEY IMPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _importKey(input) {
    const userId = window.me?.id;
    if (!userId || !input.files?.[0]) return;
    const file = input.files[0];
    const text = await file.text();
    const b64 = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (!b64) return toast('GeÃ§ersiz key dosyasÄ±', 'error');
    try {
      // Ä°mport edilen key ECDH (ÅŸifreleme) key olmalÄ± â€” ECDSA deÄŸil
      await crypto.subtle.importKey(
        'pkcs8', b64ToBuf(b64),
        { name: 'ECDH', namedCurve: 'P-256' },
        true, ['deriveKey', 'deriveBits']
      );
      await savePrivateKey(userId, b64);
      _status = { ready: true, enabled: true };
      toast('âœ… Key baÅŸarÄ±yla yÃ¼klendi!', 'success');
      document.getElementById('e2e-settings-modal')?.remove();
      const btn = document.getElementById('btn-e2e');
      if (btn) btn.textContent = 'ğŸ”’';
    } catch {
      toast('âŒ GeÃ§ersiz key â€” bu cihaz iÃ§in Ã¼retilmiÅŸ bir Bridge key dosyasÄ± seÃ§in', 'error');
    }
  }

  // â”€â”€ YARDIMCILAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function bufToB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer)));
  }

  function b64ToBuf(b64) {
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf.buffer;
  }

  function getStatus() { return _status; }

  // â”€â”€ X3DH â€” Signal Protocol Initial Key Agreement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Extended Triple Diffie-Hellman: ilk mesaj iÃ§in gÃ¼venli kanal kurulumu.
  // GÃ¶nderici: alÄ±cÄ±nÄ±n prekey bundle'Ä±nÄ± alÄ±r, 4 ECDH iÅŸlemi ile ortak sÄ±r tÃ¼retir.
  // AlÄ±cÄ±: gelen bundle header'Ä±ndan aynÄ± ortak sÄ±rrÄ± tÃ¼retir.
  //
  // DH zinciri:
  //   DH1 = DH(IK_A, SPK_B)        identity key A + signed prekey B
  //   DH2 = DH(EK_A, IK_B)         ephemeral key A + identity key B
  //   DH3 = DH(EK_A, SPK_B)        ephemeral key A + signed prekey B
  //   DH4 = DH(EK_A, OPK_B)        ephemeral key A + one-time prekey B (varsa)
  //   MK  = KDF(DH1 || DH2 || DH3 [|| DH4])

  const X3DH_DB_STORE  = 'x3dh';
  const X3DH_DB_VER    = 2;

  async function _openX3DHDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, X3DH_DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(X3DH_DB_STORE)) {
          db.createObjectStore(X3DH_DB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async function _x3dhSave(key, value) {
    const db  = await _openX3DHDB();
    const tx  = db.transaction(X3DH_DB_STORE, 'readwrite');
    return new Promise<void>((res, rej) => {
      const req = tx.objectStore(X3DH_DB_STORE).put({ id: key, value });
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  async function _x3dhLoad(key) {
    try {
      const db = await _openX3DHDB();
      return new Promise((res) => {
        const tx  = db.transaction(X3DH_DB_STORE, 'readonly');
        const req = tx.objectStore(X3DH_DB_STORE).get(key);
        req.onsuccess = () => res(req.result?.value ?? null);
        req.onerror   = () => res(null);
      });
    } catch { return null; }
  }

  // X25519 (P-256 ECDH) bit tÃ¼retme yardÄ±mcÄ±sÄ±
  async function _ecdhBits(privateKeyB64, publicKeyB64) {
    const privKey = await crypto.subtle.importKey(
      'pkcs8', b64ToBuf(privateKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
    );
    const pubKey = await crypto.subtle.importKey(
      'spki', b64ToBuf(publicKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    return crypto.subtle.deriveBits({ name: 'ECDH', public: pubKey }, privKey, 256);
  }

  // HKDF ile master key tÃ¼retme
  async function _hkdf(inputMaterial, info = 'BridgeX3DH-v1') {
    const ikm = await crypto.subtle.importKey(
      'raw', inputMaterial, { name: 'HKDF' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt:  new Uint8Array(32),                  // zero salt
        info:  new TextEncoder().encode(info),
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  // Prekey bundle kurulumu: signed prekey + one-time prekeys Ã¼ret ve sunucuya yÃ¼kle
  async function x3dhSetup(userId) {
    const myIdentityPrivB64 = await loadPrivateKey(userId);
    if (!myIdentityPrivB64) throw new Error('Ã–nce E2E kurulumu yapÄ±n (setup Ã§aÄŸrÄ±sÄ± gerekli)');

    // Signed prekey Ã¼ret
    const spkPair = await generateKeyPair();
    // One-time prekeys Ã¼ret (20 adet)
    const otpKeys = [];
    for (let i = 0; i < 20; i++) {
      const kp = await generateKeyPair();
      otpKeys.push({ keyId: i, publicKey: kp.publicKey, _privateKey: kp.privateKey });
    }

    // Private prekey'leri IndexedDB'ye kaydet
    await _x3dhSave(`spk_priv_${userId}`, spkPair.privateKey);
    for (const k of otpKeys) {
      await _x3dhSave(`otpk_priv_${userId}_${k.keyId}`, k._privateKey);
    }

    // Signed prekey signature â€” ECDSA signing key ile imzala
    // (ECDH key ile imzalanamaz; setup() sÄ±rasÄ±nda Ã¼retilen ayrÄ± signing key kullanÄ±lÄ±r)
    let signature = '';
    const signingPrivB64 = await _x3dhLoad(`signing_priv_${userId}`);
    if (signingPrivB64) {
      try {
        const signingKey = await crypto.subtle.importKey(
          'pkcs8', b64ToBuf(signingPrivB64),
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
        );
        const sigBuf = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          signingKey,
          b64ToBuf(spkPair.publicKey)
        );
        signature = bufToB64(sigBuf);
      } catch (e) {
        console.warn('[X3DH] Signing hatasÄ±:', e.message);
        signature = 'sign-error';
      }
    } else {
      // Eski setup'tan geÃ§iÅŸ: signing key henÃ¼z yok, yeni bir tane Ã¼ret ve kaydet
      console.warn('[X3DH] Signing key bulunamadÄ± â€” yeni ECDSA key pair Ã¼retiliyor');
      const newSigning = await generateSigningKeyPair();
      await _x3dhSave(`signing_priv_${userId}`, newSigning.privateKey);
      await _x3dhSave(`signing_pub_${userId}`,  newSigning.publicKey);
      try {
        const signingKey = await crypto.subtle.importKey(
          'pkcs8', b64ToBuf(newSigning.privateKey),
          { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
        );
        const sigBuf = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          signingKey,
          b64ToBuf(spkPair.publicKey)
        );
        signature = bufToB64(sigBuf);
      } catch (e) {
        signature = 'sign-error';
      }
    }

    // Sunucuya yÃ¼kle â€” stored identity public key kullan (setup'ta kaydedildi)
    const identityPublicKey = await _x3dhLoad(`identity_pub_${userId}`);
    if (!identityPublicKey) throw new Error('Identity public key bulunamadÄ± â€” Ã¶nce E2E setup Ã§alÄ±ÅŸtÄ±rÄ±n');
    await _apiFetch(`${API}/api/e2e/prekeys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityKey:   identityPublicKey,
        signedPreKey:  { keyId: 0, publicKey: spkPair.publicKey, signature },
        oneTimePreKeys: otpKeys.map(k => ({ keyId: k.keyId, publicKey: k.publicKey })),
      }),
    });

    console.log('[X3DH] âœ… Prekey bundle yÃ¼klendi â€” 20 one-time key');
    return { ok: true };
  }

  // X3DH gÃ¶nderici: alÄ±cÄ±nÄ±n bundle'Ä±ndan mesaj anahtarÄ± tÃ¼ret
  async function x3dhSend(recipientId, myUserId) {
    // AlÄ±cÄ±nÄ±n prekey bundle'Ä±nÄ± al
    const res  = await _apiFetch(`${API}/api/e2e/prekeys/${recipientId}`);
    const data = await res.json();
    if (!data.hasBundle) return null;

    const { identityKey: IK_B, signedPreKey: SPK_B, oneTimePreKey: OPK_B } = data;

    // GÃ¶nderici kimlik key
    const IK_A_priv = await loadPrivateKey(myUserId);
    if (!IK_A_priv) throw new Error('GÃ¶nderici kimlik key bulunamadÄ±');

    // Ephemeral key Ã¼ret
    const EK_A = await generateKeyPair();

    // 4 ECDH hesabÄ±
    const dh1 = await _ecdhBits(IK_A_priv,        SPK_B.publicKey);  // IK_A Ã— SPK_B
    const dh2 = await _ecdhBits(EK_A.privateKey,  IK_B);             // EK_A Ã— IK_B
    const dh3 = await _ecdhBits(EK_A.privateKey,  SPK_B.publicKey);  // EK_A Ã— SPK_B

    // DH sonuÃ§larÄ±nÄ± birleÅŸtir
    const concat = OPK_B
      ? (() => {
          // dh4 hesabÄ± iÃ§in â€” one-time prekey kullanÄ±ldÄ±ysa
          // (async iÃ§inde await yapamayÄ±z, promise ile handle et)
          return { dh1, dh2, dh3, OPK_B_pub: OPK_B.publicKey, EK_A_priv: EK_A.privateKey };
        })()
      : null;

    let combined;
    if (OPK_B) {
      const dh4 = await _ecdhBits(EK_A.privateKey, OPK_B.publicKey);
      combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2), ...new Uint8Array(dh3), ...new Uint8Array(dh4)]);
    } else {
      combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2), ...new Uint8Array(dh3)]);
    }

    // HKDF ile master key
    const masterKey = await _hkdf(combined.buffer);

    // Session bilgisini sakla (Double Ratchet iÃ§in gerekecek)
    const session = {
      recipientId,
      EK_A_pub:        EK_A.publicKey,
      SPK_B_keyId:     SPK_B.keyId,
      OPK_B_keyId:     OPK_B?.keyId ?? null,
      IK_B,
      establishedAt:   Date.now(),
    };
    await _x3dhSave(`session_${myUserId}_${recipientId}`, session);

    return { masterKey, header: { EK_A_pub: EK_A.publicKey, SPK_B_keyId: SPK_B.keyId, OPK_B_keyId: OPK_B?.keyId ?? null } };
  }

  // X3DH alÄ±cÄ±: gÃ¶ndericinin header bilgisiyle master key tÃ¼ret
  async function x3dhReceive(senderId, myUserId, header) {
    const { EK_A_pub, SPK_B_keyId, OPK_B_keyId } = header;

    const myIdentityPriv = await loadPrivateKey(myUserId);
    const mySPKPriv      = await _x3dhLoad(`spk_priv_${myUserId}`);
    if (!myIdentityPriv || !mySPKPriv) throw new Error('AlÄ±cÄ± prekey bulunamadÄ±');

    // GÃ¶nderenin identity key'i sunucudan al
    const senderRes = await _apiFetch(`${API}/api/e2e/keys/${senderId}`);
    const senderData = await senderRes.json();
    if (!senderData.hasKey) throw new Error('GÃ¶nderici identity key bulunamadÄ±');
    const IK_A_pub = senderData.publicKey;

    const dh1 = await _ecdhBits(mySPKPriv,         IK_A_pub);  // SPK_B Ã— IK_A
    const dh2 = await _ecdhBits(myIdentityPriv,    EK_A_pub);  // IK_B  Ã— EK_A
    const dh3 = await _ecdhBits(mySPKPriv,         EK_A_pub);  // SPK_B Ã— EK_A

    let combined;
    if (OPK_B_keyId !== null) {
      const myOTPKPriv = await _x3dhLoad(`otpk_priv_${myUserId}_${OPK_B_keyId}`);
      if (!myOTPKPriv) throw new Error('One-time prekey bulunamadÄ± (zaten kullanÄ±lmÄ±ÅŸ?)');
      const dh4 = await _ecdhBits(myOTPKPriv, EK_A_pub);   // OPK_B Ã— EK_A
      combined  = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2), ...new Uint8Array(dh3), ...new Uint8Array(dh4)]);
    } else {
      combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2), ...new Uint8Array(dh3)]);
    }

    const masterKey = await _hkdf(combined.buffer);
    return { masterKey };
  }

  // One-time prekey replenish: 10'un altÄ±na dÃ¼ÅŸÃ¼nce otomatik tamamla
  async function x3dhCheckReplenish(userId) {
    try {
      const res  = await _apiFetch(`${API}/api/e2e/prekeys/${userId}/count`);
      const data = await res.json();
      if (data.needsReplenish) {
        console.log('[X3DH] One-time prekey sayÄ±sÄ± dÃ¼ÅŸÃ¼k, yenileniyor...');
        await x3dhSetup(userId);
      }
    } catch { /* sessizce geÃ§ */ }
  }

  // Otomatik baÅŸlat (kullanÄ±cÄ± giriÅŸ yaptÄ±ysa)
  async function autoInit(userId) {
    const key = await loadPrivateKey(userId);
    if (key) {
      _status = { ready: true, enabled: true };
      console.log('[E2EE] âœ… Otomatik baÅŸlatÄ±ldÄ±');
      // X3DH prekey sayÄ±sÄ±nÄ± kontrol et
      setTimeout(() => x3dhCheckReplenish(userId), 3000);
    }
  }

  return {
    setup, disable, encryptDM, decryptDM,
    encryptMessage, decryptMessage,
    generateKeyPair, generateSigningKeyPair,
    openE2ESettings, autoInit, getStatus,
    savePrivateKey, loadPrivateKey,
    _exportKey, _importKey,
    // X3DH â€” Signal Protocol Initial Key Agreement
    x3dhSetup, x3dhSend, x3dhReceive, x3dhCheckReplenish,
  };
})();

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SES KANALI E2E â€” Voice Channel Encrypted Key Exchange
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// NasÄ±l Ã§alÄ±ÅŸÄ±r:
//   1. Ses kanalÄ±na katÄ±lÄ±rken tarayÄ±cÄ±da bir "session key" (AES-GCM 256bit) Ã¼retilir
//   2. Kanalda bulunan her peer'Ä±n public key'i ile bu session key ÅŸifrelenir
//   3. Åifreli session key'ler signalling kanalÄ± Ã¼zerinden gÃ¶nderilir
//   4. Peer kendi private key'i ile session key'i Ã§Ã¶zer
//   5. Ses stream metadata'sÄ± (kullanÄ±cÄ± adÄ±, kanal bilgisi) bu key ile ÅŸifrelenir
//   6. WebRTC DTLS zaten ses verisini ÅŸifreler â€” bu katman ekstra metadata gÃ¼venliÄŸi saÄŸlar
//
// NOT: WebRTC'nin DTLS ÅŸifrelemesi ses verisini zaten korur.
// Bu katman sunucunun bile gÃ¶remeyeceÄŸi kanal metadata ÅŸifrelemesidir.

window.BridgeVoiceE2E = (() => {
  let _sessionKey = null;       // CryptoKey (AES-GCM)
  let _sessionKeyB64 = null;    // Base64 export
  let _enabled = false;

  // â”€â”€ Session key Ã¼ret â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function generateSessionKey() {
    _sessionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const raw = await crypto.subtle.exportKey('raw', _sessionKey);
    _sessionKeyB64 = bufToB64(raw);
    return _sessionKeyB64;
  }

  // â”€â”€ Session key'i peer'Ä±n E2E public key'i ile ÅŸifrele â”€â”€â”€
  async function encryptSessionKeyForPeer(peerPublicKeyB64) {
    if (!_sessionKeyB64) throw new Error('Session key Ã¼retilmemiÅŸ');
    // BridgeE2E'nin encryptMessage fonksiyonunu kullan
    if (!window.BridgeE2E?.getStatus().enabled) return null;
    return await window.BridgeE2E.encryptMessage(_sessionKeyB64, peerPublicKeyB64);
  }

  // â”€â”€ Peer'dan gelen ÅŸifreli session key'i Ã§Ã¶z â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function decryptSessionKey(encryptedKeyData, myUserId) {
    if (!window.BridgeE2E?.getStatus().enabled) return false;
    try {
      const keyB64 = await window.BridgeE2E.decryptMessage(encryptedKeyData, myUserId);
      const raw = b64ToBuf(keyB64);
      _sessionKey = await crypto.subtle.importKey(
        'raw', raw,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      _sessionKeyB64 = keyB64;
      return true;
    } catch (e) {
      console.warn('[VoiceE2E] Session key Ã§Ã¶zÃ¼lemedi:', e.message);
      return false;
    }
  }

  // â”€â”€ Metadata ÅŸifrele (kullanÄ±cÄ± adÄ±, kanal bilgisi vb.) â”€â”€
  async function encryptMetadata(data) {
    if (!_sessionKey) return null;
    try {
      const iv  = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder().encode(JSON.stringify(data));
      const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        _sessionKey,
        enc
      );
      return bufToB64(iv) + '.' + bufToB64(cipher);
    } catch { return null; }
  }

  // â”€â”€ Metadata Ã§Ã¶z â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function decryptMetadata(encrypted) {
    if (!_sessionKey || !encrypted) return null;
    try {
      const [ivB64, dataB64] = encrypted.split('.');
      const iv     = b64ToBuf(ivB64);
      const cipher = b64ToBuf(dataB64);
      const plain  = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        _sessionKey,
        cipher
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch { return null; }
  }

  // â”€â”€ Ses kanalÄ±na katÄ±lÄ±rken key exchange baÅŸlat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function initVoiceE2E(channelId, peers) {
    if (!window.BridgeE2E?.getStatus().enabled) {
      _enabled = false;
      return false;
    }

    await generateSessionKey();
    _enabled = true;
    console.log('[VoiceE2E] âœ… Session key Ã¼retildi â€” kanal:', channelId);

    // Her peer iÃ§in session key'i ÅŸifrele ve gÃ¶nder
    for (const peer of peers) {
      try {
        const r = await _apiFetch(`${API}/api/e2e/keys/${peer.userId}`);
        const data = await r.json();
        if (!data.hasKey) continue;

        const encrypted = await encryptSessionKeyForPeer(data.publicKey);
        if (!encrypted) continue;

        // Socket Ã¼zerinden gÃ¶nder
        if (window.socket) {
          socket.emit('voice:e2e-key', {
            channelId,
            targetUserId: peer.userId,
            encryptedKey: encrypted,
          });
        }
      } catch (e) {
        console.warn('[VoiceE2E] Peer key exchange hatasÄ±:', peer.userId, e.message);
      }
    }

    return true;
  }

  // â”€â”€ Socket event: Peer bizim iÃ§in key gÃ¶nderdi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function registerSocketEvents(socket, myUserId) {
    socket.on('voice:e2e-key', async ({ fromUserId, encryptedKey }) => {
      if (_sessionKey) return; // zaten key var, ilk geleni kullan
      const ok = await decryptSessionKey(encryptedKey, myUserId);
      if (ok) {
        _enabled = true;
        console.log('[VoiceE2E] âœ… Session key alÄ±ndÄ±:', fromUserId);
        if (typeof toast === 'function') toast('ğŸ”’ Ses kanalÄ± ÅŸifrelendi', 'success');
      }
    });
  }

  function isEnabled() { return _enabled; }
  function clearSession() { _sessionKey = null; _sessionKeyB64 = null; _enabled = false; }

  // â”€â”€ UI helper: ses kanalÄ±ndaki E2E durumunu gÃ¶ster â”€â”€â”€â”€â”€â”€â”€
  function renderVoiceE2EBadge() {
    let badge = document.getElementById('voice-e2e-badge');
    if (!_enabled) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'voice-e2e-badge';
      badge.style.cssText = 'position:absolute;top:8px;right:8px;background:var(--green);color:#fff;border-radius:12px;padding:3px 8px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:4px;z-index:10;';
      badge.innerHTML = 'ğŸ”’ E2E Åifreli';
      document.getElementById('voice-view')?.style && document.getElementById('voice-view').appendChild(badge);
    }
  }

  return {
    initVoiceE2E,
    encryptMetadata,
    decryptMetadata,
    registerSocketEvents,
    isEnabled,
    clearSession,
    renderVoiceE2EBadge,
  };
})();

// â”€â”€ yardÄ±mcÄ± fonksiyonlar (e2e.js scope'undan eriÅŸim iÃ§in) â”€â”€
function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer)));
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

