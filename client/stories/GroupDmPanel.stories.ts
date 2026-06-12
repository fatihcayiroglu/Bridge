// client/stories/GroupDmPanel.stories.ts
// Sprint 115 — GroupDmPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import GroupDmPanel from '../js/core/GroupDmPanel.svelte';

const meta = {
  title:     'Bridge/Panels/GroupDmPanel',
  component: GroupDmPanel,
  tags:      ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: 'Grup DM paneli — grup listesi, mesaj alanı, sesli arama, üye yönetimi.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<GroupDmPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: 'Varsayılan' };

export const ActiveConversation: Story = {
  name: 'Aktif konuşma',
  parameters: { mockData: { activeGroup: { name: 'Arkadaşlar', memberCount: 5 } } },
};

export const NoGroups: Story = {
  name: 'Grup yok',
  parameters: { mockData: { groups: [] } },
};
