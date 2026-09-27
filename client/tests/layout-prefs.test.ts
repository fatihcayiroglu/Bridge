import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLayoutPrefsForTests,
  getLayoutMode,
  isBridgeLayoutMode,
  setLayoutMode,
  subscribeLayoutMode,
} from '../js/core/layout-prefs.ts';

afterEach(() => __resetLayoutPrefsForTests());

describe('layout preference observable contract', () => {
  it('publishes real layout changes to live subscribers and stops after unsubscribe', () => {
    const seen: string[] = [];
    const stop = subscribeLayoutMode(mode => seen.push(mode));
    expect(seen).toEqual(['comfortable']);

    setLayoutMode('compact');
    setLayoutMode('focus');
    expect(getLayoutMode()).toBe('focus');
    expect(seen).toEqual(['comfortable', 'compact', 'focus']);

    stop();
    stop();
    setLayoutMode('classic');
    expect(seen).toEqual(['comfortable', 'compact', 'focus']);
  });

  it('does not emit duplicate notifications for an idempotent set', () => {
    const listener = vi.fn();
    subscribeLayoutMode(listener);
    listener.mockClear();
    setLayoutMode('comfortable');
    expect(listener).not.toHaveBeenCalled();
    setLayoutMode('cozy');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('cozy');
  });

  it('uses a snapshot so a subscriber may unsubscribe itself without skipping peers', () => {
    const events: string[] = [];
    let stopFirst = () => {};
    stopFirst = subscribeLayoutMode(mode => {
      events.push(`first:${mode}`);
      if (mode === 'compact') stopFirst();
    });
    subscribeLayoutMode(mode => events.push(`second:${mode}`));
    events.length = 0;

    setLayoutMode('compact');
    setLayoutMode('focus');
    expect(events).toEqual(['first:compact', 'second:compact', 'second:focus']);
  });

  it('isolates a failing subscriber so later consumers still receive the committed mode', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const healthy = vi.fn();
    subscribeLayoutMode(() => { throw new Error('consumer exploded'); });
    subscribeLayoutMode(healthy);
    healthy.mockClear();

    expect(() => setLayoutMode('focus')).not.toThrow();
    expect(getLayoutMode()).toBe('focus');
    expect(healthy).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledWith('focus');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects malformed runtime values instead of poisoning shared layout state', () => {
    expect(isBridgeLayoutMode('focus')).toBe(true);
    expect(isBridgeLayoutMode('not-a-layout')).toBe(false);
    expect(() => setLayoutMode('not-a-layout' as never)).toThrow(TypeError);
    expect(getLayoutMode()).toBe('comfortable');
    expect(() => subscribeLayoutMode(null as never)).toThrow(TypeError);
  });
});
