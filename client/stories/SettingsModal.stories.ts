// client/stories/SettingsModal.stories.ts
// Sprint 112 — SettingsModal Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import SettingsModal from '../js/core/settings/SettingsModal.svelte';

const meta = {
  title:     'Bridge/Modals/SettingsModal',
  component: SettingsModal,
  tags:      ['autodocs'],
  argTypes: {
    initialTab: {
      control: { type: 'select' },
      options: ['profile', 'appearance', 'notifications', 'privacy', 'devices'],
      description: 'Açılışta gösterilecek sekme',
    },
    onClose: { action: 'closed' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge Settings modali — kullanıcı tercihleri, görünüm, bildirim, gizlilik ve güvenlik sekmeleri.',
      },
    },
  },
} satisfies Meta<SettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args:  { initialTab: 'profile' },
  name:  'Profil sekmesi',
};

export const Appearance: Story = {
  args:  { initialTab: 'appearance' },
  name:  'Görünüm sekmesi',
  parameters: {
    docs: { description: { story: 'Tema (koyu/açık/AMOLED/Aurora) ve düzen modu (Klasik/Odak/Kompakt) seçimi.' } },
  },
};

export const Notifications: Story = {
  args:  { initialTab: 'notifications' },
  name:  'Bildirimler sekmesi',
  parameters: {
    docs: { description: { story: 'Web Push toggle ve bildirim tercihleri.' } },
  },
};

export const Privacy: Story = {
  args:  { initialTab: 'privacy' },
  name:  'Gizlilik sekmesi',
};

export const Devices: Story = {
  args:  { initialTab: 'devices' },
  name:  'Cihazlar sekmesi',
  parameters: {
    docs: { description: { story: 'Mikrofon, kamera ve ses çıkış cihazı seçimi.' } },
  },
};

export const Closed: Story = {
  args:  {},
  name:  'Kapalı (unmount testi)',
  parameters: {
    docs: { description: { story: 'Modal kapalıyken bileşen DOM\'da yer almaz; bu story Storybook teardown davranışını doğrular.' } },
  },
};
