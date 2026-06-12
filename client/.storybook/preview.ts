// client/.storybook/preview.ts
import type { Preview } from '@storybook/svelte';
import '../css/bridge.css';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'bridge-dark',
      values: [
        { name: 'bridge-dark',  value: '#1a1b26' },
        { name: 'bridge-light', value: '#f8f9fa' },
      ],
    },
    viewport: {
      viewports: {
        mobile:  { name: 'Mobile',  styles: { width: '390px',  height: '844px' } },
        tablet:  { name: 'Tablet',  styles: { width: '768px',  height: '1024px' } },
        desktop: { name: 'Desktop', styles: { width: '1440px', height: '900px' } },
      },
    },
    a11y: {
      config: {
        rules: [
          { id: 'color-contrast',      enabled: true },
          { id: 'aria-required-attr',  enabled: true },
          { id: 'label',               enabled: true },
          { id: 'button-name',         enabled: true },
          { id: 'image-alt',           enabled: true },
        ],
      },
    },
  },
};

export default preview;
