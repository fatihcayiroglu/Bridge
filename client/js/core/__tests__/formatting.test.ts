// client/js/core/__tests__/formatting.test.ts
// Text formatting and transformation utilities

import { describe, it, expect } from 'vitest';

// Mock formatting functions
const capitalize = (str: string): string => str.charAt(0).toUpperCase() + str.slice(1);
const slugify = (str: string): string => str.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
const truncate = (str: string, length: number): string => str.length > length ? str.slice(0, length) + '...' : str;
const formatBytes = (bytes: number): string => {
  const sizes = ['B', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
};

describe('formatting utilities', () => {
  describe('string capitalization', () => {
    it('should capitalize first letter', () => {
      expect(capitalize('hello')).toBe('Hello');
      expect(capitalize('HELLO')).toBe('HELLO');
    });

    it('should handle empty strings', () => {
      expect(capitalize('')).toBe('');
    });

    it('should handle single character', () => {
      expect(capitalize('a')).toBe('A');
    });
  });

  describe('slugification', () => {
    it('should convert spaces to hyphens', () => {
      expect(slugify('hello world')).toBe('hello-world');
    });

    it('should convert to lowercase', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('should remove special characters', () => {
      expect(slugify('hello-world!')).toBe('hello-world');
    });

    it('should handle multiple spaces', () => {
      expect(slugify('hello    world')).toBe('hello-world');
    });
  });

  describe('text truncation', () => {
    it('should truncate long strings', () => {
      const result = truncate('hello world', 5);
      expect(result).toBe('hello...');
    });

    it('should not truncate short strings', () => {
      expect(truncate('hi', 5)).toBe('hi');
    });

    it('should handle exact length', () => {
      const result = truncate('hello', 5);
      expect(result).toBe('hello');
    });

    it('should handle empty strings', () => {
      expect(truncate('', 5)).toBe('');
    });
  });

  describe('byte formatting', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1024)).toContain('KB');
      expect(formatBytes(1024 * 1024)).toContain('MB');
    });

    it('should handle large sizes', () => {
      const gb = 1024 * 1024 * 1024;
      expect(formatBytes(gb)).toContain('GB');
    });
  });

  describe('text transformation', () => {
    it('should reverse strings', () => {
      const reverse = (s: string) => s.split('').reverse().join('');
      expect(reverse('hello')).toBe('olleh');
    });

    it('should handle case conversion', () => {
      const str = 'HeLLo WoRLd';
      expect(str.toUpperCase()).toBe('HELLO WORLD');
      expect(str.toLowerCase()).toBe('hello world');
    });

    it('should trim whitespace', () => {
      expect('  hello  '.trim()).toBe('hello');
      expect('hello'.trim()).toBe('hello');
    });
  });

  describe('formatting edge cases', () => {
    it('should handle unicode characters', () => {
      expect(capitalize('über')).toBe('Über');
    });

    it('should handle null-like values', () => {
      const safeCapitalize = (s: unknown) => s ? capitalize(String(s)) : '';
      expect(safeCapitalize(null)).toBe('');
      expect(safeCapitalize(undefined)).toBe('');
    });

    it('should handle very long strings', () => {
      const longStr = 'a'.repeat(10000);
      expect(truncate(longStr, 100).length).toBeLessThan(longStr.length);
    });
  });
});
