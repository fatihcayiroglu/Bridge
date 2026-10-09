// server/tests/plugin-dir-resolution.test.ts
//
// Where the plugin loader looks, against REAL directory layouts (no fs mock).
//
// Measured defect: the compiled loader (server/dist/plugins/loader.js) resolved
// only server/plugins. In a repository checkout that directory holds the
// loader's TypeScript sources and no plugin, so `node server/dist/index.js`
// (process self-hosting, the E2E server) logged "count 0" and ran without the
// three bundled plugins, while the Docker image (which copies <repo>/plugins to
// server/plugins) ran all three.

process.env.NODE_ENV = 'test';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePluginsDir } from '../plugins/loader';

let root: string;

function plugin(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
}
function mkdir(...parts: string[]): string {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-dir-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('resolvePluginsDir', () => {
  it('compiled build in a repository checkout finds <repo>/plugins, not the loader sources', () => {
    const from = mkdir('repo', 'server', 'dist', 'plugins');
    fs.writeFileSync(path.join(mkdir('repo', 'server', 'plugins'), 'loader.ts'), '// sources, not plugins');
    plugin(mkdir('repo', 'plugins'), 'welcome-bot');
    expect(resolvePluginsDir(from).dir).toBe(path.join(root, 'repo', 'plugins'));
  });

  it('Docker image layout (plugins copied to server/plugins) is preferred when present', () => {
    const from = mkdir('app', 'server', 'dist', 'plugins');
    plugin(mkdir('app', 'server', 'plugins'), 'word-filter');
    expect(resolvePluginsDir(from).dir).toBe(path.join(root, 'app', 'server', 'plugins'));
  });

  it('ts-node (server/plugins/loader.ts) finds <repo>/plugins', () => {
    const from = mkdir('repo', 'server', 'plugins');
    plugin(mkdir('repo', 'plugins'), 'auto-role');
    expect(resolvePluginsDir(from).dir).toBe(path.join(root, 'repo', 'plugins'));
  });

  it('no plugin anywhere → null, and the searched candidates are reported', () => {
    const from = mkdir('repo', 'server', 'dist', 'plugins');
    mkdir('repo', 'plugins', 'not-a-plugin'); // a directory without plugin.json does not count
    const r = resolvePluginsDir(from);
    expect(r.dir).toBeNull();
    expect(r.candidates).toEqual([path.join(root, 'repo', 'server', 'plugins'), path.join(root, 'repo', 'plugins')]);
  });

  it('never looks above the repository (a planted ../plugins is ignored)', () => {
    plugin(mkdir('plugins'), 'welcome-bot'); // <root>/plugins, outside <root>/repo
    expect(resolvePluginsDir(mkdir('repo', 'server', 'dist', 'plugins')).dir).toBeNull();
    expect(resolvePluginsDir(mkdir('repo', 'server', 'plugins')).dir).toBeNull();
  });

  it('an unreadable candidate (a file where a directory is expected) is skipped, not thrown', () => {
    mkdir('repo', 'server', 'dist', 'plugins');
    fs.writeFileSync(path.join(root, 'repo', 'server', 'plugins'), 'not a directory');
    plugin(mkdir('repo', 'plugins'), 'welcome-bot');
    expect(resolvePluginsDir(path.join(root, 'repo', 'server', 'dist', 'plugins')).dir)
      .toBe(path.join(root, 'repo', 'plugins'));
  });

  it('this repository: both the compiled and the ts-node loader locations resolve the bundled plugins', () => {
    const repoPlugins = path.resolve(__dirname, '../../plugins');
    expect(fs.existsSync(path.join(repoPlugins, 'welcome-bot', 'plugin.json'))).toBe(true);
    expect(resolvePluginsDir(path.resolve(__dirname, '../dist/plugins')).dir).toBe(repoPlugins);
    expect(resolvePluginsDir(path.resolve(__dirname, '../plugins')).dir).toBe(repoPlugins);
  });
});
