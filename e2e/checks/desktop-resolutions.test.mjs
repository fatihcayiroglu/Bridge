import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { desktopProfiles, inspectMeasurements } = require('../desktop-resolutions.cjs');

const sample = () => ({ viewport: { width: 1366, height: 768 }, innerWidth: 1366, innerHeight: 768,
  docScrollWidth: 1366, docClientWidth: 1366, docScrollHeight: 768, appVisible: true,
  appRect: { width: 1366, height: 768 }, activeControls: 6,
  controls: ['btn-search', 'btn-settings'].map(id => ({ id, visible: true,
    bounds: { left: 50, right: 100, top: 30, bottom: 80, width: 50, height: 50 } })) });

test('matrix includes laptop, 1366, Full HD, QHD, 4K and windowed layouts', () => {
  assert.deepEqual(desktopProfiles.map(x => `${x.width}x${x.height}`), [
    '1280x720', '1366x768', '1920x1080', '2560x1440', '3840x2160', '1024x768', '1280x600',
  ]);
  assert.equal(new Set(desktopProfiles.map(x => x.id)).size, desktopProfiles.length);
});

test('real fully visible shell passes the pure measurement gate', () => {
  assert.deepEqual(inspectMeasurements(sample()), []);
});

test('horizontal or vertical overflow must make matrix red', () => {
  assert.ok(inspectMeasurements({ ...sample(), docScrollWidth: 1390 }).includes('DOCUMENT_HORIZONTAL_OVERFLOW'));
  assert.ok(inspectMeasurements({ ...sample(), docScrollHeight: 801 }).includes('DOCUMENT_VERTICAL_OVERFLOW'));
});

test('absent, clipped or unreachable settings control is not a pass', () => {
  assert.ok(inspectMeasurements({ ...sample(), activeControls: 0 }).includes('NO_VISIBLE_ACTIONS'));
  const hidden = sample(); hidden.controls[1].visible = false;
  assert.ok(inspectMeasurements(hidden).includes('btn-settings_NOT_VISIBLE'));
  const clipped = sample(); clipped.controls[0].bounds.right = 1900;
  assert.ok(inspectMeasurements(clipped).includes('btn-search_CLIPPED'));
});

test('a 4K-labelled viewport cannot pass if actual browser size differs', () => {
  const m = sample(); m.viewport = { width: 3840, height: 2160 };
  assert.ok(inspectMeasurements(m).includes('WRONG_ACTUAL_VIEWPORT'));
});
