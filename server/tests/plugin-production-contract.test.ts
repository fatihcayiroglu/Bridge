import fs from 'fs';
import path from 'path';
import { RESTRICTED_PERMISSIONS } from '../plugins/allowlist';

const ROOT = path.resolve(__dirname, '../..');

describe('bundled plugin production contract', () => {
  test('production never enables arbitrary local executable plugins via the dev opt-in', () => {
    const loader = fs.readFileSync(path.join(ROOT, 'server', 'plugins', 'loader.ts'), 'utf8');
    expect(loader).toContain("const allowUnsafeLocalPlugins = !isProduction && process.env.ALLOW_UNSAFE_LOCAL_PLUGINS === 'true'");
    expect(loader).toContain('Non-bundled executable plugins are disabled in production.');
  });

  test('bundled manifests declare canonical TypeScript entrypoints and least capabilities', () => {
    const expected: Record<string, string[]> = {
      'welcome-bot': ['channels:read', 'messages:send'],
      'word-filter': ['messages:read', 'channels:read', 'messages:send', 'messages:delete'],
      'auto-role': ['members:read', 'roles:assign'],
    };
    for (const [id, permissions] of Object.entries(expected)) {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', id, 'plugin.json'), 'utf8'));
      expect(manifest.id).toBe(id);
      expect(manifest.main).toBe('index.ts');
      expect(manifest.permissions).toEqual(permissions);
      expect(fs.existsSync(path.join(ROOT, 'plugins', id, 'index.ts'))).toBe(true);
      expect(fs.readFileSync(path.join(ROOT, 'plugins', id, 'index.js'), 'utf8')).toContain('GENERATED FROM index.ts');
    }
    expect(RESTRICTED_PERMISSIONS.has('messages:delete')).toBe(true);
  });

  test('root build regenerates runtime plugin artifacts before client packaging', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['build:plugins']).toBe('node scripts/build-plugins.js');
    expect(pkg.scripts.build).toMatch(/^node scripts\/build-plugins\.js && /);
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('RUN npm run build');
    expect(dockerfile).toContain('COPY --from=build /app/plugins');
  });

  test('server-local build entry point delegates to the canonical validated builder', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'package.json'), 'utf8'));
    expect(pkg.scripts['build:plugins']).toBe('node scripts/build-plugins.js');

    const serverBuilder = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'build-plugins.js'), 'utf8');
    expect(serverBuilder).toContain("require('../../scripts/build-plugins.js')");
    expect(serverBuilder).not.toContain('transpileModule');
  });
});
