// client/.storybook/main.ts
// Sprint 112 — ADR-0008 Faz 3: Storybook 8 (Svelte) kurulumu
import type { StorybookConfig } from '@storybook/svelte-vite';

const config: StorybookConfig = {
  stories: [
    '../js/core/**/*.stories.@(js|ts|svelte)',
    '../js/core/**/*.story.@(js|ts|svelte)',
    '../stories/**/*.stories.@(js|ts)',
  ],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-a11y',
    '@storybook/addon-svelte-csf',
  ],
  framework: {
    name:    '@storybook/svelte-vite',
    options: {},
  },
  docs: { autodocs: 'tag' },
  viteFinal: async (config) => config,
};

export default config;
