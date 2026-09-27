// scripts/medialab/scenarios/lifecycle.mjs
//
// Device and track lifecycle during a live call: camera on/off cycles,
// screen share start/stop/restart, a microphone switch from Settings →
// Devices, capture tracks ending underneath the app (device unplugged /
// permission revoked), and a session recovery while muted. Checks for leaked
// captures, duplicate producers/consumers and state that disagrees with what
// the other participant actually decodes.

import { audibleSenders, visibleSenders, rtp } from '../lib/analysis.mjs';
import { sleep, waitUntil, waitAudible, waitSilent } from '../lib/util.mjs';

const both = [0, 1];

export async function run({ lab, record, measure }) {
  const [ua, ub] = await lab.users(2, 'lc');
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua);
  const B = await lab.client(1, ub);
  await A.joinVoice(room);
  await sleep(1000);
  await B.joinVoice(room);
  if (!(await waitAudible(B, [0], both, 15_000)).ok) { record('LC-00', 'baseline media', 'FAIL', 'no A→B audio'); return; }

  // ── camera on/off x5 ───────────────────────────────────────────────────
  const cam = [];
  for (let i = 0; i < 5; i++) {
    await A.toggleVideo();
    const on = await waitUntil(async () => (visibleSenders(await B.sample()).includes(0) ? true : null), { timeoutMs: 15_000 });
    await A.toggleVideo();
    const off = await waitUntil(async () => (!visibleSenders(await B.sample()).includes(0) ? true : null), { timeoutMs: 10_000 });
    const caps = await A.liveCaptures();
    const sb = await B.sample();
    cam.push({ on: on.ok ? on.ms : null, off: off.ok ? off.ms : null, aLiveVideoCaptures: caps.filter((c) => c.kind === 'video').length, bVideoTracks: sb.tracks.filter((t) => t.kind === 'video').length });
  }
  record('LC-01', 'camera on/off x5: B sees A each time, nothing leaks (captures, remote tracks)',
    cam.every((c) => c.on !== null && c.off !== null && c.aLiveVideoCaptures === 0 && c.bVideoTracks === 0) ? 'PASS' : 'FAIL', JSON.stringify(cam));

  // ── screen share start/stop/restart x3 ─────────────────────────────────
  const ss = [];
  for (let i = 0; i < 3; i++) {
    await A.startScreenShare();
    const on = await waitUntil(async () => ((await B.sample()).tracks.some((t) => t.kind === 'video' && t.w > 0) ? true : null), { timeoutMs: 15_000 });
    await A.stopScreenShare();
    const off = await waitUntil(async () => ((await B.sample()).tracks.every((t) => t.kind !== 'video') ? true : null), { timeoutMs: 10_000 });
    const caps = await A.liveCaptures();
    ss.push({ on: on.ok ? on.ms : null, off: off.ok ? off.ms : null, aDisplayCaptures: caps.filter((c) => c.source === 'display').length });
  }
  record('LC-02', 'screen share start/stop x3: decoded each time, display capture released each time',
    ss.every((x) => x.on !== null && x.off !== null && x.aDisplayCaptures === 0) ? 'PASS' : 'FAIL', JSON.stringify(ss));

  // ── microphone switch from Settings → Devices during the call ──────────
  {
    const before = (await A.page.evaluate(() => window.__mlCaptured.length));
    const opened = await A.page.locator('#btn-settings, #user-identity').first().click({ timeout: 5_000 }).then(() => true).catch(() => false);
    let switched = false; let detail = '';
    if (opened) {
      await A.page.getByRole('tab', { name: /Cihazlar/ }).click({ timeout: 5_000 }).catch(() => {});
      const select = A.page.locator('#mic-select');
      await select.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      // The device list loads asynchronously (enumerateDevices after a permission probe).
      const loaded = await waitUntil(async () => {
        const vals = await select.locator('option').evaluateAll((os) => os.map((o) => o.value)).catch(() => []);
        return vals.filter(Boolean).length >= 2 ? vals : null;
      }, { timeoutMs: 10_000 });
      const options = loaded.value ?? await select.locator('option').evaluateAll((os) => os.map((o) => o.value)).catch(() => []);
      const current = await select.inputValue().catch(() => '');
      // A concrete device, not the system default alias.
      const target = options.find((v) => v && v !== 'default' && v !== 'communications' && v !== current);
      if (target) {
        await select.selectOption(target);
        await A.page.locator('.field-actions .btn--primary').first().click({ timeout: 5_000 }).catch(() => {});
        const applied = await waitUntil(async () => {
          const caps = await A.page.evaluate((n) => window.__mlCaptured.slice(n).map((c) => ({ kind: c.kind, state: c.track.readyState, label: c.track.label })), before);
          return caps.some((c) => c.kind === 'audio' && c.state === 'live') ? caps : null;
        }, { timeoutMs: 8_000 });
        switched = applied.ok;
        detail = `options ${options.length}, selected ${target.slice(0, 8)}…, new live audio capture after save: ${applied.ok}`;
      } else detail = `only ${options.length} microphone option(s)`;
      await A.page.keyboard.press('Escape').catch(() => {});
    } else detail = 'settings entry point not found';
    const stillHeard = await waitAudible(B, [0], both, 8_000);
    record('LC-03', 'microphone switched in Settings → Devices applies to the live call (new capture, still heard)',
      switched && stillHeard.ok ? 'PASS' : (detail.startsWith('only') || detail.startsWith('settings') ? 'BLOCKED' : 'FAIL'), `${detail}; B still hears A: ${stillHeard.ok}`);
  }

  // ── capture track ends underneath the app (unplug / permission revoked) ─
  {
    await A.toggleVideo();
    await waitUntil(async () => (visibleSenders(await B.sample()).includes(0) ? true : null), { timeoutMs: 15_000 });
    // A device loss ends the track AND fires 'ended'; track.stop() alone never fires it.
    await A.page.evaluate(() => window.__mlCaptured.filter((c) => c.kind === 'video' && c.track.readyState === 'live').forEach((c) => { c.track.stop(); c.track.dispatchEvent(new Event('ended')); }));
    const gone = await waitUntil(async () => (!visibleSenders(await B.sample()).includes(0) ? true : null), { timeoutMs: 10_000 });
    const ui = await A.uiState();
    record('LC-04', 'camera track ended by the device: producer closed, UI shows camera off, B stops receiving', gone.ok && !ui.video ? 'PASS' : 'FAIL', `B stopped seeing A: ${gone.ok}; A UI video ${ui.video}`);

    await A.page.evaluate(() => window.__mlCaptured.filter((c) => c.kind === 'audio' && c.track.readyState === 'live').forEach((c) => { c.track.stop(); c.track.dispatchEvent(new Event('ended')); }));
    const silent = await waitSilent(B, [0], both, 10_000);
    const uiA = await A.uiState();
    const outA = rtp(await A.sample()).audioOut;
    record('LC-05', 'microphone track ended by the device: what happens', 'INFO',
      `B stopped hearing A: ${silent.ok}; A UI ${JSON.stringify(uiA)}; A outbound audio streams ${outA.streams}; toast/console ${JSON.stringify(A.console.slice(-2).map((m) => m.text.slice(0, 120)))}`);
    // Rejoin restores a working microphone.
    await A.leaveVoice(); await sleep(1500); await A.joinVoice(room);
    const back = await waitAudible(B, [0], both, 15_000);
    record('LC-06', 'after the device loss, leave + rejoin restores the microphone', back.ok ? 'PASS' : 'FAIL', `${back.ms} ms`);
  }

  // ── session recovery while muted must keep the user muted ──────────────
  {
    await A.toggleMute();
    await waitSilent(B, [0], both, 5_000);
    await lab.net.impair(0, { up: { blackhole: true }, down: { blackhole: true } });
    await sleep(30_000);
    await lab.net.impair(0, { up: {}, down: {} });
    const bBack = await waitAudible(A, [1], both, 90_000);
    const leak = await waitUntil(async () => (audibleSenders(await B.sample(), both).includes(0) ? true : null), { timeoutMs: 8_000 });
    const ui = await A.uiState();
    record('LC-07', '30 s outage while muted: session comes back, user is still muted (not heard), UI agrees',
      bBack.ok && !leak.ok && ui.muted ? 'PASS' : 'FAIL', `A hears B again: ${bBack.ok ? `${bBack.ms} ms after restore` : 'NO'}; B hears muted A: ${leak.ok}; A UI ${JSON.stringify(ui)}`);
    if (ui.inVoice) {
      await A.toggleMute();
      const un = await waitAudible(B, [0], both, 10_000);
      record('LC-08', 'unmute after the recovered session: B hears A', un.ok ? 'PASS' : 'FAIL', `${un.ms} ms`);
    }
  }
  measure('captures.end', { A: await A.liveCaptures(), B: await B.liveCaptures() }, 'live capture tracks');
}
