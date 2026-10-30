import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE_3D_GAME_CATALOG, BRIDGE_SOCIAL_SPACE } from '../js/core/activities/bridge-game-catalog.ts';
import { moveRoomAvatar, socialRoomAvatarGeometry, staticSocialRoomGeometry, SOCIAL_ROOM_BOUNDS } from '../js/core/activities/social-room-geometry.ts';

describe('Bridge Activities 3D product foundation (not game acceptance)', () => {
  it('catalogs exactly 10 planned games without claiming a playable session', () => {
    expect(BRIDGE_3D_GAME_CATALOG).toHaveLength(10);
    expect(new Set(BRIDGE_3D_GAME_CATALOG.map(game => game.id)).size).toBe(10);
    for (const game of BRIDGE_3D_GAME_CATALOG) {
      expect(game.state).toBe('planned');
      expect(game.id).toMatch(/^[a-z0-9-]+$/);
      expect(game.minPlayers).toBeGreaterThanOrEqual(2);
      expect(game.maxPlayers).toBeGreaterThanOrEqual(game.minPlayers);
      expect(game.maxPlayers).toBeLessThanOrEqual(16);
    }
  });

  it('keeps the 3D social destination separate from all games', () => {
    expect(BRIDGE_SOCIAL_SPACE.kind).toBe('social');
    expect(BRIDGE_SOCIAL_SPACE.state).toBe('local-prototype');
    expect(BRIDGE_3D_GAME_CATALOG.some(game => game.id === BRIDGE_SOCIAL_SPACE.id)).toBe(false);
  });

  it('generates finite 3D triangle coordinates and RGB vertex colors', () => {
    const staticScene = staticSocialRoomGeometry();
    const avatar = socialRoomAvatarGeometry({ x: 1.1, z: -2.3 });
    for (const vertices of [staticScene, avatar]) {
      expect(vertices.length).toBeGreaterThan(36);
      expect(vertices.length % 18).toBe(0); // triangles x three vertices x six attributes
      expect([...vertices].every(Number.isFinite)).toBe(true);
      for (let i = 0; i < vertices.length; i += 6) {
        for (let j = 3; j < 6; j++) {
          expect(vertices[i + j]).toBeGreaterThanOrEqual(0);
          expect(vertices[i + j]).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(staticScene.length).toBeGreaterThan(avatar.length);
  });

  it('bounds avatar motion and refuses invalid coordinates', () => {
    expect(moveRoomAvatar({ x: 0, z: 0 }, 1000, -1000)).toEqual({
      x: SOCIAL_ROOM_BOUNDS.x, z: -SOCIAL_ROOM_BOUNDS.z,
    });
    expect(moveRoomAvatar({ x: 0, z: 0 }, NaN, 0)).toEqual({ x: 0, z: 2.5 });
    expect(moveRoomAvatar({ x: 1, z: -1 }, 0.5, 0.3)).toEqual({ x: 1.5, z: -0.7 });
  });

  it('does not bypass activity authorization with unimplemented game IDs', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../server/socket/handlers/activities.ts'), 'utf8');
    expect(source).toContain('ALLOWED_ACTIVITY_IDS');
    expect(source).toContain("if (!ALLOWED_ACTIVITY_IDS.has(activityId))");
    for (const game of BRIDGE_3D_GAME_CATALOG) {
      expect(source).not.toContain("'" + game.id + "'");
    }
    // A later multiplayer launch requires its own server authority, permissions
    // and expiry audit; this local prototype never emits activity:start.
    const featureDir = path.resolve(__dirname, '../js/core/activities');
    for (const file of [
      'bridge-activities-entry.ts', 'bridge-activities-panel.ts', 'social-room-webgl.ts',
    ]) {
      const contents = fs.readFileSync(path.join(featureDir, file), 'utf8');
      expect(contents).not.toContain("emit('activity:start'");
      expect(contents).not.toContain('eval(');
    }
  });

  it('exposes a dedicated authenticated social tab and cleans up the 3D renderer', () => {
    const client = path.resolve(__dirname, '..');
    const shell = fs.readFileSync(path.join(client, 'index.html'), 'utf8');
    const panel = fs.readFileSync(path.join(client, 'js/core/activities/bridge-activities-panel.ts'), 'utf8');
    const renderer = fs.readFileSync(path.join(client, 'js/core/activities/social-room-webgl.ts'), 'utf8');
    expect(shell).toContain('id="bridge-activities-entry"');
    expect(panel).toContain("currentTab = tab");
    expect(panel).toContain("if (tab === 'social') showSocial(body)");
    expect(panel).toContain('app.inert = true');
    expect(panel).toContain("bridge:auth-logout");
    expect(renderer).toContain("canvas.getContext('webgl'");
    expect(renderer).toContain('gl.enable(gl.DEPTH_TEST)');
    expect(renderer).toContain('cancelAnimationFrame(animationId)');
    expect(renderer).toContain("document.addEventListener('visibilitychange', onVisibility)");
    expect(renderer).toContain('gl.deleteBuffer(staticBuffer)');
  });
});
