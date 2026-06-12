// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MentionAutocompletePanel.svelte
//              client/js/core/mention-autocomplete-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/mention-autocomplete.ts
// @mention otomatik tamamlama
// Sprint 49: .js → .ts (tam TypeScript geçişi)

import { BridgeRegistry } from './bridge-registry.js';
import { escHtml } from './utils.js';

interface Member {
  _id:         string;
  displayName: string;
  username?:   string;
  avatarColor?: string;
}

let mentionStart            = -1;
let mentionDropdownActive   = false;

function initials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function handleMentionAutocomplete(textarea: HTMLTextAreaElement): void {
  const val        = textarea.value;
  const pos        = textarea.selectionStart ?? 0;
  const textBefore = val.slice(0, pos);
  const match      = textBefore.match(/@([a-zA-Z0-9_]*)$/);

  document.getElementById('mention-dropdown')?.remove();

  if (!match) { mentionDropdownActive = false; mentionStart = -1; return; }

  const query = match[1].toLowerCase();
  mentionStart = pos - match[0].length;

  const currentServerMembers = BridgeRegistry.get('currentServerMembers') as Member[] | null;
  if (!currentServerMembers) return;

  const filtered = currentServerMembers
    .filter(m =>
      m.displayName.toLowerCase().includes(query) ||
      (m.username ?? '').toLowerCase().includes(query)
    )
    .slice(0, 8);

  if (!filtered.length) return;

  mentionDropdownActive = true;
  const dropdown = document.createElement('div');
  dropdown.id        = 'mention-dropdown';
  dropdown.className = 'mention-dropdown';

  filtered.forEach((member, i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === 0 ? ' active' : '');
    item.innerHTML = `
      <div class="mention-av" style="background:${member.avatarColor ?? '#2d9cdb'}">${initials(member.displayName)}</div>
      <div>
        <div class="mention-name">${escHtml(member.displayName)}</div>
        <div class="mention-tag">@${escHtml(member.username ?? '')}</div>
      </div>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); insertMention(member, textarea); });
    dropdown.appendChild(item);
  });

  const rect         = textarea.getBoundingClientRect();
  dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  dropdown.style.left   = `${rect.left}px`;
  document.body.appendChild(dropdown);
}

export function insertMention(member: Member, textarea: HTMLTextAreaElement): void {
  const val     = textarea.value;
  const before  = val.slice(0, mentionStart);
  const after   = val.slice(textarea.selectionStart ?? 0);
  const mention = `<@${member._id}> `;
  textarea.value = before + mention + after;
  const newPos   = before.length + mention.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();
  document.getElementById('mention-dropdown')?.remove();
  mentionDropdownActive = false;
}

export function handleMentionKey(e: KeyboardEvent, textarea: HTMLTextAreaElement): boolean {
  const dropdown = document.getElementById('mention-dropdown');
  if (!dropdown) return false;

  if (e.key === 'Escape') {
    dropdown.remove();
    mentionDropdownActive = false;
    return true;
  }

  const items     = dropdown.querySelectorAll<HTMLElement>('.mention-item');
  const activeIdx = [...items].findIndex(i => i.classList.contains('active'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[activeIdx]?.classList.remove('active');
    items[Math.min(activeIdx + 1, items.length - 1)]?.classList.add('active');
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[activeIdx]?.classList.remove('active');
    items[Math.max(activeIdx - 1, 0)]?.classList.add('active');
    return true;
  }
  if (e.key === 'Tab' || e.key === 'Enter') {
    const activeItem = dropdown.querySelector<HTMLElement>('.mention-item.active');
    if (activeItem) {
      e.preventDefault();
      activeItem.dispatchEvent(new MouseEvent('mousedown'));
      return true;
    }
  }
  return false;
}

export { mentionDropdownActive };
