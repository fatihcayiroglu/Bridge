// client/js/core/__tests__/data-utils.test.ts
// Data manipulation and collection utilities

import { describe, it, expect } from 'vitest';

// Mock utility functions
const groupBy = <T>(arr: T[], key: keyof T): Record<string, T[]> => {
  return arr.reduce((result, item) => {
    const groupKey = String(item[key]);
    if (!result[groupKey]) result[groupKey] = [];
    result[groupKey].push(item);
    return result;
  }, {} as Record<string, T[]>);
};

const unique = <T>(arr: T[]): T[] => [...new Set(arr)];

const flatten = <T>(arr: T[][]): T[] => arr.flat();

const chunk = <T>(arr: T[], size: number): T[][] => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

describe('data manipulation utilities', () => {
  describe('groupBy functionality', () => {
    it('should group objects by property', () => {
      const users = [
        { id: 1, role: 'admin' },
        { id: 2, role: 'user' },
        { id: 3, role: 'admin' },
      ];
      const grouped = groupBy(users, 'role');
      expect(grouped['admin'].length).toBe(2);
      expect(grouped['user'].length).toBe(1);
    });

    it('should handle empty arrays', () => {
      const result = groupBy([] as { key: string }[], 'key');
      expect(Object.keys(result).length).toBe(0);
    });

    it('should preserve object properties', () => {
      const items = [{ id: 1, type: 'a' }, { id: 2, type: 'a' }];
      const grouped = groupBy(items, 'type');
      expect(grouped['a'][0].id).toBe(1);
    });
  });

  describe('unique functionality', () => {
    it('should remove duplicate values', () => {
      expect(unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
    });

    it('should handle strings', () => {
      expect(unique(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('should preserve order for first occurrence', () => {
      const result = unique([3, 1, 2, 1, 3]);
      expect(result[0]).toBe(3);
    });

    it('should handle empty array', () => {
      expect(unique([])).toEqual([]);
    });
  });

  describe('flatten functionality', () => {
    it('should flatten nested arrays', () => {
      expect(flatten([[1, 2], [3, 4]])).toEqual([1, 2, 3, 4]);
    });

    it('should handle empty nested arrays', () => {
      expect(flatten([[], [], []])).toEqual([]);
    });

    it('should work with mixed content', () => {
      expect(flatten([['a', 'b'], ['c']])).toEqual(['a', 'b', 'c']);
    });
  });

  describe('chunk functionality', () => {
    it('should split array into chunks', () => {
      const result = chunk([1, 2, 3, 4, 5], 2);
      expect(result).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('should handle exact division', () => {
      const result = chunk([1, 2, 3, 4], 2);
      expect(result.length).toBe(2);
    });

    it('should handle chunk size larger than array', () => {
      const result = chunk([1, 2], 5);
      expect(result.length).toBe(1);
    });

    it('should handle empty array', () => {
      expect(chunk([], 2)).toEqual([]);
    });
  });

  describe('array operations', () => {
    it('should find maximum value', () => {
      expect(Math.max(1, 2, 3, 4)).toBe(4);
      expect(Math.max(...[1, 2, 3, 4])).toBe(4);
    });

    it('should sum array values', () => {
      const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
      expect(sum([1, 2, 3, 4])).toBe(10);
    });

    it('should find index of element', () => {
      const arr = ['a', 'b', 'c'];
      expect(arr.indexOf('b')).toBe(1);
    });

    it('should check array includes value', () => {
      expect([1, 2, 3].includes(2)).toBe(true);
      expect([1, 2, 3].includes(4)).toBe(false);
    });
  });

  describe('collection utilities', () => {
    it('should get object keys', () => {
      const obj = { a: 1, b: 2, c: 3 };
      expect(Object.keys(obj)).toEqual(['a', 'b', 'c']);
    });

    it('should get object values', () => {
      const obj = { a: 1, b: 2, c: 3 };
      expect(Object.values(obj)).toEqual([1, 2, 3]);
    });

    it('should merge objects', () => {
      const result = { ...{ a: 1 }, ...{ b: 2 } };
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('should clone arrays', () => {
      const original = [1, 2, 3];
      const cloned = [...original];
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
    });
  });
});
