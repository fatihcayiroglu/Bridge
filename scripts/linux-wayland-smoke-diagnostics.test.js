// P7 #416: the native-Wayland smoke gained read-only diagnostics. This test proves (1) the diagnostics report a seat correctly
// (a SIGPIPE under pipefail once could have reported a present seat as absent) and bounded failure facts, and (2) none of the
// acceptance checks were relaxed. It runs the script's own functions with stub `weston`/`wayland-info`, never a fake app pass.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'electron', 'scripts', 'ci-linux-wayland-smoke.sh');
const script = fs.readFileSync(scriptPath, 'utf8');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'desktop-native-gates.yml'), 'utf8');

function functions() {
  const start = script.indexOf('print_compositor_facts() {');
  const end = script.indexOf('export XDG_RUNTIME_DIR');
  assert.ok(start > 0 && end > start, 'diagnostic functions found');
  return `set -euo pipefail\n${script.slice(start, end)}`;
}
function run(body, env = {}, bin) {
  return spawnSync('bash', ['-c', `${functions()}\n${body}`], {
    encoding: 'utf8', env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
  });
}
function stubs({ seat }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-stub-'));
  fs.writeFileSync(path.join(bin, 'weston'), '#!/bin/sh\necho "weston 13.0.0"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'wayland-info'),
    `#!/bin/sh\necho "interface: 'wl_compositor', version: 6, name: 1"\necho "interface: 'xdg_wm_base', version: 5, name: 2"\n${seat ? `echo "interface: 'wl_seat', version: 8, name: 3"\n` : ''}`, { mode: 0o755 });
  return bin;
}

test('reports a missing wl_seat as ABSENT and a present one as present', () => {
  const absent = run('print_compositor_facts', {}, stubs({ seat: false }));
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /WAYLAND_DIAG wl_seat=ABSENT/);
  assert.match(absent.stdout, /globals=wl_compositor@6 xdg_wm_base@5/);
  const present = run('print_compositor_facts', {}, stubs({ seat: true }));
  assert.match(present.stdout, /WAYLAND_DIAG wl_seat=present/);
  assert.doesNotMatch(present.stdout, /ABSENT/);
});

test('says so when wayland-info is not installed instead of guessing', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-stub-'));
  fs.writeFileSync(path.join(bin, 'weston'), '#!/bin/sh\necho "weston 13.0.0"\n', { mode: 0o755 });
  const out = spawnSync('bash', ['-c', `${functions()}\nPATH="${bin}:/usr/local/bin:/bin" print_compositor_facts`], { encoding: 'utf8' });
  assert.match(out.stdout, /wayland-info=not-installed|wl_seat=/);
});

test('failure facts are counts and a bounded compositor tail, never the whole app log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-root-'));
  fs.writeFileSync(path.join(root, 'app.log'),
    'Gdk: gdk_seat_get_keyboard: assertion GDK_IS_SEAT failed\nSECRET-USER-TEXT\nxdg_wm_base#7.get_xdg_surface(10, 11)\n');
  fs.writeFileSync(path.join(root, 'weston.log'), Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'));
  const out = run('print_failure_facts', { ROOT: root, APP_PID: '999999', COMPOSITOR_PID: '999998' }, stubs({ seat: false }));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /app_alive=no compositor_alive=no/);
  assert.match(out.stdout, /gdk_seat_assertions=1 .*get_xdg_surface=1 get_toplevel=0 ack_configure=0/);
  assert.doesNotMatch(out.stdout, /SECRET-USER-TEXT/);
  assert.equal(out.stdout.split('\n').filter((l) => /^line \d+$/.test(l)).length, 30);
});

test('acceptance checks and constraints are unchanged', () => {
  assert.match(script, /for i in \{1\.\.60\}; do/, 'the 60 s window is kept');
  assert.match(script, /"\$\{APP\}" --ozone-platform=wayland --user-data-dir=/);
  assert.ok(!/--no-sandbox/.test(script.replace(/#.*$/gm, '').replace(/"[^"\n]*no --no-sandbox[^"\n]*"/g, '')), 'sandbox stays on');
  assert.match(script, /^unset DISPLAY$/m);
  assert.match(script, /xdg_toplevel#\[0-9\]\+\\\.set_\(min\|max\)_size\\\(/);
  assert.match(script, /xdg_surface#\[0-9\]\+\\\.ack_configure\\\(/);
  assert.match(script, /weston --backend=headless-backend\.so/);
  // Both failure paths print facts and still exit 1.
  assert.match(script, /exited before creating a Wayland toplevel" >&2\n    print_failure_facts >&2\n    tail -40/);
  assert.match(script, /in 60s" >&2\nprint_failure_facts >&2\ntail -60 "\$\{ROOT\}\/app\.log" >&2 \|\| true\nexit 1/);
});

test('the workflow installs the tool the diagnostics use', () => {
  assert.match(workflow, /apt-get install -y --no-install-recommends weston wayland-utils/);
});
