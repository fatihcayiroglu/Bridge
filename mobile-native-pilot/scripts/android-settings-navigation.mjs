import { namedNode, smallestClickableContaining, tappable, SETTINGS_HOSTS } from './android-auth-ui.mjs';

// Fixed OS labels only; no arbitrary UI text, PIN or credential enters evidence.
export const SETTINGS_TRANSITIONS = Object.freeze({
  'more-security': ['More security & privacy', 'Encryption & credentials'],
  credentials: ['Encryption & credentials', 'Install a certificate'],
  certificates: ['Install a certificate', 'CA certificate'],
  'ca-warning': ['CA certificate', 'Install anyway'],
});
export const MAX_SETTINGS_SWIPES = 7;

/** A tap completing is not proof of navigation. Keep the existing bounded wait
 * and require the next screen's actual OS control before admitting another hop. */
export async function navigateSettings(step, { readUi, answerPin, tap, swipe, until, record }) {
  if (!Object.hasOwn(SETTINGS_TRANSITIONS, step)) throw Error('INVALID_SETTINGS_TRANSITION');
  const labels = SETTINGS_TRANSITIONS[step];
  const [from, to] = labels;
  const evidence = { step, probes: 0, taps: 0, swipes: 0, pinPrompts: 0, destinationSeen: false };
  await until(async () => {
    const nodes = await readUi();
    evidence.probes++;
    if (await answerPin(nodes)) {
      evidence.pinPrompts++; record({ ...evidence }); return false;
    }
    const destination = namedNode(nodes, to, SETTINGS_HOSTS, { ignoreCase: step === 'ca-warning' });
    evidence.destinationSeen = Boolean(destination && tappable(destination));
    if (evidence.destinationSeen) { record({ ...evidence }); return true; }
    const source = namedNode(nodes, from, SETTINGS_HOSTS);
    const control = source?.clickable === 'true' ? source : smallestClickableContaining(nodes, source);
    if (control && tappable(control)) {
      evidence.taps++; record({ ...evidence }); await tap(control); return false;
    }
    // A page heading can have the same label as the menu entry we just opened.
    // It is not an actionable row; search the new page rather than tapping it.
    if (evidence.swipes >= MAX_SETTINGS_SWIPES) { record({ ...evidence }); throw Error('SETTINGS_CONTROL_UNAVAILABLE'); }
    evidence.swipes++; record({ ...evidence }); await swipe(); return false;
  }, 'settings-' + step);
}
