// client/js/core/calendar-picker-svelte.ts
// Sprint 116 — CalendarPicker mount shim (ADR-0008 Faz 3)
// Tarih seçici takvim bileşeni
import { mount } from 'svelte';
import CalendarPicker from './CalendarPicker.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('CalendarPickerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountCalendarPicker(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('calendar-picker-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'calendar-picker-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(CalendarPicker, { target: el, props: {} });
  log.info('CalendarPicker mounted via shim');
}

export function unmountCalendarPicker(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountCalendarPicker(), { once: true });
} else {
  mountCalendarPicker();
}
document.addEventListener('bridge:socket-ready', () => mountCalendarPicker(), { once: true });
