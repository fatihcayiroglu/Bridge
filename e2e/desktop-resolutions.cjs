// CSS viewport measurements, NOT claims about an actual 4K monitor, DPI,
// Windows display scaling, or physical Mac/Linux/Windows devices.
const desktopProfiles = Object.freeze([
  { id: 'small_laptop_1280x720', width: 1280, height: 720 },
  { id: 'laptop_1366x768', width: 1366, height: 768 },
  { id: 'full_hd_1920x1080', width: 1920, height: 1080 },
  { id: 'qhd_2560x1440', width: 2560, height: 1440 },
  { id: 'uhd_3840x2160', width: 3840, height: 2160 },
  { id: 'compact_window_1024x768', width: 1024, height: 768 },
  { id: 'short_window_1280x600', width: 1280, height: 600 },
]);

function inspectMeasurements(m) {
  const failures = [];
  if (!Number.isInteger(m?.viewport?.width) || !Number.isInteger(m?.viewport?.height)) return ['VIEWPORT_NOT_MEASURED'];
  if (m.viewport.width < 1 || m.viewport.height < 1) return ['INVALID_VIEWPORT'];
  if (m.innerWidth !== m.viewport.width || m.innerHeight !== m.viewport.height) failures.push('WRONG_ACTUAL_VIEWPORT');
  if (m.docScrollWidth > m.docClientWidth + 2) failures.push('DOCUMENT_HORIZONTAL_OVERFLOW');
  if (m.docScrollHeight > m.innerHeight + 2) failures.push('DOCUMENT_VERTICAL_OVERFLOW');
  if (!m.appVisible || !m.appRect || m.appRect.width < 100 || m.appRect.height < 100) failures.push('APP_NOT_VISIBLE');
  if (!Number.isInteger(m.activeControls) || m.activeControls < 1) failures.push('NO_VISIBLE_ACTIONS');
  if (!Array.isArray(m.controls) || m.controls.length !== 2) failures.push('PRIMARY_CONTROLS_NOT_MEASURED');
  else for (const c of m.controls) {
    if (m.viewport.width >= 1280 && !c.visible) failures.push(`${c.id}_NOT_VISIBLE`);
    if (c.visible && (!c.bounds || c.bounds.left < -2 || c.bounds.top < -2 ||
      c.bounds.right > m.viewport.width + 2 || c.bounds.bottom > m.viewport.height + 2 ||
      c.bounds.width <= 0 || c.bounds.height <= 0)) failures.push(`${c.id}_CLIPPED`);
  }
  return failures;
}

module.exports = { desktopProfiles, inspectMeasurements };
