import"/chunk-S7F673ZD.js";import"/chunk-IWFQIIHO.js";import{a as n}from"/chunk-6BHHOTS6.js";import"/chunk-BI7TSH2W.js";n.register("showServerPreview",function(e){var o;(o=document.getElementById("server-preview-modal"))==null||o.remove();let a=e.iconUrl?`<img src="${API+escHtml(e.iconUrl)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:4px solid var(--bg-3);">`:`<div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--brand),#1bc8a8);display:flex;align-items:center;justify-content:center;font-size:36px;border:4px solid var(--bg-3);">${escHtml(e.icon||"\u{1F310}")}</div>`,s=e.bannerUrl?`background:url(${API+escHtml(e.bannerUrl)}) center/cover;`:"background:linear-gradient(135deg,var(--brand) 0%,#1bc8a8 100%);",r=(e.tags||[]).map(i=>`<span class="discover-tag-pill">#${escHtml(i)}</span>`).join(""),t=document.createElement("div");t.id="server-preview-modal",t.className="modal-overlay",t.innerHTML=`
    <div class="modal-card" style="max-width:440px;width:95%;padding:0;overflow:hidden;">
      <div style="height:120px;${s}position:relative;">
        <button onclick="document.getElementById('server-preview-modal').remove()"
          style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,.5);border:none;width:28px;height:28px;border-radius:50%;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">\u2715</button>
      </div>
      <div style="padding:0 24px 24px;">
        <div style="margin-top:-36px;margin-bottom:12px;">${a}</div>
        <h2 style="font-size:22px;font-weight:800;margin:0 0 4px;">${escHtml(e.name)}</h2>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">
          \u011F\u0178\u2018\xA5 ${e.memberCount} \xFCye &nbsp;\xC2\xB7&nbsp; #\xEF\xB8\x8F\xE2\u0192\xA3 ${e.channelCount} kanal
        </div>
        ${e.description?`<p style="font-size:14px;color:var(--text-2);line-height:1.6;margin-bottom:12px;">${escHtml(e.description)}</p>`:""}
        ${r?`<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px;">${r}</div>`:""}
        <div style="display:flex;gap:8px;">
          <button onclick="joinFromDiscover('${escHtml(e._id)}');document.getElementById('server-preview-modal').remove();"
            style="flex:1;padding:11px;border:none;border-radius:var(--r-md);background:var(--brand);color:#fff;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;">
            Sunucuya Kat\u0131l \u2192
          </button>
          <button onclick="document.getElementById('server-preview-modal').remove()"
            style="padding:11px 16px;border:1px solid var(--border);border-radius:var(--r-md);background:transparent;color:var(--text-2);font-size:14px;font-family:inherit;cursor:pointer;">
            Kapat
          </button>
        </div>
      </div>
    </div>`,document.body.appendChild(t),t.onclick=i=>{i.target===t&&t.remove()}});
