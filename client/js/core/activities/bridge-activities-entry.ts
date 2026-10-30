/**
 * Lightweight, authenticated Bridge Activities rail opener.
 * Importing this module never starts WebGL or connects to a game session.
 * The heavier games/social-space UI is loaded only after a user click.
 */
let opening = false;

function bindActivitiesEntry(): void {
  const button = document.getElementById('bridge-activities-entry');
  if (!(button instanceof HTMLButtonElement) || button.dataset.activitiesBound === 'true') return;
  button.dataset.activitiesBound = 'true';
  button.addEventListener('click', async () => {
    if (opening) return;
    opening = true;
    button.disabled = true;
    try {
      const { showBridgeActivities } = await import('./bridge-activities-panel.ts');
      showBridgeActivities('games');
    } catch {
      // The feature fails closed: the rest of messaging and voice stay intact.
      const original = button.getAttribute('aria-label') ?? 'Bridge Activities';
      button.setAttribute('aria-label', original + ' — unavailable');
    } finally {
      button.disabled = false;
      opening = false;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindActivitiesEntry, { once: true });
} else {
  bindActivitiesEntry();
}
