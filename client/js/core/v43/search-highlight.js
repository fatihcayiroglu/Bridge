// client/js/core/v43/search-highlight.js
// Modül: Arama Highlight — arama sonuçlarında eşleşen kelime vurgulanır
'use strict';

const _origSearchMessages = window.searchMessages;
if (typeof window.searchMessages === 'function') {
  window.searchMessages = async function() {
    const q = document.getElementById('search-input')?.value?.trim();
    await _origSearchMessages.apply(this, arguments);
    if (!q) return;
    highlightSearchTerms(q);
  };
}

function highlightSearchTerms(query) {
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  document.querySelectorAll('.msg-text').forEach(el => {
    el.childNodes.forEach(node => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const text = node.textContent;
      if (!regex.test(text)) return;
      regex.lastIndex = 0;
      const span = document.createElement('span');
      span.innerHTML = text.replace(regex, '<mark class="search-highlight">$1</mark>');
      node.replaceWith(...span.childNodes);
    });
  });
}
