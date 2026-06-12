import{a as p}from"/chunk-IWFQIIHO.js";import{a as i}from"/chunk-6BHHOTS6.js";import"/chunk-BI7TSH2W.js";var b="all",v=null;function s(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function S(){window.location.href="/marketplace"}async function B(){var o;(o=document.getElementById("temp-modal"))==null||o.remove();let t=document.createElement("div");t.id="marketplace-modal",t.className="modal-overlay",t.style.cssText="z-index:10000;",t.innerHTML=`
    <div class="modal-card" style="max-width:800px;width:96%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;padding:0">
      <div style="padding:20px 24px 12px;border-bottom:1px solid var(--bg-4);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:20px;font-weight:800">\u{1F916} Bot Marketplace</h2>
          <p style="color:var(--text-3);font-size:13px;margin-top:2px">Bridge i\xE7in botlar\u0131 ke\u015Ffet ve sunucuna ekle</p>
        </div>
        <button data-bridge-action="closeMarketplace" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-3);padding:4px 8px">\u2715</button>
      </div>
      <div style="padding:12px 24px;border-bottom:1px solid var(--bg-4);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="mkt-search" type="text" class="input-field" placeholder="\u{1F50D} Bot ara..." style="flex:1;min-width:160px;padding:8px 12px;font-size:13px">
      </div>
      <div id="mkt-cats" style="padding:10px 24px;border-bottom:1px solid var(--bg-4);display:flex;gap:6px;flex-wrap:wrap;overflow-x:auto"></div>
      <div id="mkt-grid" style="overflow-y:auto;flex:1;padding:16px 24px" class="marketplace-grid">
        <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3)">Y\xFCkleniyor...</div>
      </div>
    </div>`,document.body.appendChild(t),t.addEventListener("click",e=>{e.target===t&&t.remove()});let a=t.querySelector("#mkt-search");a==null||a.addEventListener("input",e=>{k(e.target.value)}),await T(),await x()}async function T(){let t=p(),a=localStorage.getItem("token"),o=await fetch(`${t}/api/bots/marketplace/categories`,{headers:a?{Authorization:`Bearer ${a}`}:{}}),e=o.ok?await o.json():[],d=document.getElementById("mkt-cats");d&&(d.innerHTML=e.map(n=>`<button class="filter-chip ${n.id===b?"active":""}" data-bridge-action="setMktCategory" data-bridge-arg="${n.id}" data-cat="${n.id}">
      ${n.icon} ${s(n.label)}
    </button>`).join(""))}async function A(t){b=t,document.querySelectorAll("#mkt-cats .filter-chip").forEach(a=>a.classList.toggle("active",a.dataset.cat===t)),await x()}function k(t){v&&clearTimeout(v),v=setTimeout(()=>{x(t)},320)}async function x(t=""){let a=document.getElementById("mkt-grid");if(!a)return;a.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-3)">Y\xFCkleniyor...</div>';let o=p(),e=localStorage.getItem("token"),d=new URLSearchParams({category:b,limit:"60"});t&&d.set("q",t);let n=await fetch(`${o}/api/bots/marketplace?${d}`,{headers:e?{Authorization:`Bearer ${e}`}:{}}),c=n.ok?await n.json():{bots:[],total:0},l=Array.isArray(c.bots)?c.bots:[];if(!l.length){a.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3)"><div style="font-size:40px;margin-bottom:8px">\u{1F916}</div><div>Bu kategoride bot bulunamad\u0131</div></div>';return}a.innerHTML="";for(let r of l){let g=document.createElement("div");g.className="bot-card";let u=Number(r.rating||0),h="\u2B50".repeat(Math.min(5,Math.round(u))),y=String(r.name??r.username??"Unknown Bot"),m=String(r.avatar??r.icon??"\u{1F916}"),w=Number(r.installs??r.serverCount??0),$=String(r.id??r._id??""),M=Array.isArray(r.commands)?r.commands.length:0;g.innerHTML=`
      <div class="bot-card-header">
        <div class="bot-avatar">${m.startsWith("http")?`<img src="${s(m)}" width="44" height="44" style="border-radius:50%">`:`<span style="font-size:32px">${s(m)}</span>`}</div>
        <div>
          <div class="bot-name">${s(y)} ${r.verified?'<span class="bot-verified-badge">\u2713 Do\u011Fruland\u0131</span>':""}</div>
          <div class="bot-category">${s(String(r.category??""))}</div>
        </div>
      </div>
      <div class="bot-desc">${s(String(r.description||"A\xE7\u0131klama yok."))}</div>
      <div class="bot-stats">
        <span title="Sunucu say\u0131s\u0131">\u{1F310} ${w.toLocaleString()} sunucu</span>
        <span title="Komut say\u0131s\u0131">\u26A1 ${M} komut</span>
        ${u?`<span title="Puan">${h} ${u.toFixed(1)}</span>`:""}
      </div>
      <button class="bot-add-btn" data-bridge-action="addBotToServer" data-bridge-arg="${s($)}" data-bot-name="${s(y)}">+ Sunucuya Ekle</button>`,a.appendChild(g)}}async function E(t,a){var r;let o=(r=i.get("getCurrentServer"))==null?void 0:r(),e=i.get("toast");if(!o){e==null||e("\xD6nce bir sunucu se\xE7","error");return}let d=p(),n=localStorage.getItem("token"),c=await fetch(`${d}/api/servers/${o._id}/bots/${t}/add`,{method:"POST",headers:n?{Authorization:`Bearer ${n}`}:{}}),l=await c.json();if(!c.ok){e==null||e(l.error??"Eklenemedi","error");return}e==null||e(`${a??t} sunucuya eklendi! \u{1F916}`,"success")}i.register("openMarketplacePage",S);i.register("openBotMarketplace",B);i.register("setMktCategory",A);i.register("debounceMktSearch",k);i.register("addBotToServer",E);i.register("closeMarketplace",()=>{var t;return(t=document.getElementById("marketplace-modal"))==null?void 0:t.remove()});var f=document.createElement("style");f.textContent=`
  .filter-chip { background: var(--bg-3); border: 1px solid var(--bg-4); border-radius: 20px; padding: 5px 12px; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; transition: all .15s; white-space: nowrap; }
  .filter-chip:hover { border-color: var(--brand); color: var(--text-1); }
  .filter-chip.active { background: var(--brand); border-color: var(--brand); color: #fff; }
`;document.head.appendChild(f);export{E as addBotToServer,B as openBotMarketplace,S as openMarketplacePage,A as setMktCategory};
