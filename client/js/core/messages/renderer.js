// core/messages/renderer.js
// Mesaj DOM render + edit geçmişi popup

import { getAPI, getMe, getCurrentChannel }     from '../globals.js';
import { escHtml }                              from '../utils.js';
import { renderReactionsHtml }                  from './reactions.js';
import { renderEmbed }                          from './embeds.js';
import { formatText }                           from './input.js';

function renderMessage(msg, isContinuation = false) {
  const area = _getMsgArea();
  if (!area) return;
  if (document.getElementById(`msg-${msg._id}`)) return;

  // Engellenen kullanıcıdan gelen mesajları gizle
  if (window._blockedUserIds?.has(msg.userId)) return;

  if (currentChannel?._id && window.bridgeOfflineCache) {
    window.bridgeOfflineCache.upsertMessage(currentChannel._id, msg).catch(() => {});
  }
  if (msg.type === 'file' && msg.fileUrl && !msg.fileData) msg = { ...msg, fileData: `${API}${msg.fileUrl}` };
  const el = document.createElement('div'); el.id = `msg-${msg._id}`;
  _populateMsgEl(el, msg, isContinuation);
  area.appendChild(el);
}

function _populateMsgEl(el, msg, isContinuation) {
  const d = new Date(msg.createdAt);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fullDate = d.toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  // editedAt varsa (edited) badge — tıklayınca showEditHistory açar
  const editedBadge = msg.editedAt
    ? `<span class="msg-edited" style="cursor:pointer;" title="Düzenleme geçmişini gör" onclick="showEditHistory('${msg._id}', event)">(edited)</span>`
    : '';
  const isOwn = msg.userId === me?.id;
  const pinnedBadge    = msg.pinned      ? `<span class="pin-badge" title="Pinned">📌</span>` : '';
  const scheduledBadge = msg.scheduledId ? `<span class="scheduled-badge" title="Scheduled message">🕐</span>` : '';
  const bridgedBadge   = msg.bridgedFrom ? `<span class="bridged-badge" title="Forwarded from another channel">🌉</span>` : '';

  const replyHtml = msg.replyTo
    ? `<div class="reply-quote" onclick="scrollToMsg('${msg.replyTo._id}')"><span class="reply-bar"></span><span class="reply-name">${escHtml(msg.replyTo.displayName)}</span><span class="reply-preview">${escHtml((msg.replyTo.content || '').slice(0, 80))}</span></div>`
    : '';

  let bodyHtml = '';
  if (msg.type === 'file') {
    const isImage = msg.fileType && msg.fileType.startsWith('image/');
    const isVideo = msg.fileType && msg.fileType.startsWith('video/');
    const isAudio = msg.fileType && msg.fileType.startsWith('audio/');
    if (isImage) {
      bodyHtml = `<div class="file-attach"><img class="msg-image" src="${safeFileUrl(msg.fileData)}" alt="${escHtml(msg.fileName)}" onclick="openImageViewer('${msg._id}')"></div>`;
    } else if (isVideo) {
      bodyHtml = `<div class="file-attach"><video class="msg-video" src="${safeFileUrl(msg.fileData)}" controls preload="metadata"></video><div class="file-name-row">🎬 ${escHtml(msg.fileName)}</div></div>`;
    } else if (isAudio) {
      bodyHtml = `<div class="file-attach"><audio class="msg-audio" src="${safeFileUrl(msg.fileData)}" controls></audio><div class="file-name-row">🎵 ${escHtml(msg.fileName)}</div></div>`;
    } else {
      bodyHtml = `<div class="file-attach"><a class="file-link" href="${safeFileUrl(msg.fileData)}" download="${escHtml(msg.fileName)}">📎 ${escHtml(msg.fileName)}</a></div>`;
    }
  } else if (msg.type === 'voice_message' && msg.fileUrl) {
    const transcriptHtml = msg.transcript
      ? `<div class="voice-transcript" id="vt-${msg._id}"><span class="vt-icon">📝</span><span class="vt-text">${escHtml(msg.transcript)}</span></div>`
      : `<div class="voice-transcript voice-transcript--pending" id="vt-${msg._id}"><span class="vt-icon">⏳</span><span class="vt-text" style="color:var(--text-3);font-style:italic">Transkripsiyon hazırlanıyor...</span></div>`;
    bodyHtml = `<div class="voice-msg-player">
      <span style="font-size:18px">🎤</span>
      <audio class="msg-audio" controls src="${API}${escHtml(msg.fileUrl)}" style="flex:1;max-width:260px;height:32px"></audio>
      <span style="font-size:11px;color:var(--text-3)">Sesli Mesaj</span>
    </div>${transcriptHtml}`;
  } else if (msg.content && /^https?:\/\/media\.tenor\.com\/[^\s]+\.gif(\?[^\s]*)?$/i.test(msg.content.trim())) {
    bodyHtml = `<div class="msg-gif"><img src="${escHtml(msg.content.trim())}" class="msg-gif-img" alt="GIF" loading="lazy"></div>`;
  } else if (msg.content && /^https?:\/\/[^\s]+\.(gif|webp)(\?[^\s]*)?$/i.test(msg.content.trim()) && msg.content.startsWith(`${API}/uploads/`)) {
    bodyHtml = `<div class="msg-gif"><img src="${escHtml(msg.content.trim())}" class="msg-gif-img" alt="Server GIF" loading="lazy"></div>`;
  } else {
    bodyHtml = `<div class="msg-text" id="msgtext-${msg._id}">${formatText(msg.content)}${editedBadge}</div>`;
  }

  let parsedEmbeds = msg.embeds;
  if (typeof parsedEmbeds === 'string') {
    try { parsedEmbeds = JSON.parse(parsedEmbeds); } catch { parsedEmbeds = []; }
  }
  if (parsedEmbeds && Array.isArray(parsedEmbeds) && parsedEmbeds.length) {
    bodyHtml += `<div class="msg-embeds">${parsedEmbeds.map(e => renderEmbed(e)).join('')}</div>`;
  }
  if (msg.components && Array.isArray(msg.components) && msg.components.length) {
    bodyHtml += renderComponents(msg.components, msg._id);
  }

  const translateBtn   = `<button class="msg-action-btn translate-btn" title="Çevir 🌐" onclick="translateMessage('${msg._id}')">🌐</button>`;
  const scheduleVisible = msg.scheduledId ? scheduledBadge : '';
  const threadBadge = msg.threadId
    ? `<div class="thread-badge" id="thread-badge-${msg.channelId||currentChannel._id}-${msg.threadId}" data-count="${msg.threadCount||0}" onclick="openThread('${msg._id}','${escHtml((msg.content||'').slice(0,50))}')">🧵 ${msg.threadCount||0} yanıt</div>`
    : `<div class="thread-badge-new" onclick="openThread('${msg._id}','${escHtml((msg.content||'').slice(0,50))}')"></div>`;

  const ctxMsgCmds = (window._contextCommands || []).filter(c => c.type === 'MESSAGE_COMMAND');
  const ctxCmdBtns = ctxMsgCmds.map(c =>
    `<button class="msg-action-btn" title="${escHtml(c.name)}" onclick="_triggerContextCommand('message_command','${escHtml(c.name)}',null,'${msg._id}')">🤖</button>`
  ).join('');

  const actions = (msg.type !== 'system')
    ? `<div class="msg-actions">
        <button class="msg-action-btn" title="Reaksiyon Ekle" onclick="quickReact('${msg._id}')">😊</button>
        <button class="msg-action-btn" title="Reply" onclick="startReply('${msg._id}', '${escHtml(msg.displayName || msg.username)}')">↩️</button>
        <button class="msg-action-btn" title="Thread aç" onclick="openThread('${msg._id}','${escHtml((msg.content||'').slice(0,50))}')">🧵</button>
        ${isOwn && msg.type !== 'file' ? `<button class="msg-action-btn" title="Edit" onclick="startEditMessage('${msg._id}', this)">✏️</button>` : ''}
        ${isOwn ? `<button class="msg-action-btn delete" title="Delete" onclick="showDeleteMessageModal('${msg._id}', '${msg.channelId || currentChannel._id}')">🗑️</button>` : ''}
        <button class="msg-action-btn" title="${msg.pinned ? 'Unpin' : 'Pin'}" onclick="pinMessage('${msg._id}', '${msg.channelId || currentChannel._id}')">📌</button>
        ${translateBtn}
        ${ctxCmdBtns}
       </div>
       ${msg.threadCount > 0 ? threadBadge : ''}`
    : '';

  const reactionsHtml = renderReactionsHtml(msg._id, msg.reactions || {});

  if (isContinuation && msg.type !== 'system') {
    el.className = 'msg-continue';
    el.innerHTML = `${replyHtml}${bodyHtml}${actions}${reactionsHtml}`;
  } else if (msg.type === 'system') {
    el.className = 'sys-msg';
    el.innerHTML = `<span class="sys-icon">🌉</span><span>${formatText(msg.content || '')}</span>`;
  } else {
    el.className = `msg-group${msg.pinned ? ' pinned-msg' : ''}`;
    const avatarEl = msg.avatarUrl
      ? `<img src="${API}${escHtml(msg.avatarUrl)}" class="msg-avatar msg-avatar-img" onclick="openProfileModal('${escHtml(msg.userId)}')" alt="" loading="lazy">`
      : `<div class="msg-avatar" style="background:${cssColor(msg.avatarColor)};cursor:pointer" onclick="openProfileModal('${escHtml(msg.userId)}')">${initials(msg.displayName || msg.username)}</div>`;
    el.innerHTML = `
      ${avatarEl}
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-author" data-uid="${escHtml(msg.userId)}" style="color:${cssColor(msg.avatarColor)};cursor:pointer" onclick="openProfileModal('${escHtml(msg.userId)}')">${escHtml(msg.displayName || msg.username)}</span>
          <span class="msg-time tooltip" data-tip="${escHtml(fullDate)}">${time}</span>
          ${pinnedBadge}${scheduleVisible}${bridgedBadge}
        </div>
        ${replyHtml}${bodyHtml}${actions}${reactionsHtml}
      </div>`;
  }
}

// ══════════════════════════════════════════════════
// EDIT HISTORY POPUP
// ══════════════════════════════════════════════════
async function showEditHistory(msgId, event) {
  document.getElementById('edit-history-popup')?.remove();
  event?.stopPropagation();

  const popup = document.createElement('div');
  popup.id = 'edit-history-popup';
  popup.style.cssText = `
    position:fixed;z-index:2000;background:var(--bg-secondary);border:1px solid var(--border);
    border-radius:10px;padding:12px 14px;max-width:400px;min-width:260px;
    box-shadow:0 8px 32px rgba(0,0,0,0.35);font-size:13px;
    max-height:320px;overflow-y:auto;
  `;
  popup.innerHTML = '<div style="font-weight:700;margin-bottom:10px;color:var(--text-muted);font-size:11px;letter-spacing:0.08em;">📝 DÜZENLEME GEÇMİŞİ</div><div id="edit-history-list">Yükleniyor...</div>';

  const rect = event?.target?.getBoundingClientRect();
  if (rect) {
    const top = Math.min(rect.bottom + 6, window.innerHeight - 340);
    popup.style.top  = top + 'px';
    popup.style.left = Math.min(rect.left, window.innerWidth - 420) + 'px';
  } else {
    popup.style.top  = '50%'; popup.style.left = '50%';
    popup.style.transform = 'translate(-50%,-50%)';
  }

  document.body.appendChild(popup);

  setTimeout(() => {
    document.addEventListener('click', function h(e) {
      if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', h); }
    });
  }, 50);

  try {
    const r = await apiFetch(`${API}/api/messages/${msgId}/history`);
    const data = await r.json();
    const list = document.getElementById('edit-history-list');
    if (!list) return;
    const history = data.editHistory || [];
    if (!history.length) { list.innerHTML = '<div style="color:var(--text-muted);">Geçmiş yok (ilk düzenleme)</div>'; return; }
    list.innerHTML = '';
    const reversed = [...history].reverse();
    reversed.forEach((entry, i) => {
      const d = new Date(entry.editedAt || entry.createdAt);
      const timeStr = d.toLocaleString([], { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const div = document.createElement('div');
      div.style.cssText = `border-bottom:1px solid var(--border);padding:6px 0;${i === 0 ? 'opacity:0.6;' : ''}`;
      div.innerHTML = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:3px;">${timeStr}${i === 0 ? ' · En eski' : ''}</div><div style="color:var(--text-primary);word-break:break-word;">${escHtml(entry.content)}</div>`;
      list.appendChild(div);
    });
  } catch {
    const list = document.getElementById('edit-history-list');
    if (list) list.innerHTML = '<div style="color:var(--text-muted);">Geçmiş yüklenemedi</div>';
  }
}

export {
  renderMessage,
  showEditHistory,
};

