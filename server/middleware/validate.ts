// server/middleware/validate.ts
// Lightweight input validation middleware (no external deps)
// nested object validation, boolean type, sanitize option

import { Request, Response, NextFunction } from 'express';
import { escapeHtml } from '../lib/security';

export type FieldType = 'string' | 'number' | 'array' | 'object' | 'boolean';

export interface FieldRules {
  type?: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: string[];
  each?: FieldRules | string;
  shape?: Schema;
  sanitize?: boolean;
}

export type Schema = Record<string, FieldRules>;

/**
 * validateBody(schema) — Express middleware
 * schema: { field: { type, required, min, max, pattern, enum, each, shape } }
 * type: 'string' | 'number' | 'array' | 'object' | 'boolean'
 * shape: schema for nested objects (type:'object')
 * each: { type, ... } for array item validation (supports objects via shape)
 */
export function validateField(
  path: string,
  val: unknown,
  rules: FieldRules,
  errors: string[]
): void {
  const missing = val === undefined || val === null || val === '';

  if (rules.required && missing) { errors.push(`${path} is required`); return; }
  if (missing) return;

  if (rules.type === 'boolean') {
    if (typeof val !== 'boolean') errors.push(`${path} must be a boolean`);
    return;
  }

  if (rules.type === 'string') {
    if (typeof val !== 'string') { errors.push(`${path} must be a string`); return; }
    const s = rules.sanitize ? escapeHtml(val.trim()) : val.trim();
    if (rules.min !== undefined && s.length < rules.min) errors.push(`${path} must be at least ${rules.min} characters`);
    if (rules.max !== undefined && s.length > rules.max) errors.push(`${path} must be at most ${rules.max} characters`);
    if (rules.pattern && !rules.pattern.test(s)) errors.push(`${path} has invalid format`);
    if (rules.enum && !rules.enum.includes(s)) errors.push(`${path} must be one of: ${rules.enum.join(', ')}`);
    return;
  }

  if (rules.type === 'number') {
    const n = Number(val);
    if (isNaN(n)) { errors.push(`${path} must be a number`); return; }
    if (rules.min !== undefined && n < rules.min) errors.push(`${path} must be >= ${rules.min}`);
    if (rules.max !== undefined && n > rules.max) errors.push(`${path} must be <= ${rules.max}`);
    return;
  }

  if (rules.type === 'array') {
    if (!Array.isArray(val)) { errors.push(`${path} must be an array`); return; }
    if (rules.min !== undefined && val.length < rules.min) errors.push(`${path} must have at least ${rules.min} items`);
    if (rules.max !== undefined && val.length > rules.max) errors.push(`${path} too many items (max ${rules.max})`);
    if (rules.each) {
      val.forEach((item, i) => {
        if (typeof rules.each === 'string') {
          if (typeof item !== rules.each) errors.push(`${path}[${i}] must be ${rules.each}`);
        } else if (rules.each && typeof rules.each === 'object') {
          validateField(`${path}[${i}]`, item, rules.each as FieldRules, errors);
        }
      });
    }
    return;
  }

  if (rules.type === 'object') {
    if (typeof val !== 'object' || Array.isArray(val) || val === null) {
      errors.push(`${path} must be an object`); return;
    }
    if (rules.shape) {
      for (const [subField, subRules] of Object.entries(rules.shape)) {
        validateField(`${path}.${subField}`, (val as Record<string, unknown>)[subField], subRules, errors);
      }
    }
    return;
  }
}

export function validateBody(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];
    for (const [field, rules] of Object.entries(schema)) {
      validateField(field, (req.body as Record<string, unknown>)[field], rules, errors);
      if (!errors.length && rules?.type === 'string' && rules?.sanitize && typeof (req.body as Record<string, unknown>)[field] === 'string') {
        (req.body as Record<string, unknown>)[field] = escapeHtml(((req.body as Record<string, unknown>)[field] as string).trim());
      }
    }
    if (errors.length) { res.status(400).json({ error: errors[0], errors }); return; }
    next();
  };
}

// Common schemas
export const schemas: Record<string, Schema> = {
  message: {
    content: { type: 'string', required: true, min: 1, max: 2000 },
  },
  register: {
    username: { type: 'string', required: true, min: 3, max: 32, pattern: /^[a-zA-Z0-9_]+$/ },
    password: { type: 'string', required: true, min: 8, max: 128 },
  },
  login: {
    username: { type: 'string', required: true, min: 3, max: 32 },
    password: { type: 'string', required: true, min: 1, max: 128 },
  },
  changePassword: {
    currentPassword: { type: 'string', required: true, min: 1, max: 128 },
    newPassword: { type: 'string', required: true, min: 8, max: 128 },
  },
  createServer: {
    name: { type: 'string', required: true, min: 1, max: 50 },
  },
  createChannel: {
    name: { type: 'string', required: true, min: 1, max: 32 },
    type: { type: 'string', required: true, enum: ['text', 'voice'] },
  },
  createRole: {
    name: { type: 'string', required: true, min: 1, max: 32 },
  },
  createBot: {
    name:        { type: 'string', required: true, min: 1, max: 50 },
    description: { type: 'string', max: 200 },
  },
  createWebhook: {
    name:   { type: 'string', required: true, min: 1, max: 50 },
    events: { type: 'array', max: 20, each: { type: 'string', max: 64 } },
  },
};

export interface BitmaskPair {
  allow?: string;
  deny?: string;
}

/**
 * validateBitmaskMiddleware(target?) — Express middleware
 * Bitmask allow/deny değerlerini merkezi olarak doğrular.
 */
export function validateBitmaskMiddleware(target?: string | BitmaskPair[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown>;

    if (typeof target === 'string') {
      const items = body[target];
      if (!Array.isArray(items)) { next(); return; }
      for (let i = 0; i < items.length; i++) {
        const item = items[i] as Record<string, unknown>;
        const a = Number(item.allow ?? 0);
        const d = Number(item.deny  ?? 0);
        if (!Number.isInteger(a) || a < 0) {
          res.status(400).json({ error: `${target}[${i}].allow must be a valid non-negative integer` }); return;
        }
        if (!Number.isInteger(d) || d < 0) {
          res.status(400).json({ error: `${target}[${i}].deny must be a valid non-negative integer` }); return;
        }
        if ((a & d) !== 0) {
          res.status(400).json({ error: `${target}[${i}]: allow and deny cannot contain overlapping bits` }); return;
        }
      }
      next(); return;
    }

    const pairs: BitmaskPair[] = Array.isArray(target)
      ? target
      : [{ allow: 'allow', deny: 'deny' }];

    for (const { allow: af = 'allow', deny: df = 'deny' } of pairs) {
      const rawA = body[af];
      const rawD = body[df];
      if (rawA === undefined && rawD === undefined) continue;
      const a = Number(rawA ?? 0);
      const d = Number(rawD ?? 0);
      if (!Number.isInteger(a) || a < 0) {
        res.status(400).json({ error: `${af} must be a valid non-negative integer` }); return;
      }
      if (!Number.isInteger(d) || d < 0) {
        res.status(400).json({ error: `${df} must be a valid non-negative integer` }); return;
      }
      if ((a & d) !== 0) {
        res.status(400).json({ error: `${af} and ${df} cannot contain overlapping bits` }); return;
      }
    }
    next();
  };
}
