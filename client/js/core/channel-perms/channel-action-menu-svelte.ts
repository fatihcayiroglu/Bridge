// client/js/core/channel-perms/channel-action-menu-svelte.ts
// FAZ C2 — Kanal eylem menüsünün mount köprüsü.
//
// `ChannelItem.svelte` üç nokta butonunu YALNIZCA `openChannelMenu` registry
// sahibi varsa render eder (ChannelListManager.svelte:85). Bu modül o sahibi
// kuran TEK yerdir; menü kendini `onMount` içinde kaydeder.
//
// Menü `document.body`ye mount edilir çünkü konumu `position: fixed` ile
// tıklama noktasına göre belirlenir; kanal listesi DOM'una girerse taşma
// (overflow) tarafından kırpılır.
//
// Tek örnek garantisi: ikinci mount ÇAĞRILMAZ (registry ikinci bir sahibi
// zaten reddederdi ve iki menü iki farklı bağlam yakalayabilirdi).

import { mount, unmount } from 'svelte';
import ChannelActionMenu from './ChannelActionMenu.svelte';
import { createLogger } from '../logger.ts';

const log = createLogger('ChannelActionMenuShim');

let _instance: ReturnType<typeof mount> | null = null;
let _host: HTMLElement | null = null;

export function mountChannelActionMenu(): void {
  if (_instance) return;

  _host = document.createElement('div');
  _host.id = 'channel-action-menu-root';
  document.body.appendChild(_host);

  _instance = mount(ChannelActionMenu, { target: _host });
  log.info('Kanal eylem menüsü mount edildi');
}

export function unmountChannelActionMenu(): void {
  if (_instance) {
    void unmount(_instance);
    _instance = null;
  }
  _host?.remove();
  _host = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountChannelActionMenu, { once: true });
} else {
  mountChannelActionMenu();
}
