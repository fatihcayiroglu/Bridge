import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindActivitiesEntry } from '../js/core/activities/bridge-activities-entry.ts';

const mock = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('../js/core/activities/bridge-activities-panel.ts', () => ({
  showBridgeActivities: mock.show,
}));

function button() {
  const el=document.createElement('button');
  el.id='bridge-activities-entry';
  document.body.append(el);
  return el;
}
async function settle(button: HTMLButtonElement) {
  await vi.waitFor(() => expect(button.disabled).toBe(false), { timeout: 3000 });
}
beforeEach(() => {
  document.body.replaceChildren();
  mock.show.mockReset();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('authenticated Activities entry: lazy load, single binding and fail-closed UI', () => {
  it('refuses missing/non-button rail elements and leaves original DOM untouched', () => {
    bindActivitiesEntry();
    const impostor=document.createElement('div');
    impostor.id='bridge-activities-entry';
    document.body.append(impostor);
    bindActivitiesEntry();
    impostor.click();
    expect(mock.show).not.toHaveBeenCalled();
    expect(impostor.dataset.activitiesBound).toBeUndefined();
  });
  it('binds once to the real button and lazily opens only after explicit click', async () => {
    const el=button();
    bindActivitiesEntry();
    bindActivitiesEntry();
    expect(el.dataset.activitiesBound).toBe('true');
    expect(mock.show).not.toHaveBeenCalled();
    el.click();
    await settle(el);
    expect(mock.show).toHaveBeenCalledExactlyOnceWith('games');
  });
  it('recovers the rail after a panel-import callback error, without exposing private details', async () => {
    const el=button();
    el.setAttribute('aria-label','Activities');
    mock.show.mockImplementationOnce(() => { throw Error('private stack/path detail'); });
    bindActivitiesEntry();
    el.click();
    await settle(el);
    expect(el.getAttribute('aria-label')).toBe('Activities — unavailable');
    expect(el.getAttribute('aria-label')).not.toContain('private');
    mock.show.mockClear();
    el.click();
    await settle(el);
    expect(mock.show).toHaveBeenCalledWith('games');
    expect(el.disabled).toBe(false);
  });
  it('uses generic localized-independent fallback labeling if no aria label exists', async () => {
    const el=button();
    mock.show.mockImplementationOnce(() => { throw Error('cannot load'); });
    bindActivitiesEntry();
    el.click();
    await settle(el);
    expect(el.getAttribute('aria-label')).toBe('Bridge Activities — unavailable');
    expect(el.disabled).toBe(false);
  });
});
