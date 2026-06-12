import{a as d}from"/chunk-6BHHOTS6.js";import"/chunk-BI7TSH2W.js";var p="discover";function m(e){p=e,["discover","peers","add","acl"].forEach(o=>{let t=document.getElementById(`fed-tab-${o}`);t&&(t.className=o===e?"btn btn-primary":"btn",t.style.flex="1",t.style.justifyContent="center",t.style.fontSize="12px")}),document.getElementById("fed-content")&&(e==="discover"?f():e==="peers"?u():e==="add"?y():e==="acl"&&x())}async function f(){let e=document.getElementById("fed-content");e&&(e.innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <input id="fed-peer-url-search" type="text" class="input" placeholder="bridge.example.com" style="flex:1;">
      <button class="btn btn-primary" onclick="fetchRemoteServers()">Ke\u015Ffet</button>
    </div>
    <div id="fed-remote-results">
      <div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">\u{1F310}</div>
        <p>Bir Bridge sunucu URL'si girerek uzak sunucular\u0131 ke\u015Ffedin.</p>
      </div>
    </div>`)}async function u(){let e=document.getElementById("fed-content");if(e){e.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Y\xFCkleniyor...</div>';try{let o=await(await apiFetch(`${API}/api/federation/peers`)).json();if(!o.length){e.innerHTML=`<div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">\u011F\u0178\u201D\u2014</div>
        <p>Hen\xFCz ba\u011Fl\u0131 peer yok.</p></div>`;return}e.innerHTML=`
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${o.length} kay\u0131tl\u0131 peer</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${o.map(t=>{let i=t.lastSeen?new Date(t.lastSeen).toLocaleString("tr-TR"):"Bilinmiyor";return`<div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;display:flex;gap:10px;align-items:center;">
            <div style="width:10px;height:10px;border-radius:50%;background:${t.lastSeen&&Date.now()-t.lastSeen<600*1e3?"var(--green,#3ba55d)":"var(--text-muted)"};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:13px;">${escHtml(t.name||t.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(t.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Son g\xF6r\xFClme: ${i}</div>
            </div>
            ${t.verified?'<span style="font-size:18px;" title="Do\u011Frulanm\u0131\u015F">\u2705</span>':""}
          </div>`}).join("")}
      </div>`}catch(n){e.innerHTML=`<div style="color:var(--red);padding:16px">Hata: ${escHtml(n.message)}</div>`}}}function y(){let e=document.getElementById("fed-content");e&&(e.innerHTML=`
    <div style="max-width:420px;">
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Ba\u015Fka bir Bridge sunucusunu federasyon a\u011F\u0131na ekle.</p>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Sunucu URL</label>
        <input id="fed-add-url" type="text" class="input" placeholder="https://bridge.example.com" style="width:100%;margin-top:4px;">
      </div>
      <button class="btn btn-primary" onclick="submitFedPeer()" style="width:100%;justify-content:center;">\u011F\u0178\u201D\u2014 Peer Ekle</button>
    </div>`)}async function x(){let e=document.getElementById("fed-content");if(e){e.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>ACL y\xFCkleniyor...</div>';try{let[n,o]=await Promise.all([apiFetch(`${API}/api/admin/federation/whitelist`),apiFetch(`${API}/api/admin/federation/blacklist`)]),{whitelist:t=[]}=await n.json().catch(()=>({whitelist:[]})),{blacklist:i=[]}=await o.json().catch(()=>({blacklist:[]}));e.innerHTML=`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

        <!-- WHITELIST -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="margin:0;font-size:14px;">\u2705 Whitelist <span style="font-weight:400;color:var(--text-muted);">(${t.length})</span></h3>
            <button class="btn btn-primary" style="font-size:11px;padding:4px 8px;" onclick="fedACLAdd('whitelist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">Yaln\u0131zca bu listeden gelen ActivityPub etkinlikleri kabul edilir. Bo\u015Fsa herkese a\xE7\u0131k.</p>
          <div id="fed-whitelist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${t.length?t.map(a=>s(a,"whitelist")).join(""):'<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Bo\u015F \u2014 t\xFCm sunucular kabul ediliyor</div>'}
          </div>
        </div>

        <!-- BLACKLIST -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="margin:0;font-size:14px;">\u011F\u0178\u0161\xAB Blacklist <span style="font-weight:400;color:var(--text-muted);">(${i.length})</span></h3>
            <button class="btn" style="font-size:11px;padding:4px 8px;background:var(--red,#ed4245);color:#fff;border:none;" onclick="fedACLAdd('blacklist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">Bu listeden gelen ActivityPub etkinlikleri otomatik reddedilir.</p>
          <div id="fed-blacklist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${i.length?i.map(a=>s(a,"blacklist")).join(""):'<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Bo\u015F \u2014 engelli sunucu yok</div>'}
          </div>
        </div>

      </div>

      <!-- Ekle Modal (inline) -->
      <div id="fed-acl-add-form" style="display:none;margin-top:16px;background:var(--bg-3);border-radius:8px;padding:14px;">
        <h4 style="margin:0 0 10px;" id="fed-acl-add-title">Sunucu Ekle</h4>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="fed-acl-domain" type="text" class="input" placeholder="example.com veya *.example.com" style="flex:1;">
          <button class="btn btn-primary" onclick="fedACLSubmit()">Kaydet</button>
          <button class="btn" onclick="document.getElementById('fed-acl-add-form').style.display='none'">\u0130ptal</button>
        </div>
        <input id="fed-acl-reason" type="text" class="input" placeholder="Gerek\xE7e (opsiyonel)" style="width:100%;">
        <input type="hidden" id="fed-acl-type">
      </div>`}catch(n){e.innerHTML=`<div style="color:var(--red);padding:16px">Hata: ${escHtml(n.message)}</div>`}}}function s(e,n){let o=n==="whitelist",t=e.addedAt?new Date(e.addedAt).toLocaleDateString("tr-TR"):"";return`
    <div style="background:var(--bg-2);border-radius:6px;padding:8px 10px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:16px;">${o?"\u2705":"\u011F\u0178\u0161\xAB"}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(e.domain)}</div>
        ${e.reason?`<div style="font-size:10px;color:var(--text-muted);">${escHtml(e.reason)}</div>`:""}
        ${t?`<div style="font-size:10px;color:var(--text-muted);">Eklendi: ${t}</div>`:""}
      </div>
      <button class="icon-btn" title="Kald\u0131r" onclick="fedACLRemove('${n}','${escHtml(e.domain)}')" style="font-size:12px;color:var(--red,#ed4245);">\u2715</button>
    </div>`}async function v(){let e=document.getElementById("fed-content");if(e){e.innerHTML='<div style="text-align:center;padding:32px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Y\xFCkleniyor\u2026</div>';try{let n=await apiFetch(`${API}/api/federation/timeline?limit=20`),o=await n.json();if(!n.ok)throw new Error(o.error||"Hata");let t=o.items||[];if(!t.length){e.innerHTML=`<div style="text-align:center;padding:32px;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:8px;">\u011F\u0178\u201C\xA1</div>
        <p>Federated timeline bo\u015F. Birini takip et!</p>
        <button class="btn btn-primary" onclick="switchFedTab('discover')">Sunucular\u0131 Ke\u015Ffet</button>
      </div>`;return}e.innerHTML=t.map(i=>{let a="@"+(i.actorUrl||"?").replace(/^https?:\/\//,"").replace(/\/.*$/,""),r=i.published?new Date(i.published).toLocaleString("tr-TR"):"",c=(i.content||"").replace(/<[^>]*>/g,"").slice(0,500);return`<div style="border-bottom:1px solid var(--bg-4);padding:12px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;color:var(--brand);cursor:pointer;font-weight:600;"
            onclick="openFedProfileModal('${escHtml(i.actorUrl)}')">${escHtml(a)}</span>
          <span style="font-size:11px;color:var(--text-muted)">${escHtml(r)}</span>
        </div>
        <p style="font-size:13px;margin:0 0 8px;color:var(--text-1);">${escHtml(c)}</p>
        ${i.sensitive?'<span style="font-size:10px;background:var(--bg-4);padding:2px 6px;border-radius:4px;">CW</span>':""}
        <div style="display:flex;gap:8px;margin-top:6px;">
          ${i.apId?`
            <button onclick="fedLikeNote('${escHtml(i.apId)}')" class="btn" style="font-size:11px;padding:3px 8px;">\xE2\x9D\xA4\xEF\xB8\x8F</button>
            <button onclick="fedAnnounceNote('${escHtml(i.apId)}')" class="btn" style="font-size:11px;padding:3px 8px;">\u011F\u0178\u201D\x81</button>
          `:""}
        </div>
      </div>`}).join("")}catch(n){e.innerHTML=`<p style="color:var(--danger,#ed4245);padding:16px;">${escHtml(n.message)}</p>`}}}var l=d.get("openFederationUI")??(()=>{});d.register("openFederationUI",function(){l==null||l(),setTimeout(()=>{var o;let e=(o=document.querySelector('#federation-modal .btn[onclick*="switchFedTab"]'))==null?void 0:o.parentElement;if(e&&!document.getElementById("fed-tab-timeline")){let t=document.createElement("button");t.id="fed-tab-timeline",t.className="btn",t.style.cssText="flex:1;justify-content:center;font-size:12px;",t.textContent="\u011F\u0178\u201C\xA1 Timeline",t.onclick=()=>m("timeline"),e.appendChild(t)}let n=d.get("switchFedTab")??(()=>{});n&&!n._patched&&d.register("switchFedTab",function(t){if(t==="timeline"){let i=document.getElementById("fed-tab-timeline");i&&(i.className="btn btn-primary",i.style.flex="1",i.style.justifyContent="center",i.style.fontSize="12px"),["discover","peers","add","acl"].forEach(a=>{let r=document.getElementById(`fed-tab-${a}`);r&&(r.className="btn",r.style.flex="1")}),v()}else{let i=document.getElementById("fed-tab-timeline");i&&(i.className="btn"),n(t)}})},100)});
