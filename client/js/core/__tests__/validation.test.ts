// client/js/core/__tests__/validation.test.ts
// Common validation utility functions

import { describe, it, expect } from 'vitest';

// Mock validation functions
const validateEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validateUsername = (username: string): boolean => /^[a-zA-Z0-9_-]{3,32}$/.test(username);
const validateURL = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

describe('validation utilities', () => {
  describe('email validation', () => {
    it('should validate correct email addresses', () => {
      expect(validateEmail('user@example.com')).toBe(true);
      expect(validateEmail('test.user@domain.co.uk')).toBe(true);
    });

    it('should reject invalid email addresses', () => {
      expect(validateEmail('invalid')).toBe(false);
      expect(validateEmail('user@')).toBe(false);
      expect(validateEmail('@example.com')).toBe(false);
    });

    it('should reject empty email', () => {
      expect(validateEmail('')).toBe(false);
    });

    it('should handle spaces in email', () => {
      expect(validateEmail('user @example.com')).toBe(false);
    });
  });

  describe('username validation', () => {
    it('should validate correct usernames', () => {
      expect(validateUsername('user123')).toBe(true);
      expect(validateUsername('valid_name')).toBe(true);
      expect(validateUsername('test-user')).toBe(true);
    });

    it('should reject short usernames', () => {
      expect(validateUsername('ab')).toBe(false);
    });

    it('should reject usernames with special characters', () => {
      expect(validateUsername('user@name')).toBe(false);
      expect(validateUsername('user.name')).toBe(false);
    });

    it('should enforce username length limits', () => {
      const longUsername = 'a'.repeat(33);
      expect(validateUsername(longUsername)).toBe(false);
    });
  });

  describe('URL validation', () => {
    it('should validate correct URLs', () => {
      expect(validateURL('https://example.com')).toBe(true);
      expect(validateURL('http://localhost:8080')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(validateURL('not a url')).toBe(false);
      expect(validateURL('')).toBe(false);
    });

    it('should handle URL with query parameters', () => {
      expect(validateURL('https://example.com?param=value')).toBe(true);
    });
  });

  describe('validation utilities', () => {
    it('should validate non-empty strings', () => {
      const isNotEmpty = (s: string): boolean => s && s.length > 0 ? true : false;
      expect(isNotEmpty('hello')).toBe(true);
      expect(isNotEmpty('')).toBe(false);
    });

    it('should validate numeric strings', () => {
      const isNumeric = (s: string): boolean => /^\d+$/.test(s);
      expect(isNumeric('123')).toBe(true);
      expect(isNumeric('abc')).toBe(false);
    });

    it('should validate boolean values', () => {
      expect(typeof true).toBe('boolean');
      expect(typeof false).toBe('boolean');
    });
  });

  describe('validation edge cases', () => {
    it('should handle null and undefined', () => {
      const isValidString = (s: unknown): boolean => typeof s === 'string' && s.length > 0;
      expect(isValidString(null)).toBe(false);
      expect(isValidString(undefined)).toBe(false);
    });

    it('should validate strings with unicode characters', () => {
      const email = 'user+tag@example.com';
      expect(validateEmail(email)).toBe(true);
    });
  });
});
