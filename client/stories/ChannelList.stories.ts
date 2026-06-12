// client/stories/ChannelList.stories.ts
// Sprint 112 — ChannelList Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import ChannelList from '../js/core/channel-list/ChannelList.svelte';

const TEXT_CHANNELS = [
  { _id: 'ch-1', name: 'genel',     type: 'text',         unreadCount: 0 },
  { _id: 'ch-2', name: 'duyurular', type: 'announcement', unreadCount: 3 },
  { _id: 'ch-3', name: 'geliştirme', type: 'text',        unreadCount: 0 },
];

const VOICE_CHANNELS = [
  { _id: 'ch-4', name: 'sesli-lobi', type: 'voice',  memberCount: 2 },
  { _id: 'ch-5', name: 'müzik',      type: 'voice',  memberCount: 0 },
  { _id: 'ch-6', name: 'stage',      type: 'stage',  memberCount: 5 },
];

const meta = {
  title:   'Bridge/Navigation/ChannelList',
  component: ChannelList,
  tags:    ['autodocs'],
  argTypes: {
    activeChannelId: { control: 'text', description: 'Aktif kanalın _id değeri' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Sol panel kanal listesi — text, voice, stage ve announcement kanal tiplerini destekler.',
      },
    },
  },
} satisfies Meta<ChannelList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    channels:        [...TEXT_CHANNELS, ...VOICE_CHANNELS],
    activeChannelId: 'ch-1',
  },
  name: 'Karma liste (text + voice + stage)',
};

export const TextOnly: Story = {
  args: {
    channels:        TEXT_CHANNELS,
    activeChannelId: 'ch-2',
  },
  name: 'Sadece text kanallar — okunmamış badge',
  parameters: {
    docs: { description: { story: 'Okunmamış mesaj sayısı olan kanalın badge gösterimi.' } },
  },
};

export const VoiceOnly: Story = {
  args: {
    channels:        VOICE_CHANNELS,
    activeChannelId: 'ch-4',
  },
  name: 'Sadece voice / stage kanallar',
  parameters: {
    docs: { description: { story: 'Stage kanalında aktif üye sayısı göstergesi.' } },
  },
};

export const Empty: Story = {
  args: { channels: [], activeChannelId: null },
  name: 'Boş liste',
  parameters: {
    docs: { description: { story: 'Hiç kanal olmadığında boş durum.' } },
  },
};

export const ManyChannels: Story = {
  args: {
    channels: Array.from({ length: 30 }, (_, i) => ({
      _id:  `ch-${i}`,
      name: `kanal-${i + 1}`,
      type: i % 4 === 3 ? 'voice' : 'text',
      unreadCount: i % 5 === 0 ? i : 0,
    })),
    activeChannelId: 'ch-14',
  },
  name: '30 kanal — sanal scroll testi',
  parameters: {
    docs: { description: { story: 'Çok sayıda kanalda sanal scroll ve performans.' } },
  },
};
