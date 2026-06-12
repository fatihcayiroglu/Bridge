// client/stories/ServerSettingsModal.stories.ts
// Sprint 112 — ServerSettingsModal Storybook story'si
// Hub genel ayarları (isim, açıklama, kategori, gizlilik, federasyon).
import type { Meta, StoryObj } from '@storybook/svelte';
import ServerSettingsModal from '../js/core/server-settings/ServerSettingsModal.svelte';

const meta = {
  title:   'Bridge/Modals/ServerSettingsModal',
  component: ServerSettingsModal,
  tags:    ['autodocs'],
  argTypes: {
    onClose: { action: 'closed' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Hub (sunucu) ayar modali — genel bilgiler, roller, moderasyon, federasyon ve entegrasyon sekmeleri.',
      },
    },
  },
} satisfies Meta<ServerSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args:  { onClose: () => {} },
  name:  'Hub Ayarları — genel sekme',
  parameters: {
    docs: { description: { story: 'Hub ismi, açıklaması, kategorisi ve gizlilik ayarı.' } },
  },
};

export const NoServer: Story = {
  args:  { onClose: () => {} },
  name:  'Hub seçili değil (boş state)',
  parameters: {
    docs: {
      description: {
        story: 'BridgeRegistry\'den hub bilgisi alınamadığında modal boş state gösterir. ' +
               'Bu Storybook ortamında (window.BridgeRegistry yok) beklenen davranıştır.',
      },
    },
  },
};
