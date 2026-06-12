// client/stories/DiscoverPanel.stories.ts
// Sprint 115 — DiscoverPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import DiscoverPanel from '../js/core/DiscoverPanel.svelte';

const meta = {
  title:     'Bridge/Panels/DiscoverPanel',
  component: DiscoverPanel,
  tags:      ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: 'Sunucu keşif paneli — öne çıkan, trend, yeni, sizin için sekmeleri; kategori filtreleme, debounced arama, sayfalama.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<DiscoverPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: 'Varsayılan görünüm',
};

export const Loading: Story = {
  name: 'Yükleniyor (skeleton)',
  parameters: { mockData: { loading: true } },
};

export const Empty: Story = {
  name: 'Boş sonuç',
  parameters: { mockData: { servers: [] } },
};

export const WithResults: Story = {
  name: 'Sunucu listesi',
  parameters: {
    mockData: {
      servers: Array.from({ length: 18 }, (_, i) => ({
        _id: `server-${i}`,
        name: `Topluluk ${i + 1}`,
        description: 'Harika bir Bridge sunucusu',
        memberCount: Math.floor(Math.random() * 5000) + 10,
        category: ['gaming', 'tech', 'music', 'art'][i % 4],
        isVerified: i % 5 === 0,
        iconUrl: null,
      })),
    },
  },
};
