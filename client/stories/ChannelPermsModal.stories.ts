// client/stories/ChannelPermsModal.stories.ts
// Sprint 112 — ChannelPermsModal Storybook story'si
// Kanal izinleri matrisi, rol seçimi, audit sekmeleri ve dirty-state davranışı.
import type { Meta, StoryObj } from '@storybook/svelte';
import ChannelPermsModal from '../js/core/channel-perms/ChannelPermsModal.svelte';

const ROLE_OPTIONS = [
  { id: 'role-admin',    name: 'Admin',      isUser: false },
  { id: 'role-mod',      name: 'Moderatör',  isUser: false },
  { id: 'role-member',   name: 'Üye',        isUser: false },
  { id: 'user-ali',      name: 'Ali Yılmaz', isUser: true  },
];

const TEMPLATE_OPTIONS = [
  { id: 'tpl-readonly', label: 'Salt Okunur' },
  { id: 'tpl-standard', label: 'Standart'    },
  { id: 'tpl-admin',    label: 'Admin'       },
];

const MATRIX_HTML = `
  <table class="perms-matrix">
    <tr><th>İzin</th><th>Admin</th><th>Moderatör</th><th>Üye</th></tr>
    <tr><td>Mesaj gönder</td><td>✅</td><td>✅</td><td>✅</td></tr>
    <tr><td>Dosya yükle</td><td>✅</td><td>✅</td><td>✅</td></tr>
    <tr><td>Mesaj sil</td><td>✅</td><td>✅</td><td>❌</td></tr>
    <tr><td>Kanal yönet</td><td>✅</td><td>❌</td><td>❌</td></tr>
  </table>
`;

const meta = {
  title:   'Bridge/Modals/ChannelPermsModal',
  component: ChannelPermsModal,
  tags:    ['autodocs'],
  argTypes: {
    activeTab: {
      control:  { type: 'select' },
      options:  ['matrix', 'audit', 'sync'],
      description: 'Açılışta gösterilecek sekme',
    },
    isDirty: {
      control:     'boolean',
      description: 'Kaydedilmemiş değişiklik badge\'i',
    },
    onClose: { action: 'closed' },
    onTab:   { action: 'tab-changed' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Kanal izin yönetim modali — rol/kullanıcı bazlı izin matrisi, audit log ve senkronizasyon sekmeleri.',
      },
    },
  },
} satisfies Meta<ChannelPermsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Matrix: Story = {
  args: {
    channelId:       'ch-genel',
    channelName:     '#genel',
    activeTab:       'matrix',
    roleOptions:     ROLE_OPTIONS,
    templateOptions: TEMPLATE_OPTIONS,
    matrixHtml:      MATRIX_HTML,
    isDirty:         false,
    onClose:         () => {},
    onTab:           () => {},
  },
  name: 'İzin Matrisi — temiz',
};

export const MatrixDirty: Story = {
  args: {
    ...Matrix.args,
    isDirty:  true,
    saveInfo: '3 değişiklik kaydedilmedi',
  },
  name: 'İzin Matrisi — kaydedilmemiş değişiklik',
  parameters: {
    docs: { description: { story: 'Dirty-state badge ve kaydet butonu aktif durumda.' } },
  },
};

export const AuditTab: Story = {
  args: {
    ...Matrix.args,
    activeTab: 'audit',
  },
  name: 'Audit Log sekmesi',
  parameters: {
    docs: { description: { story: 'Rol/kanal değişiklik geçmişi.' } },
  },
};

export const SyncTab: Story = {
  args: {
    ...Matrix.args,
    activeTab: 'sync',
  },
  name: 'Senkronizasyon sekmesi',
};
