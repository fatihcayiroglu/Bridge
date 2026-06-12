import type { BotEntry } from './types.js';
const catalog: BotEntry[] = [];
export function getCatalog(): BotEntry[] { return catalog; }
export async function loadCatalog(): Promise<BotEntry[]> { return catalog; }
