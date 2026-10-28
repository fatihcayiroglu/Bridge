// WDA's iOS /element/active resolves hasKeyboardFocus, unlike the optional
// page-source focused attribute (absent in run40725593481). Never type a secret
// on the strength of a click succeeding or of a matching rectangle alone.
export async function dismissUsernameKeyboard({ elements, native, until, record }) {
  let wasVisible = false, requested = false, absent = 0;
  await until(async () => {
    const visible = (await elements('class name', 'XCUIElementTypeKeyboard')).length > 0;
    wasVisible ||= visible;
    record({ wasVisible, dismissed: false });
    if (visible) {
      absent = 0;
      if (!requested) { requested = true; await native('hideKeyboard'); }
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
