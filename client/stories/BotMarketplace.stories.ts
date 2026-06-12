// client/stories/BotMarketplace.stories.ts
// Sprint 112 — BotMarketplace Storybook story'si
// Bot arama, kategori filtresi, yüklü/yüklenmemiş state, sekme görünümleri.
import type { Meta, StoryObj } from '@storybook/svelte';
import BotMarketplace from '../js/core/bot-marketplace/BotMarketplace.svelte';

const meta = {
  title:   'Bridge/Features/BotMarketplace',
  component: BotMarketplace,
  tags:    ['autodocs'],
  argTypes: {
    initialCategory: {
      control:     'text',
      description: 'Açılışta seçili kategori (boş = tümü)',
    },
    initialTab: {
      control:  { type: 'select' },
      options:  ['featured', 'all', 'installed'],
      description: 'Açılışta gösterilecek sekme',
    },
    onClose: { action: 'closed' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bot Marketplace — öne çıkan, tüm botlar ve kurulu botlar sekmeleri; kategori + arama filtresi.',
      },
    },
  },
} satisfies Meta<BotMarketplace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Featured: Story = {
  args: {
    initialTab:      'featured',
    initialCategory: '',
  },
  name: 'Öne Çıkan Botlar',
};

export const AllBots: Story = {
  args: {
    initialTab:      'all',
    initialCategory: '',
  },
  name: 'Tüm Botlar',
  parameters: {
    docs: { description: { story: 'Tam katalog — arama ve kategori filtresi ile.' } },
  },
};

export const FilteredByCategory: Story = {
  args: {
    initialTab:      'all',
    initialCategory: 'moderation',
  },
  name: 'Kategori filtreli — Moderasyon',
  parameters: {
    docs: { description: { story: 'Sadece moderasyon kategorisindeki botlar gösterilir.' } },
  },
};

export const InstalledTab: Story = {
  args: {
    initialTab:      'installed',
    initialCategory: '',
  },
  name: 'Kurulu Botlar',
  parameters: {
    docs: { description: { story: 'Bu sunucuda kurulu botların listesi ve kaldırma seçeneği.' } },
  },
};
