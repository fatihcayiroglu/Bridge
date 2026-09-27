import fs from 'fs';
import path from 'path';

describe('PATCH /api/me presence privacy ordering contract', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/auth.ts'), 'utf8');
  const start = source.indexOf("router.patch('/me'");
  const end = source.indexOf("router.post('/me/avatar'", start);
  const block = source.slice(start, end);

  it('hides in shared authority before durable profile persistence', () => {
    const hideGuard = block.indexOf("if (requestedPresence === 'hidden')");
    const hideAuthority = block.indexOf("setPresenceVisibility(_u.id, false)", hideGuard);
    const durableUpdate = block.indexOf('await Users.update(_u.id, updates)');
    expect(hideGuard).toBeGreaterThanOrEqual(0);
    expect(hideAuthority).toBeGreaterThan(hideGuard);
    expect(durableUpdate).toBeGreaterThan(hideAuthority);
    expect(block.slice(hideGuard, durableUpdate)).toContain("return res.status(503)");
  });

  it('persists visible preference before removing the shared privacy barrier', () => {
    const durableUpdate = block.indexOf('await Users.update(_u.id, updates)');
    const showGuard = block.indexOf('if (visible)', durableUpdate);
    const showAuthority = block.indexOf("setPresenceVisibility(_u.id, true)", showGuard);
    expect(durableUpdate).toBeGreaterThanOrEqual(0);
    expect(showAuthority).toBeGreaterThan(durableUpdate);
    expect(block.slice(showGuard, showAuthority + 80)).toContain("setPresenceVisibility(_u.id, true)");
  });

  it('does not acknowledge a configured-authority visibility transition after authority failure', () => {
    expect(block).toContain("error: 'Presence coordination unavailable'");
    expect(block).not.toContain('Presence visibility persisted; realtime sync will recover on reconnect.');
  });
});
