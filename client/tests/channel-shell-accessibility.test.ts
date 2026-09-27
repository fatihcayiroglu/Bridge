import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ChannelItem from '../js/core/channel-list/ChannelItem.svelte';
import ChannelList from '../js/core/channel-list/ChannelList.svelte';

afterEach(cleanup);

describe('Phase 9 channel shell interactions', () => {
  it('keeps static shell IDs unique and leaves screen-share ownership to VoicePanel', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    for (const id of ['app', 'server-list', 'channel-list', 'messages-area', 'msg-input', 'voice-view', 'member-list']) {
      expect(ids.filter(candidate => candidate === id)).toHaveLength(1);
    }
    for (const id of ['screen-share-view', 'remote-screen-video', 'ss-quality-modal', 'ss-mute-btn', 'ss-deafen-btn']) {
      expect(html).not.toContain(`id="${id}"`);
    }
    expect(html).not.toContain('data-bridge-action="toggleSearch"');
  });

  it('activates a channel with Space and exposes selected state semantically', async () => {
    const onSelect = vi.fn();
    const channel = { _id: 'general', name: 'general', type: 'text' };
    const { container } = render(ChannelItem, {
      props: { channel, active: true, onSelect, onOpenMenu: vi.fn() },
    });

    // Kanal acma artik GERCEK bir `<button>`; Enter/Space'i tarayici natif
    // olarak `click`e cevirir ve jsdom keydown'dan click uretmez. Sarmalayici
    // satir ARTIK etkilesimli DEGIL — ic ice kontrol yok.
    const item = container.querySelector<HTMLElement>('.ch-item')!;
    const open = container.querySelector<HTMLButtonElement>('.ch-open')!;
    expect(item.getAttribute('role')).toBeNull();
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('aria-current')).toBe('page');
    expect(item.querySelector('.ch-icon svg')).toBeTruthy();
    expect(item.querySelector('.ch-icon')?.textContent?.trim()).toBe('');

    await fireEvent.click(open);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(channel);
  });

  it('does not select a channel when its action menu is keyboard-operated', async () => {
    const onSelect = vi.fn();
    const onOpenMenu = vi.fn();
    const { container } = render(ChannelItem, {
      props: {
        channel: { _id: 'general', name: 'general', type: 'text' },
        onSelect,
        onOpenMenu,
      },
    });

    const menu = container.querySelector<HTMLButtonElement>('.ch-settings-btn')!;
    await fireEvent.keyDown(menu, { key: 'Enter' });
    await fireEvent.click(menu);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenMenu).toHaveBeenCalledOnce();
  });

  it('does not present channel actions whose registry owners are unavailable', () => {
    const channel = { _id: 'general', name: 'general', type: 'text', category: 'Community' };
    const item = render(ChannelItem, { props: { channel, onSelect: vi.fn() } });
    expect(item.container.querySelector('.ch-settings-btn')).toBeNull();
    item.unmount();

    const list = render(ChannelList, {
      props: {
        channels: [channel],
        onSelect: vi.fn(),
        onToggleCategory: vi.fn(),
      },
    });
    expect(list.container.querySelector('.ch-add-btn')).toBeNull();
  });

  // Kategori acma/kapama artik GERCEK bir `<button>`tir. Enter ve Space'i
  // tarayici natif olarak `click`e cevirir; elle `keydown` dinlemek gerekmez
  // ve jsdom da keydown'dan click uretmez. Test bu yuzden natif etkinlestirmeyi
  // olcer, ayrica dugmenin GERCEKTEN bir button oldugunu dogrular — boylece
  // `nested-interactive` kusuru geri gelemez.
  it.each(['Enter', ' '])('toggles a category with %s (native button activation)', async (key) => {
    const onToggleCategory = vi.fn();
    const { container } = render(ChannelList, {
      props: {
        channels: [{ _id: 'general', name: 'general', type: 'text', category: 'Community' }],
        activeChannelId: null,
        onSelect: vi.fn(),
        onOpenMenu: vi.fn(),
        onToggleCategory,
      },
    });

    const toggle = container.querySelector<HTMLButtonElement>('.cat-toggle')!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Sarmalayici ARTIK etkilesimli DEGIL — ic ice kontrol yok.
    expect(container.querySelector('.ch-category')!.getAttribute('role')).toBeNull();
    void key;                       // her iki tus da natif olarak click uretir
    await fireEvent.click(toggle);
    expect(onToggleCategory).toHaveBeenCalledWith('Community');
  });

  it('does not collapse a category when its add control is keyboard-operated', async () => {
    const onToggleCategory = vi.fn();
    const onCreateChannel = vi.fn();
    const { container } = render(ChannelList, {
      props: {
        channels: [{ _id: 'general', name: 'general', type: 'text', category: 'Community' }],
        onSelect: vi.fn(),
        onOpenMenu: vi.fn(),
        onToggleCategory,
        onCreateChannel,
      },
    });

    const add = container.querySelector<HTMLButtonElement>('.ch-add-btn')!;
    await fireEvent.keyDown(add, { key: ' ' });
    await fireEvent.click(add);

    expect(onToggleCategory).not.toHaveBeenCalled();
    expect(onCreateChannel).toHaveBeenCalledOnce();
  });
});
