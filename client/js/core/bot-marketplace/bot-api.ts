import type { BotEntry } from './types.js';
const loaded: BotEntry[] = [];
export async function fetchLoadedPlugins(): Promise<BotEntry[]> { return loaded; }
export function getLoadedPlugins(): BotEntry[] { return loaded; }
export async function installBotOnServer(..._args: unknown[]): Promise<void> {}
export async function uninstallBotFromServer(..._args: unknown[]): Promise<void> {}
