// client/js/core/ui/action-row.ts
// Discord Mesaj Bileşenleri — Buton Satırı

'use strict';

import { BridgeUIButton } from './button.js';

export const BridgeUIActionRow = {
  create(buttons = []) {
    const row = document.createElement('div');
    row.className = 'dui-action-row';
    buttons.forEach(btnDef => row.appendChild(BridgeUIButton.create(btnDef)));
    return row;
  },
};
