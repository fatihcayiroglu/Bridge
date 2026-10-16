// Installed bot/webhook identities used solely for per-rule link_filter exemptions.
// Never trust an installation binding supplied by a client or a posting machine.
import { Bots, ChannelWebhooks, Channels } from '../db/repositories';

export interface IntegrationBinding {
  principal: string;
  installationId: string;
}

export interface InstalledIntegration extends IntegrationBinding {
  name: string;
}

export function validExemptPrincipal(principal: unknown): principal is string {
  return typeof principal === 'string'
    && /^(?:bot|webhook):[A-Za-z0-9_-]{1,128}$/.test(principal);
}

/**
 * Resolve a fresh, tenant-scoped installation. A removed/reinstalled linked bot
 * has a new server-bot row _id; a deleted/recreated webhook has a new webhook _id.
 * In either case an old saved exception cannot silently become effective again.
 */
export async function currentIntegrationInstallation(serverId: string, principal: string): Promise<string | null> {
  if (!validExemptPrincipal(principal)) return null;
  const [type, id] = principal.split(':') as [string, string];
  if (type === 'bot') {
    const bot = await Bots.findById(id) as { _id?: string; serverId?: string; active?: boolean } | null;
    if (!bot || bot.active !== true) return null;
    if (String(bot.serverId) === serverId) return String(bot._id);
    const link = await Bots.findServerBot(id, serverId) as { _id?: string } | null;
    return typeof link?._id === 'string' && link._id ? link._id : null;
  }
  const webhook = await ChannelWebhooks.findById(id) as { _id?: string; serverId?: string; channelId?: string } | null;
  if (!webhook || String(webhook.serverId) !== serverId || typeof webhook.channelId !== 'string') return null;
  const channel = await Channels.findByIdAndServer(webhook.channelId, serverId);
  return channel && typeof webhook._id === 'string' ? webhook._id : null;
}

/** Accept principals only, rejecting forged binding objects and other machine types. */
export async function bindSelectedIntegrations(serverId: string, selected: unknown): Promise<IntegrationBinding[] | null> {
  if (!Array.isArray(selected) || selected.length > 20 || !selected.every(validExemptPrincipal)) return null;
  if (new Set(selected).size !== selected.length) return null;
  const bound: IntegrationBinding[] = [];
  for (const principal of selected as string[]) {
    const installationId = await currentIntegrationInstallation(serverId, principal);
    if (!installationId) return null;
    bound.push({ principal, installationId });
  }
  return bound;
}

/** Manager-only endpoint. No credentials/tokens or plugin principals are returned. */
export async function listInstalledIntegrations(serverId: string): Promise<InstalledIntegration[]> {
  const [bots, channels] = await Promise.all([
    Bots.findInstalledForServer(serverId),
    Channels.findByServer(serverId),
  ]);
  const result: InstalledIntegration[] = [];
  for (const bot of bots) {
    const id = String(bot._id ?? '');
    const principal = `bot:${id}`;
    if (!validExemptPrincipal(principal)) continue;
    const installationId = await currentIntegrationInstallation(serverId, principal);
    if (installationId) result.push({ principal, installationId, name: String(bot.username ?? 'Bot').slice(0, 120) });
  }
  for (const channel of channels) {
    const rows = await ChannelWebhooks.findByChannel(String(channel._id));
    for (const hook of rows) {
      const id = String(hook._id ?? '');
      const principal = `webhook:${id}`;
      if (!validExemptPrincipal(principal)) continue;
      const installationId = await currentIntegrationInstallation(serverId, principal);
      if (installationId) result.push({ principal, installationId, name: String(hook.name ?? 'Webhook').slice(0, 120) });
    }
  }
  return result;
}
