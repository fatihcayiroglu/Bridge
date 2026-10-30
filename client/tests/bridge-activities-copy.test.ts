import { describe, expect, it } from 'vitest';
import { activityStringsForLanguage } from '../js/core/activities/bridge-activities-copy.ts';

describe('Bridge Mini Golf copy tracks its actual experimental 2–8 player contract', () => {
  for (const language of ['en', 'tr-TR']) {
    it(`does not misrepresent online gameplay in ${language}`, () => {
      const s = activityStringsForLanguage(language);
      expect(s.gamesHelp).toMatch(/8/);
      expect(s.gamesHelp).toMatch(/2–8/);
      expect(s.golfOnlineHelp).toMatch(/2–8/);
      expect(s.golfJoin).toMatch(/2–8/);
      expect(s.golfOnlineMode).toMatch(/2–8/);
      expect(s.golfStart).toMatch(/2–8/);
      expect(s.golfJoin).not.toMatch(/two.player|iki oyunculu/i);
      expect(s.gamesHelp).not.toMatch(/multiplayer is not implemented|çok oyunculu oyun henüz hazır değil/i);
      expect(s.golfOnlineHelp).not.toEqual(s.golfHelp);
      expect(s.poolHelp).toMatch(/8.ball|8-ball|8.ball/i);
      expect(s.tryPool).toBeTruthy();
      expect(s.golfLeave).not.toEqual(s.golfJoin);
      expect(s.golfWait).not.toEqual(s.golfWaitStart);
    });
  }
  it('does not accidentally return Turkish for English regional tags', () => {
    expect(activityStringsForLanguage('en-US').golfJoin).toMatch(/^Join/);
    expect(activityStringsForLanguage('tr-TR').golfJoin).toMatch(/katıl/);
  });
});
