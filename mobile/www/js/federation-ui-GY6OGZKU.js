import{a as f}from"/chunk-IWFQIIHO.js";import{a as o}from"/chunk-6BHHOTS6.js";import"/chunk-BI7TSH2W.js";async function E(){var n;let t=o.get("getCurrentUser"),i=((n=t==null?void 0:t())==null?void 0:n.isAdmin)||!1,e=document.createElement("div");e.id="federation-modal",e.className="modal-overlay",e.innerHTML=`
    <div class="modal-card" style="max-width:660px;width:95%;max-height:85vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <h2 style="margin:0;">\u{1F310} Federasyon A\u011F\u0131</h2>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">Farkl\u0131 Bridge sunucular\u0131n\u0131 ke\u015Ffet ve ba\u011Flan</p>
        </div>
        <button class="icon-btn" onclick="document.getElementById('federation-modal').remove()">\u2715</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-3);border-radius:8px;padding:4px;flex-wrap:wrap;">
        <button id="fed-tab-discover" class="btn btn-primary" style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('discover')">\u011F\u0178\u0152\x8D Ke\u015Ffet</button>
        <button id="fed-tab-peers"    class="btn"             style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('peers')">\u011F\u0178\u201D\u2014 Peerlar</button>
        <button id="fed-tab-add"      class="btn"             style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('add')">\u27A2 Ekle</button>
        ${i?`<button id="fed-tab-acl" class="btn" style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('acl')">\u011F\u0178\u203A\xA1\xEF\xB8\x8F ACL</button>`:""}
      </div>
      <div id="fed-content" style="flex:1;overflow-y:auto;"></div>
    </div>`,e.onclick=r=>{r.target===e&&e.remove()},document.body.appendChild(e),L("discover")}var z="discover";function L(t){z=t,["discover","peers","add","acl"].forEach(e=>{let n=document.getElementById(`fed-tab-${e}`);n&&(n.className=e===t?"btn btn-primary":"btn",n.style.flex="1",n.style.justifyContent="center",n.style.fontSize="12px")}),document.getElementById("fed-content")&&(t==="discover"?H():t==="peers"?I():t==="add"?S():t==="acl"&&T())}async function H(){let t=document.getElementById("fed-content");t&&(t.innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <input id="fed-peer-url-search" type="text" class="input" placeholder="bridge.example.com" style="flex:1;">
      <button class="btn btn-primary" onclick="fetchRemoteServers()">Ke\u015Ffet</button>
    </div>
    <div id="fed-remote-results">
      <div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">\u{1F310}</div>
        <p>Bir Bridge sunucu URL'si girerek uzak sunucular\u0131 ke\u015Ffedin.</p>
      </div>
    </div>`)}async function I(){let t=document.getElementById("fed-content");if(t){t.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Y\xFCkleniyor...</div>';try{let e=await(await apiFetch(`${API}/api/federation/peers`)).json();if(!e.length){t.innerHTML=`<div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">\u011F\u0178\u201D\u2014</div>
        <p>Hen\xFCz ba\u011Fl\u0131 peer yok.</p></div>`;return}t.innerHTML=`
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${e.length} kay\u0131tl\u0131 peer</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${e.map(n=>{let r=n.lastSeen?new Date(n.lastSeen).toLocaleString("tr-TR"):"Bilinmiyor";return`<div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;display:flex;gap:10px;align-items:center;">
            <div style="width:10px;height:10px;border-radius:50%;background:${n.lastSeen&&Date.now()-n.lastSeen<600*1e3?"var(--green,#3ba55d)":"var(--text-muted)"};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:13px;">${escHtml(n.name||n.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(n.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Son g\xF6r\xFClme: ${r}</div>
            </div>
            ${n.verified?'<span style="font-size:18px;" title="Do\u011Frulanm\u0131\u015F">\u2705</span>':""}
          </div>`}).join("")}
      </div>`}catch(i){t.innerHTML=`<div style="color:var(--red);padding:16px">Hata: ${escHtml(i.message)}</div>`}}}function S(){let t=document.getElementById("fed-content");t&&(t.innerHTML=`
    <div style="max-width:420px;">
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Ba\u015Fka bir Bridge sunucusunu federasyon a\u011F\u0131na ekle.</p>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Sunucu URL</label>
        <input id="fed-add-url" type="text" class="input" placeholder="https://bridge.example.com" style="width:100%;margin-top:4px;">
      </div>
      <button class="btn btn-primary" onclick="submitFedPeer()" style="width:100%;justify-content:center;">\u011F\u0178\u201D\u2014 Peer Ekle</button>
    </div>`)}async function T(){let t=document.getElementById("fed-content");if(t){t.innerHTML='<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>ACL y\xFCkleniyor...</div>';try{let[i,e]=await Promise.all([apiFetch(`${API}/api/admin/federation/whitelist`),apiFetch(`${API}/api/admin/federation/blacklist`)]),{whitelist:n=[]}=await i.json().catch(()=>({whitelist:[]})),{blacklist:r=[]}=await e.json().catch(()=>({blacklist:[]}));t.innerHTML=`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

        <!-- WHITELIST -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="margin:0;font-size:14px;">\u2705 Whitelist <span style="font-weight:400;color:var(--text-muted);">(${n.length})</span></h3>
            <button class="btn btn-primary" style="font-size:11px;padding:4px 8px;" onclick="fedACLAdd('whitelist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">Yaln\u0131zca bu listeden gelen ActivityPub etkinlikleri kabul edilir. Bo\u015Fsa herkese a\xE7\u0131k.</p>
          <div id="fed-whitelist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${n.length?n.map(a=>b(a,"whitelist")).join(""):'<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Bo\u015F \u2014 t\xFCm sunucular kabul ediliyor</div>'}
          </div>
        </div>

        <!-- BLACKLIST -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="margin:0;font-size:14px;">\u011F\u0178\u0161\xAB Blacklist <span style="font-weight:400;color:var(--text-muted);">(${r.length})</span></h3>
            <button class="btn" style="font-size:11px;padding:4px 8px;background:var(--red,#ed4245);color:#fff;border:none;" onclick="fedACLAdd('blacklist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">Bu listeden gelen ActivityPub etkinlikleri otomatik reddedilir.</p>
          <div id="fed-blacklist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${r.length?r.map(a=>b(a,"blacklist")).join(""):'<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Bo\u015F \u2014 engelli sunucu yok</div>'}
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
      </div>`}catch(i){t.innerHTML=`<div style="color:var(--red);padding:16px">Hata: ${escHtml(i.message)}</div>`}}}function b(t,i){let e=i==="whitelist",n=t.addedAt?new Date(t.addedAt).toLocaleDateString("tr-TR"):"";return`
    <div style="background:var(--bg-2);border-radius:6px;padding:8px 10px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:16px;">${e?"\u2705":"\u011F\u0178\u0161\xAB"}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.domain)}</div>
        ${t.reason?`<div style="font-size:10px;color:var(--text-muted);">${escHtml(t.reason)}</div>`:""}
        ${n?`<div style="font-size:10px;color:var(--text-muted);">Eklendi: ${n}</div>`:""}
      </div>
      <button class="icon-btn" title="Kald\u0131r" onclick="fedACLRemove('${i}','${escHtml(t.domain)}')" style="font-size:12px;color:var(--red,#ed4245);">\u2715</button>
    </div>`}var l=null;async function y(){if(l)return l;try{let t=await fetch(`${f()}/api/federation/stats`);return t.ok?(l=await t.json(),l):null}catch{return null}}function B(t){Array.isArray(t)&&t.forEach(i=>{if(!i.federated&&!i.isFederated&&!i.peerUrl&&!i.remoteUrl)return;let e=document.querySelector(`.server-icon[data-id="${i._id}"]`);if(!e||e.querySelector(".fed-badge"))return;let n=document.createElement("div");n.className="fed-badge",n.title=`Federe sunucu${i.peerUrl?` \u2014 ${i.peerUrl}`:""}`,n.style.cssText=`
      position:absolute; bottom:-2px; right:-2px;
      width:14px; height:14px; border-radius:50%;
      background:var(--brand,#2d9cdb);
      border:2px solid var(--bg-1,#1e1f22);
      display:flex; align-items:center; justify-content:center;
      font-size:7px; line-height:1; z-index:5;
    `,n.textContent="\u{1F310}",e.style.position="relative",e.appendChild(n)})}(function t(){let i=o.get("renderServerList");if(!i){window.addEventListener("load",t,{once:!0});return}o.register("renderServerList",function(e){i(e),B(e)})})();(function t(){let i=o.get("showMemberProfile");if(!i){window.addEventListener("load",t,{once:!0});return}o.register("showMemberProfile",async function(e,n,r,a,u,c){i.call(this,e,n,r,a,u,c);let s=document.querySelector(".member-profile-popup");if(s)try{let x=await fetch(`${f()}/api/users/${n}/profile`);if(!x.ok)return;let k=await x.json(),p=await y(),w=k.username||n,$=p!=null&&p.instance?new URL(p.instance).hostname:location.hostname||"bridge.local",m=`@${w}@${$}`,g=s.querySelector(".profile-name");if(!g||s.querySelector(".fed-handle"))return;let d=document.createElement("div");d.className="fed-handle",d.style.cssText=`
        font-size:11px; color:var(--text-muted,#72767d);
        margin-top:3px; font-family:monospace;
        display:flex; align-items:center; gap:5px; cursor:pointer;
        user-select:all;
      `,d.innerHTML=`<span style="color:var(--brand,#2d9cdb)">\u{1F310}</span>${escHtml(m)}`,d.title="Federe kimlik \u2014 kopyalamak i\xE7in t\u0131kla",d.onclick=()=>{var v;(v=navigator.clipboard)==null||v.writeText(m).then(()=>{d.textContent="\u2713 Kopyaland\u0131!",setTimeout(()=>{d.innerHTML=`<span style="color:var(--brand,#2d9cdb)">\u{1F310}</span>${escHtml(m)}`},1500)})},g.insertAdjacentElement("afterend",d)}catch{}})})();(function t(){let i=o.get("selectServer");if(!i){window.addEventListener("load",t,{once:!0});return}o.register("selectServer",async function(e){var c,s;if(await i.call(this,e),(c=document.getElementById("fed-server-banner"))==null||c.remove(),!(e.federated||e.isFederated||e.peerUrl||e.remoteUrl))return;let r=document.getElementById("sidebar-server-name");if(!r)return;let a=document.createElement("div");a.id="fed-server-banner",a.style.cssText=`
      display:flex; align-items:center; gap:6px;
      padding:4px 12px; background:rgba(45,156,219,0.1);
      border-bottom:1px solid rgba(45,156,219,0.2);
      font-size:11px; color:var(--brand,#2d9cdb);
    `;let u=e.peerUrl?(()=>{try{return new URL(e.peerUrl).hostname}catch{return e.peerUrl}})():"federe a\u011F";a.innerHTML=`\u{1F310} <span style="opacity:.7">Bu sunucu</span> <strong>${escHtml(u)}</strong> <span style="opacity:.7">\xFCzerinde federe</span>`,(s=r.parentElement)==null||s.insertAdjacentElement("afterend",a)})})();async function h(){if(document.getElementById("fed-sidebar-widget"))return;let t=await y();if(!t)return;let i=document.querySelector(".u-actions, #user-area, .user-panel");if(!i)return;let e=document.createElement("div");e.id="fed-sidebar-widget",e.style.cssText=`
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; margin:4px 8px;
    background:rgba(45,156,219,0.08);
    border:1px solid rgba(45,156,219,0.15);
    border-radius:8px; cursor:pointer;
    font-size:12px; color:var(--text-2,#b5bac1);
    transition:background .15s, border-color .15s;
  `,e.innerHTML=`
    <span style="font-size:16px">\u{1F310}</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;color:var(--text-1,#f2f3f5);font-size:11px;white-space:nowrap">Federasyon</div>
      <div id="fed-widget-count" style="font-size:10px;color:var(--text-muted,#72767d)">
        ${t.peerCount} peer ba\u011Fl\u0131
      </div>
    </div>
    <span style="font-size:10px;opacity:.4">\u203A</span>
  `,e.title="Federasyon a\u011F\u0131n\u0131 g\xF6r\xFCnt\xFCle",e.onmouseenter=()=>{e.style.background="rgba(45,156,219,0.15)",e.style.borderColor="rgba(45,156,219,0.3)"},e.onmouseleave=()=>{e.style.background="rgba(45,156,219,0.08)",e.style.borderColor="rgba(45,156,219,0.15)"},e.onclick=()=>{o.call("openFederationUI")},i.insertBefore(e,i.firstChild),setInterval(async()=>{let n=await y(),r=document.getElementById("fed-widget-count");r&&n&&(l=n,r.textContent=`${n.peerCount} peer ba\u011Fl\u0131`)},6e4)}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",h):setTimeout(h,800);o.register("openFederationUI",E);export{B as applyFederationBadges,h as initFederationWidget};
