// client/stories/ForumPanel.stories.ts
// Sprint 116 — ForumPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import ForumPanel from '../js/core/ForumPanel.svelte';

const meta = {
  title:     'Bridge/Panels/ForumPanel',
  component: ForumPanel,
  tags:      ['autodocs'],
  argTypes: {
    channelId:   { control: 'text',                                  description: 'Forum kanal ID' },
    serverId:    { control: 'text',                                  description: 'Sunucu ID' },
    sortBy:      { control: 'select', options: ['latest', 'top', 'new'], description: 'Sıralama' },
    canPost:     { control: 'boolean',                               description: 'Yeni konu açma izni' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge forum paneli — thread listesi, konu oluşturma, etiket ve sıralama.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<ForumPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { channelId: 'forum-001', serverId: 'srv-001', sortBy: 'latest', canPost: true },
  name: 'Varsayılan forum',
};

export const ReadOnly: Story = {
  args: { channelId: 'forum-001', serverId: 'srv-001', sortBy: 'top', canPost: false },
  name: 'Salt okunur (izin yok)',
};

export const Empty: Story = {
  args: { channelId: 'forum-empty', serverId: 'srv-001', sortBy: 'new', canPost: true },
  name: 'Boş forum',
  parameters: { mockData: { threads: [] } },
};

export const TopThreads: Story = {
  args: { channelId: 'forum-001', serverId: 'srv-001', sortBy: 'top', canPost: true },
  name: 'En popüler konular',
  parameters: {
    mockData: {
      threads: Array.from({ length: 10 }, (_, i) => ({
        _id:         `thread-${i}`,
        title:       `Konu başlığı ${i + 1}`,
        replyCount:  (10 - i) * 7,
        isPinned:    i === 0,
        tags:        i % 3 === 0 ? ['duyuru'] : [],
        createdAt:   new Date(Date.now() - i * 86400000).toISOString(),
      })),
    },
  },
};
