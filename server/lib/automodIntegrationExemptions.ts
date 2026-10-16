// Server-authoritative installation bindings for per-rule AutoMod link exemptions.
// Clients may submit only principal strings, never installation ids.
import { Bots, Channels, ChannelWebhooks } from '../db/repositories';
import type { AutomodIntegrationBinding } from './automodPolicy';

export interface InstalledAutomodIntegration extends AutomodIntegrationBinding {
  name: string;
}

export async function currentIntegrationBinding(
  serverId: string,
  principal: string,
): Promise<AutomodIntegrationBinding | null> {
  const match = /^(bot|webhook):([A-Za-z0-9_-]{1,128})$/.exec(principal);
  if (!match || typeof match[1] !== 'string' || typeof match[2] !== 'string') return null;
  // noUncheckedIndexedAccess: each capture must be verified before use.
  const kind = match[1];
  const id = match[2];

  if (kind === 'webhook') {
    const webhook = await ChannelWebhooks.findById(id) as {
      _id?: unknown; channelId?: unknown; serverId?: unknown;
    } | null;
    if (!webhook || String(webhook.serverId ?? '') !== serverId
      || typeof webhook.channelId !== 'string') return null;
    const channel = await Channels.findByIdAndServer(webhook.channelId, serverId);
    return channel ? { principal, installationId: id } : null;
  }

  const bot = await Bots.findById(id) as {
    _id?: unknown; serverId?: unknown; active?: unknown;
  } | null;
  if (!bot || bot.active !== true) return null;
  if (String(bot.serverId ?? '') === serverId) {
    return { principal, installationId: id };
  }
  const link = await Bots.findServerBot(id, serverId) as { _id?: unknown } | null;
  return link && typeof link._id === 'string'
    ? { principal, installationId: link._id }
    : null;
}

export async function bindIncomingIntegrationSelections(
  serverId: string,
  principals: unknown,
): Promise<AutomodIntegrationBinding[]> {
  if (!Array.isArray(principals) || principals.length > 20
    || principals.some((entry) => typeof entry !== 'string')) {
    throw new Error('invalid_integration_selection');
  }
  const seen = new Set<string>();
  const bound: AutomodIntegrationBinding[] = [];
  for (const principal of principals as string[]) {
    if (seen.has(principal)) throw new Error('invalid_integration_selection');
    seen.add(principal);
    const binding = await currentIntegrationBinding(serverId, principal);
    if (!binding) throw new Error('invalid_integration_selection');
    bound.push(binding);
  }
  return bound;
}

export async function listInstalledAutomodIntegrations(serverId: string): Promise<InstalledAutomodIntegration[]> {
  const [bots, channels] = await Promise.all([
    Bots.findInstalledForServer(serverId),
    Channels.findByServer(serverId),
  ]);
  const result: InstalledAutomodIntegration[] = [];
  for (const bot of bots) {
    const principal = `bot:${String(bot._id)}`;
    const binding = await currentIntegrationBinding(serverId, principal);
    if (binding) result.push({ ...binding, name: String(bot.username || 'Bot') });
  }
  for (const channel of channels) {
    for (const hook of await ChannelWebhooks.findByChannel(String(channel._id))) {
      const principal = `webhook:${String(hook._id)}`;
      const binding = await currentIntegrationBinding(serverId, principal);
      if (binding) result.push({ ...binding, name: String(hook.name || 'Webhook') });
    }
  }
  return result.sort((a, b) => a.principal.localeCompare(b.principal));
}
