// server/index.ts — production launcher
//
// External secret authorities must be hydrated before importing the runtime
// graph because many production modules read process.env at module load time.
// Keeping this launcher intentionally small preserves that ordering contract.

import 'dotenv/config';
import { hydrateRuntimeSecrets } from './lib/runtimeSecrets';

async function launch(): Promise<void> {
  await hydrateRuntimeSecrets();
  await import('./runtime');
}

launch().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error('[FATAL] Bridge launcher failed before runtime bootstrap:', message);
  process.exit(1);
});
