const installed = new Set<string>();
export function getInstalledBots(): Set<string> { return installed; }
export function isBotInstalled(id: string): boolean { return installed.has(id); }
export function toggleInstalledLocal(id: string, value?: boolean): void { if (value ?? !installed.has(id)) installed.add(id); else installed.delete(id); }
export function showToast(message: string, type = 'info'): void { (globalThis as unknown as { toast?: (m: string,t?: string)=>void }).toast?.(message,type); }
