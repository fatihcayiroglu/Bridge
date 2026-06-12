// client/stories/DmPanel.stories.ts
// Sprint 116 — DmPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import DmPanel from '../js/core/DmPanel.svelte';

const meta = {
  title:     'Bridge/Panels/DmPanel',
  component: DmPanel,
  tags:      ['autodocs'],
  argTypes: {
    recipientId:       { control: 'text',    description: 'Karşı taraf kullanıcı ID' },
    recipientUsername: { control: 'text',    description: 'Karşı taraf kullanıcı adı' },
    isOnline:          { control: 'boolean', description: 'Karşı taraf çevrimiçi mi' },
    isE2EE:            { control: 'boolean', description: 'E2EE etkin mi' },
    hasUnread:         { control: 'boolean', description: 'Okunmamış mesaj var mı' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge direkt mesaj paneli — 1:1 sohbet, E2EE desteği, online/offline durumu, sesli arama başlatma.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<DmPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnlineUser: Story = {
  args: {
    recipientId:       'u-abc',
    recipientUsername: 'ahmet',
    isOnline:          true,
    isE2EE:            false,
    hasUnread:         false,
  },
  name: 'Çevrimiçi kullanıcı',
};

export const OfflineUser: Story = {
  args: {
    recipientId:       'u-xyz',
    recipientUsername: 'elif',
    isOnline:          false,
    isE2EE:            false,
    hasUnread:         true,
  },
  name: 'Çevrimdışı, okunmamış mesaj',
};

export const E2EEActive: Story = {
  args: {
    recipientId:       'u-sec',
    recipientUsername: 'güvenli_kullanıcı',
    isOnline:          true,
    isE2EE:            true,
    hasUnread:         false,
  },
  name: 'E2EE etkin sohbet',
};

export const Empty: Story = {
  args: {
    recipientId:       'u-new',
    recipientUsername: 'yeni_arkadaş',
    isOnline:          true,
    isE2EE:            false,
    hasUnread:         false,
  },
  name: 'Boş sohbet (ilk mesaj)',
  parameters: { mockData: { messages: [] } },
};
