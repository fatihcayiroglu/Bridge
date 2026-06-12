// client/stories/VoicePanel.stories.ts
// Sprint 115 — VoicePanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import VoicePanel from '../js/core/VoicePanel.svelte';

const meta = {
  title:     'Bridge/Panels/VoicePanel',
  component: VoicePanel,
  tags:      ['autodocs'],
  argTypes: {
    channelName: { control: 'text', description: 'Ses kanalı adı' },
    isMuted:     { control: 'boolean', description: 'Mikrofon durumu' },
    isDeafened:  { control: 'boolean', description: 'Hoparlör durumu' },
    isVideoOn:   { control: 'boolean', description: 'Video açık/kapalı' },
    peerCount:   { control: { type: 'range', min: 0, max: 50 }, description: 'Bağlı kullanıcı sayısı' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge ses kanalı paneli — mute/deafen/video kontrolü, SFU video grid, PTT desteği.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<VoicePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  args: { channelName: 'genel-ses', isMuted: false, isDeafened: false, isVideoOn: false, peerCount: 0 },
  name: 'Boş kanal',
};

export const Active: Story = {
  args: { channelName: 'genel-ses', isMuted: false, isDeafened: false, isVideoOn: false, peerCount: 4 },
  name: '4 katılımcı',
};

export const Muted: Story = {
  args: { channelName: 'toplantı', isMuted: true, isDeafened: false, isVideoOn: false, peerCount: 2 },
  name: 'Mikrofonlu susturulmuş',
};

export const VideoCall: Story = {
  args: { channelName: 'video-toplantı', isMuted: false, isDeafened: false, isVideoOn: true, peerCount: 3 },
  name: 'Video açık',
};

export const FullRoom: Story = {
  args: { channelName: 'etkinlik', isMuted: false, isDeafened: false, isVideoOn: false, peerCount: 25 },
  name: 'Kalabalık oda (SFU grid)',
};
