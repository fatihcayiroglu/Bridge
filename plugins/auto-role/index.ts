// plugins/auto-role/index.ts — Bridge Plugin
// Yeni üye katılınca yapılandırılmış rolü otomatik atar.
// Sprint 107: üçüncü resmi plugin örneği (welcome-bot, word-filter ile birlikte).

'use strict';

import type { PluginContext } from '../lifecycle';

interface AutoRoleConfig {
  roleId?:  string;
  delayMs?: number;
}

interface MemberJoinedPayload {
  userId:   string;
  serverId: string;
  username: string;
}

interface Member {
  userId:  string;
  serverId: string;
  roles?:  string;
}

export async function setup(ctx: PluginContext): Promise<void> {
  ctx.logger.log('Auto Role başlatıldı');

  const cfg    = (ctx.meta.config ?? {}) as AutoRoleConfig;
  const roleId = (cfg.roleId ?? '').trim();
  const delay  = Math.max(0, Number(cfg.delayMs) || 0);

  if (!roleId) {
    ctx.logger.warn('roleId yapılandırılmamış — plugin pasif');
    return;
  }

  ctx.hooks.on('member:joined', async (raw) => {
    const { userId, serverId } = raw as MemberJoinedPayload;

    const assign = async () => {
      try {
        const db = ctx.db as {
          members: { findOne: (q: Record<string, unknown>) => Promise<Member | null> };
        };

        const member = await db.members.findOne({ userId, serverId });
        if (!member) return;

        let roles: string[] = [];
        try {
          roles = JSON.parse(member.roles || '[]');
        } catch {
          roles = [];
        }

        if (roles.includes(roleId)) return;

        // Read-only DB — rol ataması sunucu tarafından işlenir
        ctx.hooks.emit('plugin:grantRole', { userId, serverId, roleId });
        ctx.logger.log(`Rol isteği gönderildi: ${roleId} → ${userId}`);
      } catch (e) {
        ctx.logger.error('Rol atanamadı:', (e as Error).message);
      }
    };

    if (delay > 0) {
      setTimeout(assign, delay);
    } else {
      await assign();
    }
  });

  ctx.registerRoute('GET', '/config', (_req, res) => {
    res.json({ roleId, delayMs: delay, status: roleId ? 'active' : 'inactive' });
  });
}
