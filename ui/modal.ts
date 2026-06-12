// client/js/core/ui/modal.ts
'use strict';

import { BridgeUIButton } from './button.js';

export const BridgeUIModal = {
  confirm({ title = 'Emin misiniz?', description = '', confirmLabel = 'Onayla', cancelLabel = 'İptal', danger = false, onConfirm, onCancel } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dui-confirm-overlay';

    overlay.innerHTML = `
      <div class="dui-confirm-card modal-card" style="max-width:440px;width:95%;">
        <div class="dui-confirm-header">
          <h2 class="dui-confirm-title">${title}</h2>
        </div>
        ${description ? `<p class="dui-confirm-desc">${description}</p>` : ''}
        <div class="dui-confirm-actions"></div>
      </div>`;

    const actions = overlay.querySelector('.dui-confirm-actions');

    const cancelBtn = BridgeUIButton.create({
      label: cancelLabel, style: 'secondary',
      onClick: () => { overlay.remove(); onCancel?.(); },
    });
    const confirmBtn = BridgeUIButton.create({
      label: confirmLabel, style: danger ? 'danger' : 'primary',
      onClick: () => { overlay.remove(); onConfirm?.(); },
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); onCancel?.(); } });
    document.body.appendChild(overlay);

    confirmBtn.focus();
    return overlay;
  },
};
