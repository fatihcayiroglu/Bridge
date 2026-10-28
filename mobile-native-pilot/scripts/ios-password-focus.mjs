// WDA's iOS /element/active resolves hasKeyboardFocus, unlike the optional
// page-source focused attribute (absent in run40725593481). Never type a secret
// on the strength of a click succeeding or of a matching rectangle alone.
export const NATIVE_TOOLBAR_DONE = '//XCUIElementTypeToolbar//XCUIElementTypeButton[@name="Done" and @visible="true" and @enabled="true"]';
export async function dismissUsernameKeyboard({ elements, native, command, until, record, recordControls = () => {} }) {
  let wasVisible = false, requested = false, absent = 0;
  await until(async () => {
    const visible = (await elements('class name', 'XCUIElementTypeKeyboard')).length > 0;
    wasVisible ||= visible;
    record({ wasVisible, dismissed: false });
    if (visible) {
      absent = 0;
      if (!requested) {
        requested = true;
        // WDA's generic hideKeyboard searches keyboard descendants only. Safari
        // may expose its dismissal button in a separate native accessory toolbar.
        const done = await elements('xpath', NATIVE_TOOLBAR_DONE);
        recordControls({ toolbarDoneCount: Math.min(2, done.length), toolbarDoneSelected: done.length === 1 });
        if (done.length > 1) throw Error('LOGIN_KEYBOARD_DONE_NOT_UNIQUE');
        if (done.length === 1) {
          const id = done[0]?.['element-6066-11e4-a52e-4f735466cecf'] ?? done[0]?.ELEMENT;
          if (typeof id !== 'string' || !id) throw Error('LOGIN_KEYBOARD_DONE_ID_REQUIRED');
          await command('POST', `/element/${id}/click`, {});
        } else await native('hideKeyboard');
      }
      return false;
    }
    return ++absent >= 2;
  }, 'username-keyboard-dismissed');
  record({ wasVisible, dismissed: true });
}

export async function enterFocusedPassword({ targetId, command, until, record, typePassword }, password) {
  if (typeof targetId !== 'string' || !targetId) throw Error('LOGIN_PASSWORD_TARGET_REQUIRED');
  await until(async () => {
    let active;
    try { active = await command('GET', '/element/active'); }
    catch (error) {
      if (error?.message !== 'WebDriver active failed (404; no such element)') throw error;
      record({ activeFound: false, targetMatches: false, secureType: false });
      return false;
    }
    const id = active?.['element-6066-11e4-a52e-4f735466cecf'] ?? active?.ELEMENT;
    const matches = typeof id === 'string' && id === targetId;
    const type = matches ? await command('GET', `/element/${targetId}/attribute/type`) : null;
    const secure = type === 'XCUIElementTypeSecureTextField';
    record({ activeFound: typeof id === 'string' && id.length > 0, targetMatches: matches, secureType: secure });
    return matches && secure;
  }, 'password-keyboard-focus');
  await typePassword(targetId, password);
}
