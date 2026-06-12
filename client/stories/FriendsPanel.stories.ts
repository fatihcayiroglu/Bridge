// client/stories/FriendsPanel.stories.ts
// Sprint 116 — FriendsPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import FriendsPanel from '../js/core/FriendsPanel.svelte';

const meta = {
  title:     'Bridge/Panels/FriendsPanel',
  component: FriendsPanel,
  tags:      ['autodocs'],
  argTypes: {
    activeTab: {
      control:  'select',
      options:  ['online', 'all', 'pending', 'blocked'],
      description: 'Aktif sekme',
    },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge arkadaş listesi paneli — çevrimiçi/tüm/bekleyen/engelli sekmeleri, arkadaş ekleme formu, DM/sesli arama başlatma.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<FriendsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnlineFriends: Story = {
  args: { activeTab: 'online' },
  name: 'Çevrimiçi arkadaşlar',
  parameters: {
    mockData: {
      friends: [
        { _id: 'u-1', username: 'ali',   status: 'online',  activity: 'VS Code' },
        { _id: 'u-2', username: 'ayşe',  status: 'idle',    activity: null },
        { _id: 'u-3', username: 'mehmet',status: 'dnd',     activity: 'Müzik dinliyor' },
      ],
    },
  },
};

export const AllFriends: Story = {
  args: { activeTab: 'all' },
  name: 'Tüm arkadaşlar',
};

export const PendingRequests: Story = {
  args: { activeTab: 'pending' },
  name: 'Bekleyen istekler',
  parameters: {
    mockData: {
      incoming: [{ _id: 'u-4', username: 'zeynep', sentAt: new Date().toISOString() }],
      outgoing: [{ _id: 'u-5', username: 'can',    sentAt: new Date().toISOString() }],
    },
  },
};

export const NoFriends: Story = {
  args: { activeTab: 'online' },
  name: 'Boş liste',
  parameters: { mockData: { friends: [] } },
};
