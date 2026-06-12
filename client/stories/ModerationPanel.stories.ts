// client/stories/ModerationPanel.stories.ts
// Sprint 116 — ModerationPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import ModerationPanel from '../js/core/ModerationPanel.svelte';

const meta = {
  title:     'Bridge/Admin/ModerationPanel',
  component: ModerationPanel,
  tags:      ['autodocs'],
  argTypes: {
    serverId:   { control: 'text',    description: 'Sunucu ID' },
    isAdmin:    { control: 'boolean', description: 'Admin yetkisi var mı' },
    activeTab:  { control: 'select',  options: ['bans', 'timeouts', 'reports', 'automod'], description: 'Aktif sekme' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge moderasyon paneli — ban/kick/timeout yönetimi, şikayet kuyruğu, oto-mod kuralları. Sadece admin/moderatör yetkisiyle erişilebilir.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<ModerationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BanList: Story = {
  args: { serverId: 'srv-001', isAdmin: true, activeTab: 'bans' },
  name: 'Ban listesi',
  parameters: {
    mockData: {
      bans: [
        { userId: 'u-1', username: 'spammer42', reason: 'Spam', bannedAt: new Date().toISOString() },
        { userId: 'u-2', username: 'toxic_user', reason: 'Taciz', bannedAt: new Date().toISOString() },
      ],
    },
  },
};

export const Timeouts: Story = {
  args: { serverId: 'srv-001', isAdmin: true, activeTab: 'timeouts' },
  name: 'Zaman aşımları',
};

export const Reports: Story = {
  args: { serverId: 'srv-001', isAdmin: true, activeTab: 'reports' },
  name: 'Şikayet kuyruğu',
  parameters: {
    mockData: {
      reports: Array.from({ length: 5 }, (_, i) => ({
        _id:       `rep-${i}`,
        reason:    ['Spam', 'Nefret söylemi', 'Taciz'][i % 3],
        status:    i < 2 ? 'pending' : 'resolved',
        createdAt: new Date(Date.now() - i * 3600000).toISOString(),
      })),
    },
  },
};

export const AutoMod: Story = {
  args: { serverId: 'srv-001', isAdmin: true, activeTab: 'automod' },
  name: 'Otomatik moderasyon kuralları',
};

export const NoPermission: Story = {
  args: { serverId: 'srv-001', isAdmin: false, activeTab: 'bans' },
  name: 'Yetersiz yetki',
};
