// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/CalendarPickerPanel.svelte
//              client/js/core/calendar-picker-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/calendar-picker.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Mesaj Zamanlama görsel takvim picker

import { BridgeRegistry } from './bridge-registry.js';

const MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const DAYS   = ['Pz','Pt','Sa','Ça','Pe','Cu','Ct'];

export function openCalendarPicker(targetInputId: string): void {
  const existingPicker = document.getElementById('calendar-picker-popup');
  if (existingPicker) { existingPicker.remove(); return; }

  const input = document.getElementById(targetInputId) as HTMLInputElement | null;
  const now   = new Date(input?.value ? new Date(input.value) : Date.now() + 3_600_000);

  const picker = document.createElement('div');
  picker.id = 'calendar-picker-popup';
  picker.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;
    padding:20px;z-index:2000;box-shadow:0 8px 32px rgba(0,0,0,.5);
    width:320px;user-select:none;`;

  let viewYear  = now.getFullYear();
  let viewMonth = now.getMonth();
  let selDay    = now.getDate();
  let selHour   = now.getHours();
  let selMin    = now.getMinutes();

  function render(): void {
    const first = new Date(viewYear, viewMonth, 1).getDay();
    const total = new Date(viewYear, viewMonth + 1, 0).getDate();
    const today = new Date();

    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div></div>';
    for (let d = 1; d <= total; d++) {
      const isToday = d === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
      const isSel   = d === selDay;
      const isPast  = new Date(viewYear, viewMonth, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
      cells += `<div class="cal-day${isSel ? ' cal-sel' : ''}${isToday ? ' cal-today' : ''}${isPast ? ' cal-past' : ''}"
        onclick="${isPast ? '' : `BridgeRegistry.call('calPickDay',${d})`}" style="${isPast ? 'opacity:.3;cursor:default' : 'cursor:pointer'}">${d}</div>`;
    }

    picker.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <button class="cal-nav-btn" onclick="BridgeRegistry.call('calPickNav',-1)">‹</button>
        <strong>${MONTHS[viewMonth]} ${viewYear}</strong>
        <button class="cal-nav-btn" onclick="BridgeRegistry.call('calPickNav',1)">›</button>
      </div>
      <div class="cal-grid-header">${DAYS.map(d => `<div>${d}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div style="margin-top:14px;display:flex;align-items:center;gap:10px;justify-content:center;">
        <label style="font-size:13px;">🕐 Saat:</label>
        <input type="number" id="cal-hour" min="0" max="23" value="${String(selHour).padStart(2,'0')}"
          style="width:52px;text-align:center;" class="input-field" oninput="BridgeRegistry.call('calPickTime')">
        <span>:</span>
        <input type="number" id="cal-min" min="0" max="59" value="${String(selMin).padStart(2,'0')}"
          style="width:52px;text-align:center;" class="input-field" oninput="BridgeRegistry.call('calPickTime')">
      </div>
      <div id="cal-preview" style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:8px;"></div>
      <div style="display:flex;gap:8px;margin-top:14px;justify-content:center;">
        <button class="btn btn-primary" onclick="BridgeRegistry.call('calPickConfirm','${targetInputId}')">✓ Seç</button>
        <button class="btn" onclick="document.getElementById('calendar-picker-popup').remove()">İptal</button>
      </div>`;
    updateCalPreview();
  }

  function updateCalPreview(): void {
    const el = picker.querySelector('#cal-preview');
    if (!el) return;
    el.textContent = new Date(viewYear, viewMonth, selDay, selHour, selMin)
      .toLocaleString('tr-TR', { dateStyle: 'long', timeStyle: 'short' });
  }

  const pad = (n: number): string => String(n).padStart(2, '0');

  BridgeRegistry.register('calPickNav', (dir: number) => {
    viewMonth += dir;
    if (viewMonth < 0)  { viewMonth = 11; viewYear--; }
    if (viewMonth > 11) { viewMonth = 0;  viewYear++; }
    render();
  });

  BridgeRegistry.register('calPickDay', (d: number) => { selDay = d; render(); });

  BridgeRegistry.register('calPickTime', () => {
    selHour = parseInt((picker.querySelector('#cal-hour') as HTMLInputElement)?.value) || 0;
    selMin  = parseInt((picker.querySelector('#cal-min')  as HTMLInputElement)?.value) || 0;
    updateCalPreview();
  });

  BridgeRegistry.register('calPickConfirm', (inputId: string) => {
    const target = document.getElementById(inputId) as HTMLInputElement | null;
    if (target) target.value = `${viewYear}-${pad(viewMonth + 1)}-${pad(selDay)}T${pad(selHour)}:${pad(selMin)}`;
    picker.remove();
  });

  document.body.appendChild(picker);
  render();

  setTimeout(() => {
    const handler = (e: MouseEvent) => {
      if (!picker.contains(e.target as Node) && !(e.target as HTMLElement).closest('[onclick*="calPickConfirm"]')) {
        picker.remove();
        document.removeEventListener('click', handler);
      }
    };
    document.addEventListener('click', handler);
  }, 100);
}

// ── Schedule modal enhancement ────────────────────────────────

const _origOpenScheduleModal = BridgeRegistry.get('openScheduleModal') as ((...args: unknown[]) => void) | undefined;
BridgeRegistry.register('openScheduleModal', function (...args: unknown[]) {
  _origOpenScheduleModal?.(...args);
  setTimeout(() => {
    const dt = document.getElementById('schedule-datetime') as HTMLInputElement | null;
    if (dt && !dt.dataset.calEnhanced) {
      dt.dataset.calEnhanced = '1';
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;gap:8px;align-items:center;';
      dt.parentNode?.insertBefore(wrapper, dt);
      wrapper.appendChild(dt);
      dt.style.flex = '1';
      const calBtn = document.createElement('button');
      calBtn.className = 'btn';
      calBtn.style.cssText = 'white-space:nowrap;font-size:12px;padding:7px 12px;';
      calBtn.textContent = '📅 Takvim';
      calBtn.onclick = (e) => { e.preventDefault(); openCalendarPicker('schedule-datetime'); };
      wrapper.appendChild(calBtn);
    }
  }, 50);
});
