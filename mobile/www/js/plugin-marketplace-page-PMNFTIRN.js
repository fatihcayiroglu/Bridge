import{a as s}from"/chunk-6BHHOTS6.js";import"/chunk-BI7TSH2W.js";(function(){var m;let p=window.BRIDGE_API||location.origin,d=[],u=[],c=[];async function r(a,n={}){let t=localStorage.getItem("token"),e=Object.assign({},n.headers||{});t&&(e.Authorization=`Bearer ${t}`);let l=await fetch(`${p}${a}`,{...n,headers:e});if(!l.ok)throw new Error(`HTTP ${l.status}`);return l.json()}function g(a,n,t){return`<article class="card"><div style="font-weight:700;margin-bottom:6px">${a}</div><div class="muted">${n||"A\xE7\u0131klama yok"}</div><div style="margin-top:8px;font-size:12px;color:var(--text-3)">${t||""}</div></article>`}function i(a){return String(a||"").replace(/[&<>"']/g,n=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[n])}async function y(a){let n=document.getElementById("plugins");n.innerHTML='<div class="muted">Y\xFCkleniyor...</div>';try{let t=await r("/api/plugins");a&&(t=t.filter(e=>`${e.name} ${e.description}`.toLowerCase().includes(a))),u=t,n.innerHTML=t.length?t.map((e,l)=>`
          ${g(`\u011F\u0178\u201D\u0152 ${e.name}`,e.description,`${e.author||"unknown"} \xC2\xB7 v${e.version||"?"}`)}
          <div class="row" style="margin-top:-8px;margin-bottom:10px">
            <button class="btn" onclick="showPluginDetails(${l})">Detay</button>
          </div>
        `).join(""):'<div class="muted">Plugin bulunamad\u0131.</div>'}catch{n.innerHTML='<div class="muted">Plugin listesi i\xE7in giri\u015F yapman gerekiyor.</div>'}}async function v(a){let n=document.getElementById("bots");n.innerHTML='<div class="muted">Y\xFCkleniyor...</div>';try{let t=await r(`/api/bots/marketplace?category=all&limit=60${a?`&q=${encodeURIComponent(a)}`:""}`);d=t,n.innerHTML=t.length?t.map((e,l)=>`
          <article class="card">
            <div style="font-weight:700;margin-bottom:6px">\u011F\u0178\xA4\u2013 ${i(e.username)}</div>
            <div class="muted">${i(e.description||"A\xE7\u0131klama yok")}</div>
            <div class="row">
              <span class="pill">${i(e.category||"utility")}</span>
              <span class="pill">\u{1F310} ${e.serverCount||0} sunucu</span>
              <span class="pill">\xE2\xAD\x90 ${e.rating||0} (${e.ratingCount||0})</span>
            </div>
            <div class="row">
              <button class="btn" onclick="showBotDetails(${l})">Detay</button>
              <button class="btn btn-primary" onclick="installBotFlow('${i(e._id)}')">Kur</button>
            </div>
          </article>
        `).join(""):'<div class="muted">Bot bulunamad\u0131.</div>'}catch{n.innerHTML='<div class="muted">Bot listesi y\xFCklenemedi.</div>'}}async function k(){try{let a=await r("/api/servers");c=Array.isArray(a)?a:[]}catch{c=[]}}s.register("closeMktModal",function(){let n=document.getElementById("marketplace-modal");n&&(n.style.display="none")}),s.register("showPluginDetails",function(n){let t=u[Number(n)];if(!t)return;let e=document.getElementById("mkt-modal-content");e.innerHTML=`
      <h2>\u011F\u0178"\u0152 ${i(t.name)}</h2>
      <p class="muted">${i(t.description||"A\xE7\u0131klama yok")}</p>
      <div class="row">
        <span class="pill">Yazar: ${i(t.author||"unknown")}</span>
        <span class="pill">S\xFCr\xFCm: ${i(t.version||"?")}</span>
        <span class="pill">ID: ${i(t.id||"-")}</span>
      </div>
      <p class="muted" style="margin-top:12px">Pluginler \u015Fu anda sunucu taraf\u0131nda y\xFCklenmi\u015F bile\u015Fenler olarak listelenir. Bu ekran g\xF6r\xFCn\xFCrl\xFCk ve ke\u015Fif i\xE7in haz\u0131rlanm\u0131\u015Ft\u0131r.</p>
    `;let l=document.getElementById("marketplace-modal");l&&(l.style.display="flex")}),s.register("showBotDetails",function(n){let t=d[Number(n)];if(!t)return;let e=document.getElementById("mkt-modal-content");e.innerHTML=`
      <h2>\u011F\u0178\xA4\u2013 ${i(t.username)}</h2>
      <p class="muted">${i(t.description||"A\xE7\u0131klama yok")}</p>
      <div class="row">
        <span class="pill">Kategori: ${i(t.category||"utility")}</span>
        <span class="pill">Komut: ${t.commands||0}</span>
        <span class="pill">Puan: \xE2\xAD\x90 ${t.rating||0} (${t.ratingCount||0})</span>
      </div>
      <div class="row">
        <label style="font-size:13px;width:100%">Puan ver (1-5)</label>
        <input id="mkt-rate-value" class="input-field field" type="number" min="1" max="5" value="5">
        <button class="btn btn-primary" onclick="rateBot('${i(t._id)}')">Puanla</button>
      </div>
      <div class="row">
        <label style="font-size:13px;width:100%">Kurulum i\xE7in hedef sunucu</label>
        <select id="mkt-install-server" class="input-field field">
          ${c.length?c.map(o=>`<option value="${i(o._id)}">${i(o.name||o._id)}</option>`).join(""):'<option value="">Yonetebildigin sunucu bulunamadi</option>'}
        </select>
        <button class="btn btn-primary" onclick="installBotWithServer('${i(t._id)}')">Server'a Kur</button>
      </div>
    `;let l=document.getElementById("marketplace-modal");l&&(l.style.display="flex")}),s.register("rateBot",async function(n){var t;try{let e=Number((((t=document.getElementById("mkt-rate-value"))==null?void 0:t.value)??"")||0);if(e<1||e>5)throw new Error("Puan 1-5 aras\u0131 olmal\u0131");await r(`/api/bots/${n}/rate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rating:e})}),alert("Puanlama kaydedildi."),await s.call("loadMarketplace")}catch(e){alert(e.message||"Puanlama ba\u015Far\u0131s\u0131z")}}),s.register("installBotFlow",function(n){let t=prompt("Kurulum i\xE7in server ID gir");t&&s.call("installBotWithServer",n,t)}),s.register("installBotWithServer",async function(n,t){var e,l;try{let o=t||((l=(e=document.getElementById("mkt-install-server"))==null?void 0:e.value)==null?void 0:l.trim());if(!o)throw new Error("Server ID gerekli");await r(`/api/servers/${o}/bots/${n}/add`,{method:"POST"}),alert("Bot sunucuya eklendi.")}catch(o){alert(o.message||"Kurulum ba\u015Far\u0131s\u0131z")}}),s.register("loadMarketplace",async function(){var t;let n=(((t=document.getElementById("q"))==null?void 0:t.value)||"").trim().toLowerCase();await Promise.all([k(),y(n),v(n)])}),(m=document.getElementById("q"))==null||m.addEventListener("keydown",a=>{a.key==="Enter"&&s.call("loadMarketplace")}),s.call("loadMarketplace")})();
