// client/js/core/v43/themes.js
// ModÃ¼l: Yeni Temalar â€” Sunset (turuncu) + Forest (yeÅŸil)
'use strict';

const v43ThemeStyle = document.createElement('style');
v43ThemeStyle.textContent = `
  [data-theme="sunset"] {
    --bg-app:      #1a0f0a;
    --bg-1:        #1a0f0a;
    --bg-2:        #261510;
    --bg-3:        #321b14;
    --bg-4:        #3e221a;
    --bg-5:        #4a2920;
    --bg-hover:    rgba(255,140,80,0.07);
    --bg-active:   rgba(255,140,80,0.12);
    --bg-secondary: #261510;
    --bg-tertiary:  #321b14;

    --brand-h: 25;
    --brand-s: 85%;

    --text-primary:   #fde8d8;
    --text-secondary: #e8bfa0;
    --text-muted:     #a06040;
    --text-disabled:  #5a3020;
    --text:   var(--text-primary);
    --text-1: var(--text-primary);
    --text-2: var(--text-secondary);
    --text-3: var(--text-muted);
    --text-normal: var(--text-primary);
    --accent: var(--brand);

    --border:        rgba(255,140,80,0.10);
    --border-subtle: rgba(255,140,80,0.05);
    --border-strong: rgba(255,140,80,0.18);

    --shadow-sm: 0 1px 4px rgba(30,8,0,0.5);
    --shadow:    0 4px 16px rgba(30,8,0,0.7);
    --shadow-lg: 0 8px 32px rgba(30,8,0,0.8);

    --scrollbar-thumb: #4a2920;
    --scrollbar-hover: #a06040;

    --msg-bg:       transparent;
    --msg-bg-hover: rgba(255,140,80,0.04);
    --code-bg:      #1a0f0a;
    --code-border:  rgba(255,140,80,0.10);
  }

  [data-theme="forest"] {
    --bg-app:      #0a120a;
    --bg-1:        #0a120a;
    --bg-2:        #101a10;
    --bg-3:        #162216;
    --bg-4:        #1c2a1c;
    --bg-5:        #223222;
    --bg-hover:    rgba(80,180,80,0.07);
    --bg-active:   rgba(80,180,80,0.12);
    --bg-secondary: #101a10;
    --bg-tertiary:  #162216;

    --brand-h: 130;
    --brand-s: 60%;

    --text-primary:   #d8f0d0;
    --text-secondary: #9ec890;
    --text-muted:     #507050;
    --text-disabled:  #304030;
    --text:   var(--text-primary);
    --text-1: var(--text-primary);
    --text-2: var(--text-secondary);
    --text-3: var(--text-muted);
    --text-normal: var(--text-primary);
    --accent: var(--brand);

    --border:        rgba(80,180,80,0.10);
    --border-subtle: rgba(80,180,80,0.05);
    --border-strong: rgba(80,180,80,0.18);

    --shadow-sm: 0 1px 4px rgba(0,15,0,0.5);
    --shadow:    0 4px 16px rgba(0,15,0,0.7);
    --shadow-lg: 0 8px 32px rgba(0,15,0,0.8);

    --scrollbar-thumb: #223222;
    --scrollbar-hover: #507050;

    --msg-bg:       transparent;
    --msg-bg-hover: rgba(80,180,80,0.03);
    --code-bg:      #0a120a;
    --code-border:  rgba(80,180,80,0.10);
  }

  /* Skeleton loading animasyonu */
  .skeleton-msg, .skeleton-continue {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 6px 16px;
    animation: skeleton-pulse 1.4s ease-in-out infinite;
  }
  .skeleton-continue { padding-left: 60px; }
  .skeleton-avatar {
    width: 36px; height: 36px; border-radius: 50%;
    background: var(--bg-5); flex-shrink: 0;
  }
  .skeleton-avatar-placeholder { width: 36px; flex-shrink: 0; }
  .skeleton-body { flex: 1; display: flex; flex-direction: column; gap: 6px; padding-top: 2px; }
  .skeleton-line {
    height: 14px; border-radius: 7px; background: var(--bg-5);
  }
  .skeleton-name { height: 12px; margin-bottom: 2px; }
  @keyframes skeleton-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.45; }
  }

  /* Arama highlight */
  mark.search-highlight {
    background: hsl(var(--brand-h), var(--brand-s), 55%, 0.35);
    color: var(--text-primary);
    border-radius: 2px;
    padding: 0 1px;
  }

  /* Virtual scroll load trigger */
  .vs-load-trigger {
    transition: background 0.15s;
  }
  .vs-load-trigger:hover {
    background: var(--bg-hover);
    color: var(--brand);
  }
`;
document.head.appendChild(v43ThemeStyle);

// Sunset & Forest artÄ±k theme.js + settings-modal.html'de doÄŸrudan tanÄ±mlÄ±.
// Bu blok gereksiz hale geldi â€” silindi, Ã§akÄ±ÅŸma Ã¶nlendi.

