import express from 'express';
import request from 'supertest';

const findById = jest.fn();
const findInvite = jest.fn();
const inviteValid = jest.fn();
const findVanity = jest.fn();
jest.mock('../db/repositories', () => ({
  Servers: { findById: (...args: unknown[]) => findById(...args) },
  Invites: { findByCode: (...args: unknown[]) => findInvite(...args), isValid: (...args: unknown[]) => inviteValid(...args) },
}));
jest.mock('../db/repositories/BoostRepository.js', () => ({
  Boosts: { getLiveVanityServer: (...args: unknown[]) => findVanity(...args) },
}));

import router from '../routes/servers/og-image';

function app() {
  const value = express();
  value.use('/api/servers/:sid/og-image', router);
  return value;
}

function svgText(res: { text?: string; body?: unknown }): string {
  if (typeof res.text === 'string') return res.text;
  if (Buffer.isBuffer(res.body)) return res.body.toString('utf8');
  return typeof res.body === 'string' ? res.body : '';
}

describe('server OG SVG hostile persisted metadata boundary', () => {
  beforeEach(() => {
    findById.mockReset(); findInvite.mockReset(); inviteValid.mockReset(); findVanity.mockReset();
    findInvite.mockResolvedValue(null); inviteValid.mockReturnValue('invalid'); findVanity.mockResolvedValue(null);
  });

  it('renders canonical metadata with cache/content headers and bounded escaped text', async () => {
    findById.mockResolvedValue({
      _id: 'srv', name: 'A<&\"B'.repeat(20), icon: '🌉<&\"', color: '#A1b2C3', discoverable: 1,
    });
    const res = await request(app()).get('/api/servers/srv/og-image');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(findById).toHaveBeenCalledWith('srv');
    const svg = svgText(res);
    expect(svg).toContain('fill="#A1b2C3"');
    expect(svg).not.toContain('🌉<&\"');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&quot;');
  });

  it.each([
    ['#fff\" onload=\"globalThis.pwned=1', 'attribute injection'],
    ['url(javascript:alert(1))', 'CSS URL'],
    ['', 'blank'],
    [123, 'non-string'],
  ] as Array<[unknown, string]>)('falls back from hostile/noncanonical color %s (%s)', async (color) => {
    findById.mockResolvedValue({ _id: 'srv', name: 'Safe', icon: '🌐', color, discoverable: 1 });
    const res = await request(app()).get('/api/servers/srv/og-image');
    expect(res.status).toBe(200);
    const svg = svgText(res);
    expect(svg).toContain('fill="#2d9cdb"');
    expect(svg).not.toContain('onload=');
    expect(svg).not.toContain('javascript:');
  });

  it('contains corrupt/missing persisted name and icon types instead of throwing', async () => {
    findById.mockResolvedValue({ _id: 'srv', name: { bad: true }, icon: 42, color: null, discoverable: 1 });
    let res = await request(app()).get('/api/servers/srv/og-image');
    expect(res.status).toBe(200);
    expect(svgText(res)).toContain('>Bridge</text>');
    expect(svgText(res)).toContain('>🌐</text>');
    findById.mockResolvedValue(null);
    res = await request(app()).get('/api/servers/missing/og-image');
    expect(res.status).toBe(404);
  });

  it('does not expose private server metadata by ID alone', async () => {
    findById.mockResolvedValue({ _id: 'srv', name: 'Private Name', icon: '🔒', discoverable: 0 });
    const res = await request(app()).get('/api/servers/srv/og-image');
    expect(res.status).toBe(404);
    expect(svgText(res)).not.toContain('Private Name');
  });

  it('allows a private preview only when a valid invite grants that capability', async () => {
    findById.mockResolvedValue({ _id: 'srv', name: 'Invite Preview', icon: '🔒', discoverable: 0 });
    findInvite.mockResolvedValue({ code: 'abc', serverId: 'srv' });
    inviteValid.mockReturnValue(null);
    const res = await request(app()).get('/api/servers/srv/og-image?invite=abc');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(svgText(res)).toContain('Invite Preview');
  });
});
