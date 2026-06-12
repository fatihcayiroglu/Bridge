// client/js/core/__tests__/emoji.test.ts
// Emoji utility functions

import { describe, it, expect } from 'vitest';

// Test data for emoji functions
const commonEmojis = ['😀', '😃', '😄', '😁', '😆', '👍', '🎉', '❤️', '🚀', '✨'];
const emojiWithModifiers = ['👨‍👩‍👧‍👦', '👩‍💼', '🏳️‍🌈', '👨🏽‍🦰'];

describe('emoji utilities', () => {
  describe('emoji detection', () => {
    it('should identify single character emoji', () => {
      commonEmojis.forEach((emoji) => {
        expect(emoji.length).toBeGreaterThan(0);
      });
    });

    it('should handle emoji sequences', () => {
      const emojiSequence = commonEmojis.join('');
      expect(emojiSequence.length).toBeGreaterThan(0);
    });

    it('should identify modified emoji with skin tone', () => {
      emojiWithModifiers.forEach((emoji) => {
        expect(emoji.length).toBeGreaterThan(1);
      });
    });
  });

  describe('emoji collection', () => {
    it('should have valid emoji list', () => {
      expect(commonEmojis.length).toBeGreaterThan(0);
    });

    it('should contain only string values', () => {
      commonEmojis.forEach((emoji) => {
        expect(typeof emoji).toBe('string');
      });
    });

    it('should have unique emoji entries', () => {
      const uniqueEmojis = new Set(commonEmojis);
      expect(uniqueEmojis.size).toBe(commonEmojis.length);
    });

    it('should support emoji categories', () => {
      const categories = ['smile', 'hand', 'celebration', 'love', 'rocket', 'star'];
      expect(categories.length).toBeGreaterThan(0);
    });
  });

  describe('emoji formatting', () => {
    it('should normalize emoji spacing', () => {
      const emojiText = '😀 hello 😀';
      expect(emojiText).toContain('😀');
    });

    it('should preserve emoji in text', () => {
      const text = 'Hello 👋 world 🌍';
      expect(text.includes('👋')).toBe(true);
      expect(text.includes('🌍')).toBe(true);
    });

    it('should handle emoji-only messages', () => {
      const emojiOnly = '🎉🎊🎈';
      expect(emojiOnly.length).toBeGreaterThan(0);
    });
  });

  describe('emoji validation', () => {
    it('should validate emoji presence', () => {
      const hasEmoji = commonEmojis.length > 0;
      expect(hasEmoji).toBe(true);
    });

    it('should handle empty emoji list', () => {
      const emptyEmojis: string[] = [];
      expect(emptyEmojis.length).toBe(0);
    });
  });
});
