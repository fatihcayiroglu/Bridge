#!/usr/bin/env node
/**
 * Real Chromium software-GPU lifecycle proof for the actual WebGL renderer.
 *
 * Both contexts get real shaders, vertex buffers and GPU draws. Lose/restore
 * extension simulates a real browser GPU reset. This is NOT a real-phone FPS
 * result and does not exercise a live multiplayer server.
 */
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('../../node_modules/esbuild');
const entry = fileURLToPath(new URL('../../client/js/core/activities/social-room-webgl.ts', import.meta.url));
const built = await esbuild.build({
  entryPoints: [entry],
  bundle: true, write: false, minify: false,
  format: 'iife', globalName: 'BridgeSocialGraphicsSmoke',
  platform: 'browser', target: 'chrome110',
});
if (built.outputFiles.length !== 1) throw Error('Expected one real renderer bundle');

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 750, height: 520 } });
  await page.goto('about:blank');
  await page.addScriptTag({ content: built.outputFiles[0].text });
  for (const graphicsApi of ['webgl2', 'webgl1']) {
    await page.evaluate(api => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width: 600px; height: 400px; display: block';
      canvas.setAttribute('tabindex', '0');
      document.body.replaceChildren(canvas);
      if (api === 'webgl1') {
        const original = canvas.getContext.bind(canvas);
        canvas.getContext = function (name, options) {
          return name === 'webgl2' ? null : original(name, options);
        };
      }
      const state = { lost: 0, restored: 0, drawing: false, holder: null, canvas, api };
      const holder = window.BridgeSocialGraphicsSmoke.startLocalSocialRoom(
        canvas,
        undefined,
        () => { state.lost++; },
        () => { state.restored++; },
      );
      if (!holder || holder.graphicsApi !== api) throw Error('Unexpected GPU version or failed renderer');
      state.holder = holder;
      window.__socialGraphicsLifecycle = state;
    }, graphicsApi);

    await page.waitForFunction(() => {
      const s = window.__socialGraphicsLifecycle;
      const gl = s.canvas.getContext(s.api === 'webgl2' ? 'webgl2' : 'webgl');
      return s.holder.isGraphicsAvailable && Boolean(gl?.getParameter(gl.CURRENT_PROGRAM));
    }, { timeout: 8000 });

    const allowed = await page.evaluate(() => {
      const { canvas, api } = window.__socialGraphicsLifecycle;
      const gl = canvas.getContext(api === 'webgl2' ? 'webgl2' : 'webgl');
      const ext = gl.getExtension('WEBGL_lose_context');
      if (!ext) throw Error('WEBGL_lose_context unavailable — cannot claim recovery');
      // The context loss notification is asynchronous; assertions below wait
      // for browser-generated events, not an artificial event dispatch.
      ext.loseContext();
      window.__socialGraphicsLifecycle.extension = ext;
      return Boolean(ext);
    });
    if (!allowed) throw Error('No genuine browser context-loss extension');

    await page.waitForFunction(() => {
      const s = window.__socialGraphicsLifecycle;
      return s.lost === 1 && !s.holder.isGraphicsAvailable;
    }, { timeout: 8000 });
    const lostRejectsPeers = await page.evaluate(() => {
      const s = window.__socialGraphicsLifecycle;
      return s.holder.setOnlinePeers([{
        socketId: 'owner', userId: 'owner', x: 0, z: 0,
      }], 'owner') === false;
    });
    if (!lostRejectsPeers) throw Error('Lost context accepted network peer state');

    await page.evaluate(() => window.__socialGraphicsLifecycle.extension.restoreContext());
    await page.waitForFunction(() => {
      const s = window.__socialGraphicsLifecycle;
      const gl = s.canvas.getContext(s.api === 'webgl2' ? 'webgl2' : 'webgl');
      return s.restored === 1 && s.holder.isGraphicsAvailable &&
        Boolean(gl?.getParameter(gl.CURRENT_PROGRAM));
    }, { timeout: 10000 });

    // Simulate repeated foreground redraw and disposal after recovery.
    await page.evaluate(() => {
      const s = window.__socialGraphicsLifecycle;
      s.holder.setQuality('low');
      s.holder.setDirection('forward', true);
      s.holder.setDirection('forward', false);
      s.holder.dispose();
      if (s.holder.isGraphicsAvailable) throw Error('Disposed renderer stayed live');
      s.extension.loseContext();
    });
    // Loss after disposal cannot invoke stale callbacks or recreate GPU state.
    await page.waitForTimeout(100);
    const status = await page.evaluate(() => {
      const s = window.__socialGraphicsLifecycle;
      return { lost: s.lost, restored: s.restored, available: s.holder.isGraphicsAvailable };
    });
    if (status.lost !== 1 || status.restored !== 1 || status.available) {
      throw Error('Stale callbacks after GPU release: ' + JSON.stringify(status));
    }
    console.log('SOCIAL_3D_REAL_CONTEXT_RESTORE_OK:' + graphicsApi);
  }
  console.log('SOCIAL_3D_REAL_CONTEXT_RESTORE:2/2:0_skipped');
} finally {
  await browser.close();
}
