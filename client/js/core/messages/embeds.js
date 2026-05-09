// core/messages/embeds.js
// Embed kartları + bot component render (buttons, select)

import { getAPI, getCurrentChannel, getMe } from '../globals.js';
import { apiFetch }                          from '../api-fetch.js';
import { escHtml }                           from '../utils.js';
import { formatText }                        from './input.js';

function renderEmbed(embed) {
  if (embed.type === 'link') {
    const imageHtml = embed.image
      ? `<img src="${escHtml(embed.image)}" alt="preview" loading="lazy" style="max-width:400px;max-height:220px;border-radius:4px;margin-top:8px;display:block;">`
      : '';
    return `<div class="message-embed" style="border-left-color:var(--brand);padding:10px 14px;background:var(--bg-2);border-radius:0 6px 6px 0;margin-top:4px;max-width:480px">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${escHtml(embed.siteName || '')}</div>
      <div style="font-weight:600;font-size:14px"><a href="${escHtml(embed.url)}" target="_blank" rel="noopener" style="color:var(--link);text-decoration:none">${escHtml(embed.title)}</a></div>
      ${embed.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escHtml(embed.description)}</div>` : ''}
      ${imageHtml}
    </div>`;
  }

  const color      = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : 'var(--brand)';
  const authorHtml = embed.author
    ? `<div class="embed-author">${embed.author.icon_url ? `<img src="${escHtml(embed.author.icon_url)}" width="16" height="16" style="border-radius:50%">` : ''} ${escHtml(embed.author.name || '')}</div>`
    : '';
  const titleHtml  = embed.title
    ? `<div class="embed-title">${embed.url ? `<a href="${escHtml(embed.url)}" target="_blank" rel="noopener">${escHtml(embed.title)}</a>` : escHtml(embed.title)}</div>`
    : '';
  const descHtml   = embed.description ? `<div class="embed-desc">${formatText(embed.description)}</div>` : '';
  const thumbHtml  = embed.thumbnail?.url
    ? `<div class="embed-thumbnail"><img src="${escHtml(embed.thumbnail.url)}" alt="thumbnail" loading="lazy"></div>` : '';
  const fieldsHtml = (embed.fields || []).length
    ? `<div class="embed-fields">${embed.fields.map(f =>
        `<div class="embed-field${f.inline ? ' inline' : ''}">
          <div class="embed-field-name">${escHtml(f.name)}</div>
          <div class="embed-field-value">${formatText(f.value)}</div>
        </div>`).join('')}</div>` : '';
  const imageHtml  = embed.image?.url
    ? `<div class="embed-image"><img src="${escHtml(embed.image.url)}" alt="embed image" loading="lazy"></div>` : '';
  const footerHtml = embed.footer?.text
    ? `<div class="embed-footer">${escHtml(embed.footer.text)}${embed.timestamp ? ` · ${new Date(embed.timestamp).toLocaleString('tr-TR')}` : ''}</div>` : '';

  return `<div class="message-embed" style="border-left-color:${color}">
    ${thumbHtml}${authorHtml}${titleHtml}${descHtml}${fieldsHtml}${imageHtml}${footerHtml}
  </div>`;
}

function renderComponents(components, messageId) {
  let html = '<div class="msg-components">';
  for (const row of components) {
    if (row.type !== 1 || !row.components) continue;
    html += '<div class="component-row">';
    for (const comp of row.components) {
      if (comp.type === 2) {
        const styleMap = { 1: 'btn-brand', 2: 'btn-secondary', 3: 'btn-success', 4: 'btn-danger', 5: 'btn-link' };
        const cls = styleMap[comp.style] || 'btn-secondary';
        if (comp.style === 5) {
          html += `<a class="component-btn ${cls}" href="${escHtml(comp.url||'#')}" target="_blank" rel="noopener">${comp.emoji ? comp.emoji.name + ' ' : ''}${escHtml(comp.label||'')}</a>`;
        } else {
          html += `<button class="component-btn ${cls}" ${comp.disabled ? 'disabled' : ''} onclick="handleComponentClick('${messageId}','${escHtml(comp.custom_id||'')}',event)">${comp.emoji ? comp.emoji.name + ' ' : ''}${escHtml(comp.label||'')}</button>`;
        }
      } else if (comp.type === 3) {
        html += `<select class="component-select" onchange="handleSelectComponent('${messageId}','${escHtml(comp.custom_id||'')}',this)">
          <option value="" disabled selected>${escHtml(comp.placeholder||'Seç...')}</option>
          ${(comp.options||[]).map(o => `<option value="${escHtml(o.value)}">${o.emoji ? o.emoji.name + ' ' : ''}${escHtml(o.label)}</option>`).join('')}
        </select>`;
      }
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function handleComponentClick(messageId, customId, e) {
  e.target.disabled = true; e.target.style.opacity = '0.6';
  try {
    await apiFetch(`${API}/api/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'button', messageId, customId, channelId: currentChannel?._id }),
    });
  } catch {}
  setTimeout(() => { if (e.target) { e.target.disabled = false; e.target.style.opacity = ''; } }, 1500);
}

async function handleSelectComponent(messageId, customId, selectEl) {
  const value = selectEl.value; if (!value) return;
  await apiFetch(`${API}/api/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'select', messageId, customId, value, channelId: currentChannel?._id }),
  });
}

export {
  handleComponentClick,
  handleSelectComponent,
  renderComponents,
  renderEmbed,
};

