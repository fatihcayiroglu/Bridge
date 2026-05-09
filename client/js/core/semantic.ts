// client/js/core/semantic.js
// AI AkÄ±llÄ± Arama, HaftalÄ±k Digest, BaÄŸlÄ±lÄ±k Dashboard

'use strict';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI SEMANTIC SEARCH â€” "Bu haftaki Ã¶nemli kararlar?"
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openSemanticSearch() {
  if (!currentServer) return toast('Ã–nce bir sunucu seÃ§', 'error');

  const modal = document.createElement('div');
  modal.id = 'semantic-search-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:600px;width:95%;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="margin:0;">ğŸ” AI AkÄ±llÄ± Arama</h2>
        <button class="icon-btn" onclick="document.getElementById('semantic-search-modal').remove()">âœ•</button>
      </div>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">
        DoÄŸal dille sor: "Bu hafta neler konuÅŸuldu?", "Sunucu kurallarÄ± hakkÄ±nda ne dendi?", "Kim ne Ã¶nerdi?"
      </p>
      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <input id="sem-query" type="text" class="input" placeholder="Aramak istediÄŸini yaz..." style="flex:1;"
          onkeydown="if(event.key==='Enter')runSemanticSearch()">
        <select id="sem-days" class="input" style="width:100px;">
          <option value="3">3 gÃ¼n</option>
          <option value="7" selected>7 gÃ¼n</option>
          <option value="14">14 gÃ¼n</option>
          <option value="30">30 gÃ¼n</option>
        </select>
        <button class="btn btn-primary" onclick="runSemanticSearch()">Ara</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
        ${['Bu haftaki kararlar', 'Ã–nemli duyurular', 'Etkinlik planlarÄ±', 'Sunucu sorunlarÄ±'].map(s =>
          `<span style="cursor:pointer;font-size:12px;padding:3px 8px;background:var(--bg-3);border-radius:12px;color:var(--text-muted);"
            onclick="(document.getElementById('sem-query') as HTMLInputElement | null)?.value ?? ''='${s}';runSemanticSearch()">${s}</span>`
        ).join('')}
      </div>
      <div id="sem-results" style="flex:1;overflow-y:auto;"></div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('sem-query')?.focus(), 50);
}

async function runSemanticSearch() {
  const query = document.getElementById('sem-query')?.value?.trim();
  const days  = parseInt(document.getElementById('sem-days')?.value) || 7;
  const res   = document.getElementById('sem-results');
  if (!query || !res) return;
  if (!currentServer) return;

  res.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 8px"></div>AI analiz ediyor...</div>';

  try {
    const r = await apiFetch(`${API}/api/semantic/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, serverId: currentServer._id, days }),
    });
    const data = await r.json();

    if (!r.ok) {
      res.innerHTML = `<div style="color:var(--red);padding:16px">${escHtml(data.error || 'Hata')}</div>`;
      return;
    }

    if (!data.matches?.length) {
      res.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:8px;">ğŸ”</div>
        <p>EÅŸleÅŸen mesaj bulunamadÄ±.</p>
        ${data.explanation ? `<p style="font-size:12px;margin-top:8px;">${escHtml(data.explanation)}</p>` : ''}
      </div>`;
      return;
    }

    res.innerHTML = `
      ${data.explanation ? `<div style="background:var(--bg-3);border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--text-muted);">
        ğŸ’¡ ${escHtml(data.explanation)}
      </div>` : ''}
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${data.total} sonuÃ§ Â· ${data.days} gÃ¼n Â· ${data.provider}</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${data.matches.map(m => `
          <div style="background:var(--bg-3);border-radius:8px;padding:10px 12px;cursor:pointer;border:1px solid transparent;transition:border .15s"
            onmouseover="this.style.borderColor='var(--brand)'" onmouseout="this.style.borderColor='transparent'"
            onclick="jumpToSemanticMsg('${escHtml(m.channelId)}','${escHtml(m._id)}')">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">
              <span style="font-weight:600;font-size:13px;">${escHtml(m.username)}</span>
              <span style="font-size:11px;color:var(--text-muted);">#${escHtml(m.channelName)}</span>
              <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${new Date(m.createdAt).toLocaleDateString('tr-TR')}</span>
            </div>
            <div style="font-size:13px;line-height:1.5;">${escHtml((m.content || '').slice(0, 200))}</div>
          </div>`).join('')}
      </div>`;
  } catch (err) {
    res.innerHTML = `<div style="color:var(--red);padding:16px">BaÄŸlantÄ± hatasÄ±: ${escHtml(err.message)}</div>`;
  }
}

async function jumpToSemanticMsg(channelId, msgId) {
  document.getElementById('semantic-search-modal')?.remove();
  // DOM'daki kanal elementine tÄ±kla (channels.js ile uyumlu)
  const chEl = document.querySelector(`.ch-item[data-id="${channelId}"]`);
  if (chEl) {
    chEl.click();
    setTimeout(() => {
      const el = document.getElementById(`msg-${msgId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.background = 'var(--brand-20,rgba(88,101,242,.2))';
        setTimeout(() => el.style.background = '', 2000);
      }
    }, 700);
  } else {
    toast('Kanal bu sunucuda gÃ¶rÃ¼nmÃ¼yor', 'error');
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HAFTALIK DIGEST
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openWeeklyDigest() {
  if (!currentServer) return toast('Ã–nce bir sunucu seÃ§', 'error');

  const modal = document.createElement('div');
  modal.id = 'digest-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:600px;width:95%;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="margin:0;">ğŸ“° HaftalÄ±k Topluluk Ã–zeti</h2>
        <div style="display:flex;align-items:center;gap:8px;">
          <select id="digest-days" class="input" style="width:90px;" onchange="loadDigest()">
            <option value="7" selected>7 gÃ¼n</option>
            <option value="14">14 gÃ¼n</option>
            <option value="30">30 gÃ¼n</option>
          </select>
          <button class="icon-btn" onclick="document.getElementById('digest-modal').remove()">âœ•</button>
        </div>
      </div>
      <div id="digest-content" style="flex:1;overflow-y:auto;">
        <div style="text-align:center;padding:32px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>YÃ¼kleniyor...</div>
      </div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  loadDigest();
}

async function loadDigest() {
  if (!currentServer) return;
  const days = parseInt(document.getElementById('digest-days')?.value) || 7;
  const cont = document.getElementById('digest-content');
  if (!cont) return;

  cont.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Analiz ediliyor...</div>';

  try {
    const r = await apiFetch(`${API}/api/semantic/digest/${currentServer._id}?days=${days}`);
    const d = await r.json();

    if (!r.ok) { cont.innerHTML = `<p style="color:var(--red);padding:16px">${escHtml(d.error)}</p>`; return; }

    const topChannels = (d.channelStats || []).slice(0, 5);
    const topUsers    = (d.topUsers || []).slice(0, 5);

    cont.innerHTML = `
      <!-- AI Ã–zet -->
      ${d.aiSummary ? `
      <div style="background:linear-gradient(135deg,var(--brand-dark,#3c4491),var(--brand,#5865f2));border-radius:10px;padding:14px 16px;margin-bottom:16px;color:#fff;">
        <div style="font-size:11px;opacity:.8;margin-bottom:6px;">ğŸ¤– AI Ã–ZET</div>
        <div style="line-height:1.7;font-size:14px;">${escHtml(d.aiSummary)}</div>
      </div>` : ''}

      <!-- Ã–zet Kartlar -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">
        <div style="background:var(--bg-3);border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:var(--brand);">${d.totalMessages?.toLocaleString('tr-TR') || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);">Mesaj</div>
        </div>
        <div style="background:var(--bg-3);border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:var(--green,#3ba55d);">${topUsers.length}</div>
          <div style="font-size:12px;color:var(--text-muted);">Aktif Ãœye</div>
        </div>
        <div style="background:var(--bg-3);border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:var(--yellow,#faa61a);">${topChannels.length}</div>
          <div style="font-size:12px;color:var(--text-muted);">Aktif Kanal</div>
        </div>
      </div>

      <!-- En Aktif Kanallar -->
      ${topChannels.length ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px;">ğŸ“¢ En Aktif Kanallar</div>
        ${topChannels.map((ch, i) => {
          const maxMsgs = topChannels[0].messageCount || 1;
          const pct = Math.round((ch.messageCount / maxMsgs) * 100);
          return `<div style="margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;">
              <span>#${escHtml(ch.channelName)}</span>
              <span style="color:var(--text-muted);">${ch.messageCount} mesaj</span>
            </div>
            <div style="background:var(--bg-3);border-radius:4px;height:6px;overflow:hidden;">
              <div style="width:${pct}%;height:100%;background:var(--brand);border-radius:4px;transition:width .4s;"></div>
            </div>
          </div>`;
        }).join('')}
      </div>` : ''}

      <!-- En Aktif Ãœyeler -->
      ${topUsers.length ? `
      <div style="margin-bottom:16px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px;">ğŸ† En Aktif Ãœyeler</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${topUsers.map((u, i) => `
            <div style="display:flex;align-items:center;gap:10px;background:var(--bg-3);border-radius:8px;padding:8px 10px;">
              <span style="font-size:16px;">${['ğŸ¥‡','ğŸ¥ˆ','ğŸ¥‰','4ï¸âƒ£','5ï¸âƒ£'][i] || (i+1)+'.'}</span>
              <span style="font-weight:600;font-size:13px;">${escHtml(u.username)}</span>
              <span style="color:var(--text-muted);font-size:12px;margin-left:auto;">${u.messageCount} mesaj</span>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <div style="font-size:11px;color:var(--text-muted);text-align:right;">
        ${d.cached ? 'âš¡ Ã–nbellekten Â· ' : ''}Son ${d.days} gÃ¼n Â· ${new Date(d.generatedAt).toLocaleString('tr-TR')}
      </div>`;
  } catch (err) {
    cont.innerHTML = `<p style="color:var(--red);padding:16px">Hata: ${escHtml(err.message)}</p>`;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BAÄLILIK & TREND ANALÄ°ZÄ°
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openEngagementDashboard() {
  if (!currentServer) return toast('Ã–nce bir sunucu seÃ§', 'error');

  const modal = document.createElement('div');
  modal.id = 'engagement-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:540px;width:95%;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="margin:0;">ğŸ“ˆ BaÄŸlÄ±lÄ±k & Trend</h2>
        <button class="icon-btn" onclick="document.getElementById('engagement-modal').remove()">âœ•</button>
      </div>
      <div id="engagement-content" style="flex:1;overflow-y:auto;">
        <div style="text-align:center;padding:32px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>YÃ¼kleniyor...</div>
      </div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);

  try {
    const r = await apiFetch(`${API}/api/semantic/engagement/${currentServer._id}`);
    const d = await r.json();
    const cont = document.getElementById('engagement-content');
    if (!r.ok || !cont) return;

    const trendIcon  = d.trend.direction === 'up' ? 'ğŸ“ˆ' : d.trend.direction === 'down' ? 'ğŸ“‰' : 'â¡ï¸';
    const trendColor = d.trend.direction === 'up' ? 'var(--green,#3ba55d)' : d.trend.direction === 'down' ? 'var(--red,#ed4245)' : 'var(--text-muted)';

    cont.innerHTML = `
      <!-- Trend KartÄ± -->
      <div style="background:var(--bg-3);border-radius:10px;padding:16px;margin-bottom:14px;display:flex;align-items:center;gap:14px;">
        <div style="font-size:40px;">${trendIcon}</div>
        <div>
          <div style="font-size:22px;font-weight:700;color:${trendColor};">
            ${d.trend.pct > 0 ? '+' : ''}${d.trend.pct}%
          </div>
          <div style="font-size:13px;color:var(--text-muted);">
            GeÃ§en haftaya gÃ¶re aktivite ${d.trend.direction === 'up' ? 'artÄ±ÅŸÄ±' : d.trend.direction === 'down' ? 'dÃ¼ÅŸÃ¼ÅŸÃ¼' : 'deÄŸiÅŸimi'}
          </div>
        </div>
      </div>

      <!-- Peak Saat -->
      <div style="background:var(--bg-3);border-radius:10px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">â° EN AKTÄ°F SAAT</div>
        <div style="font-size:20px;font-weight:700;">${escHtml(d.peakHourFormatted)}</div>
        <div style="font-size:12px;color:var(--text-muted);">MesajlarÄ±n yoÄŸunlaÅŸtÄ±ÄŸÄ± zaman dilimi</div>
      </div>

      <!-- DÃ¶nem KarÅŸÄ±laÅŸtÄ±rmasÄ± -->
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px;">ğŸ“Š DÃ–NEM KARÅILAÅTIRMASI</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
        ${(d.periods || []).map(p => `
          <div style="background:var(--bg-3);border-radius:8px;padding:10px 14px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-weight:600;">Son ${p.days} gÃ¼n</span>
              <span style="font-size:18px;font-weight:700;color:var(--brand);">${p.engagementPct}%</span>
            </div>
            <div style="display:flex;gap:16px;margin-top:4px;font-size:12px;color:var(--text-muted);">
              <span>ğŸ’¬ ${p.messages.toLocaleString('tr-TR')} mesaj</span>
              <span>ğŸ‘¥ ${p.activeUsers} / ${p.totalMembers} Ã¼ye aktif</span>
            </div>
            <div style="background:var(--bg-2);border-radius:4px;height:5px;margin-top:6px;overflow:hidden;">
              <div style="width:${p.engagementPct}%;height:100%;background:var(--brand);border-radius:4px;"></div>
            </div>
          </div>`).join('')}
      </div>

      <div style="font-size:11px;color:var(--text-muted);text-align:right;">
        ${new Date(d.generatedAt).toLocaleString('tr-TR')}
      </div>`;
  } catch (err) {
    const cont = document.getElementById('engagement-content');
    if (cont) cont.innerHTML = `<p style="color:var(--red);padding:16px">Hata: ${escHtml(err.message)}</p>`;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// E2EE DM GÄ°ZLÄ° MOD TOGGLE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _dmE2EActive = false;

async function toggleDmE2E() {
  if (!window.BridgeE2E) return toast('E2EE modÃ¼lÃ¼ yÃ¼klÃ¼ deÄŸil', 'error');

  const status = window.BridgeE2E.getStatus?.();
  if (!status?.enabled) {
    // E2EE kurulmamÄ±ÅŸ â€” kur
    const ok = confirm('Gizli Mod iÃ§in E2EE kurulumu gerekiyor. Åimdi kurulsun mu?\n\nPrivate key sadece bu cihazda kalÄ±r â€” sunucu mesajlarÄ±nÄ±zÄ± okuyamaz.');
    if (!ok) return;
    try {
      const myId = window.me?.id;
      if (!myId) return toast('Ã–nce giriÅŸ yapÄ±n', 'error');
      await window.BridgeE2E.setup(myId);
      toast('ğŸ”’ E2EE kuruldu! Gizli Mod aktif.', 'success');
    } catch (e) {
      return toast('E2EE kurulamadÄ±: ' + e.message, 'error');
    }
  }

  _dmE2EActive = !_dmE2EActive;
  const btn    = document.getElementById('e2e-dm-btn');
  const banner = document.getElementById('e2e-dm-banner');

  if (_dmE2EActive) {
    if (btn)    { btn.textContent = 'ğŸ”’'; btn.style.color = 'var(--green,#3ba55d)'; }
    if (banner) { banner.style.display = 'flex'; }
    // Partner key kontrolÃ¼
    if (window._currentDmUserId) {
      try {
        const r = await apiFetch(`${API}/api/e2e/keys/${window._currentDmUserId}`);
        const d = await r.json();
        const partnerBadge = document.getElementById('e2e-partner-badge');
        if (partnerBadge) {
          partnerBadge.textContent = d.hasKey ? 'âœ“ KarÅŸÄ± taraf E2EE destekliyor' : 'âš  KarÅŸÄ± taraf E2EE kurmamÄ±ÅŸ';
        }
      } catch {}
    }
  } else {
    if (btn)    { btn.textContent = 'ğŸ”“'; btn.style.color = ''; }
    if (banner) { banner.style.display = 'none'; }
  }
}

// DM kanalÄ± deÄŸiÅŸtiÄŸinde E2EE sÄ±fÄ±rla
function resetDmE2E() {
  _dmE2EActive = false;
  const btn    = document.getElementById('e2e-dm-btn');
  const banner = document.getElementById('e2e-dm-banner');
  if (btn)    { btn.textContent = 'ğŸ”“'; btn.style.color = ''; }
  if (banner) { banner.style.display = 'none'; }
}

// sendDm hook â€” E2EE aktifse mesajÄ± ÅŸifrele
const _origSendDm = window.sendDm;
window.sendDm = async function() {
  if (!_dmE2EActive || !window.BridgeE2E || !window._currentDmUserId) {
    return typeof _origSendDm === 'function' ? _origSendDm() : null;
  }
  const input = document.getElementById('dm-input');
  if (!input?.value?.trim()) return;
  try {
    const myId = window.me?.id;
    if (!myId) return typeof _origSendDm === 'function' ? _origSendDm() : null;
    // encryptDM handles key fetching internally
    const encrypted = await window.BridgeE2E.encryptDM(input.value, window._currentDmUserId, myId);
    if (!encrypted) {
      toast('âš ï¸ KarÅŸÄ± taraf E2EE kurmamÄ±ÅŸ â€” normal mesaj gÃ¶nderiliyor', 'warn');
      return typeof _origSendDm === 'function' ? _origSendDm() : null;
    }
    const originalValue = input.value;
    input.value = `ğŸ”’e2e:${encrypted}`;
    const result = typeof _origSendDm === 'function' ? await _origSendDm() : null;
    if (!result && input.value !== '') input.value = originalValue;
    return result;
  } catch (e) {
    toast('E2EE hatasÄ± â€” normal gÃ¶nderiliyor', 'warn');
    return typeof _origSendDm === 'function' ? _origSendDm() : null;
  }
};

