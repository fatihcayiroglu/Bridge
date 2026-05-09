// core/messages/reactions.js

import { getMe, getCurrentChannel, getSocket } from '../globals.js';

function renderReactionsHtml(msgId, reactions) {
  const entries = Object.entries(reactions);
  if (!entries.length) return `<div class="msg-reactions" id="reactions-${msgId}"><button class="add-reaction-btn" onclick="quickReact('${msgId}')">😊+</button></div>`;
  const pills = entries.map(([emoji, users]) => {
    const reacted = users.includes(me?.id);
    return `<button class="reaction-pill${reacted ? ' reacted' : ''}" onclick="reactToMessage('${msgId}', '${emoji}')" title="${users.length} reaction(s)">${emoji} ${users.length}</button>`;
  }).join('');
  return `<div class="msg-reactions" id="reactions-${msgId}">${pills}<button class="add-reaction-btn" onclick="quickReact('${msgId}')">😊+</button></div>`;
}

function reactToMessage(msgId, emoji) {
  if (!currentChannel) return;
  socket.emit('message:react', { messageId: msgId, channelId: currentChannel._id, emoji });
}

function quickReact(msgId) {
  const QUICK = ['👍','👎','❤️','😂','😮','😢','🎉','🔥'];
  document.getElementById('quick-react-picker')?.remove();
  const picker = document.createElement('div');
  picker.id = 'quick-react-picker'; picker.className = 'quick-react-picker';
  picker.innerHTML = QUICK.map(e => `<button onclick="reactToMessage('${msgId}', '${e}'); document.getElementById('quick-react-picker')?.remove()">${e}</button>`).join('');
  document.getElementById(`reactions-${msgId}`)?.appendChild(picker);
  setTimeout(() => picker.remove(), 5000);
}

export {
  quickReact,
  reactToMessage,
  renderReactionsHtml,
};

