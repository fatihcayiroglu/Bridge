// client/stories/AiPanel.stories.ts
// Sprint 116 — AiPanel Storybook story'si
import type { Meta, StoryObj } from '@storybook/svelte';
import AiPanel from '../js/core/AiPanel.svelte';

const meta = {
  title:     'Bridge/Panels/AiPanel',
  component: AiPanel,
  tags:      ['autodocs'],
  argTypes: {
    channelId:   { control: 'text',    description: 'Aktif kanal ID' },
    serverId:    { control: 'text',    description: 'Aktif sunucu ID' },
    isVisible:   { control: 'boolean', description: 'Panel görünür mü' },
    mode:        { control: 'select',  options: ['summary', 'translate', 'suggest', 'search'], description: 'AI modu' },
  },
  parameters: {
    docs: {
      description: {
        component: 'Bridge AI paneli — kanal özeti, çeviri, yanıt önerisi ve semantik arama. Opsiyonel AI modeli gerektirir.',
      },
    },
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: true }] } },
  },
} satisfies Meta<AiPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Summary: Story = {
  args: { channelId: 'ch-001', serverId: 'srv-001', isVisible: true, mode: 'summary' },
  name: 'Kanal özeti',
};

export const Translate: Story = {
  args: { channelId: 'ch-001', serverId: 'srv-001', isVisible: true, mode: 'translate' },
  name: 'Çeviri modu',
};

export const Suggest: Story = {
  args: { channelId: 'ch-001', serverId: 'srv-001', isVisible: true, mode: 'suggest' },
  name: 'Yanıt önerisi',
};

export const SemanticSearch: Story = {
  args: { channelId: 'ch-001', serverId: 'srv-001', isVisible: true, mode: 'search' },
  name: 'Semantik arama',
};

export const Hidden: Story = {
  args: { channelId: 'ch-001', serverId: 'srv-001', isVisible: false, mode: 'summary' },
  name: 'Gizli panel',
};
