// server/lib/swagger.ts
// OpenAPI 3.0 spec + Swagger UI
//
// MİMARİ:
//   - Canonical source: docs/api/openapi.yaml
//   - Build-time snapshot: server/generated/openapi.json
//   - Runtime never scans source files and never depends on swagger-jsdoc
//
// Oturum C (Sprint 79):
//   - JSON tip güvenliği: OpenApiSchema, OpenApiPath, OpenApiSpec arayüzleri
//   - $ref resolver: resolveRef() — spec içindeki $ref referanslarını çözümler
//   - operationId otomasyonu: ensureOperationIds() — eksik operationId'leri path+method'dan türetir
//   - validateSpec(): eksik tag, geçersiz $ref, boş paths uyarıları üretir
//   - BASE_SPEC artık OpenApiSpec ile tam tip güvenli
//
// KURULUM (zaten kurulu):
//   Runtime dependency: swagger-ui-express (spec snapshot is generated at build time)

import express, { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import runtimeSpec from '../generated/openapi.json';

// ── Oturum C: Tip tanımları ─────────────────────────────────────

export type OpenApiSchemaType =
  | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface OpenApiSchema {
  type?:                 OpenApiSchemaType;
  format?:               string;
  description?:          string;
  example?:              unknown;
  nullable?:             boolean;
  enum?:                 unknown[];
  default?:              unknown;
  minimum?:              number;
  maximum?:              number;
  minLength?:            number;
  maxLength?:            number;
  pattern?:              string;
  items?:                OpenApiSchema | { $ref: string };
  properties?:           Record<string, OpenApiSchema | { $ref: string }>;
  required?:             string[];
  additionalProperties?: boolean | OpenApiSchema;
  allOf?:                Array<OpenApiSchema | { $ref: string }>;
  oneOf?:                Array<OpenApiSchema | { $ref: string }>;
  anyOf?:                Array<OpenApiSchema | { $ref: string }>;
  $ref?:                 string;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: OpenApiSchema | { $ref: string } }>;
  $ref?:    string;
}

export interface OpenApiParameter {
  name:        string;
  in:          'query' | 'path' | 'header' | 'cookie';
  required?:   boolean;
  description?: string;
  schema:      OpenApiSchema | { $ref: string };
}

export interface OpenApiOperation {
  tags?:        string[];
  summary?:     string;
  description?: string;
  operationId?: string;
  security?:    Record<string, string[]>[];
  parameters?:  OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content:   Record<string, { schema: OpenApiSchema | { $ref: string } }>;
  };
  responses:    Record<string, OpenApiResponse | { $ref: string }>;
  deprecated?:  boolean;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace';

export type OpenApiPath = Partial<Record<HttpMethod, OpenApiOperation>> & {
  summary?:     string;
  description?: string;
  parameters?:  OpenApiParameter[];
};

export interface OpenApiComponents {
  schemas?:         Record<string, OpenApiSchema>;
  responses?:       Record<string, OpenApiResponse>;
  parameters?:      Record<string, OpenApiParameter>;
  securitySchemes?: Record<string, {
    type:          string;
    scheme?:       string;
    bearerFormat?: string;
    description?:  string;
    name?:         string;
    in?:           string;
    flows?:        Record<string, unknown>;
  }>;
}

export interface OpenApiSpec {
  openapi:    string;
  info: {
    title:        string;
    version:      string;
    description?: string;
    contact?:     { name?: string; url?: string; email?: string };
    license?:     { name: string; url?: string };
  };
  servers?:    { url: string; description?: string }[];
  tags?:       { name: string; description?: string }[];
  components?: OpenApiComponents;
  security?:   Record<string, string[]>[];
  paths:       Record<string, OpenApiPath>;
}

// ── Canonical runtime spec ───────────────────────────────────────
// Production installs only server dependencies. Runtime documentation is the
// validated snapshot generated from docs/api/openapi.yaml, so /api/docs does
// not depend on an undeclared swagger-jsdoc package at process startup.
function asOpenApiSpec(value: unknown): OpenApiSpec {
  if (!value || typeof value !== 'object') throw new Error('Generated OpenAPI snapshot is not an object');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.openapi !== 'string' || !candidate.info || typeof candidate.info !== 'object' || !candidate.paths || typeof candidate.paths !== 'object') {
    throw new Error('Generated OpenAPI snapshot is missing required openapi/info/paths fields');
  }
  return value as unknown as OpenApiSpec;
}

const BASE_SPEC: OpenApiSpec = asOpenApiSpec(runtimeSpec);

// ── Oturum C: $ref resolver ─────────────────────────────────────
// spec içindeki '#/components/...' referanslarını çözümleyip
// gerçek şema nesnesini döndürür. Bilinmeyen ref'ler undefined döner.
//
// KISITLAMA: Yalnızca JSON Pointer tabanlı local ref'leri (#/ ile başlayan)
// çözümler. HTTP ref'leri (https://...) ve harici dosya ref'leri
// (./schemas/user.yaml) desteklenmez — sessizce undefined döner.
// Sprint 83 hedefi: harici ref desteği (openapi-dereference kütüphanesi
// entegrasyonu veya custom loader).

export function resolveRef(
  spec: OpenApiSpec,
  ref: string,
): OpenApiSchema | OpenApiResponse | OpenApiParameter | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let node: unknown = spec;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as OpenApiSchema | OpenApiResponse | OpenApiParameter | undefined;
}

// ── Oturum C: operationId otomasyonu ────────────────────────────
// Eksik operationId'leri path + HTTP method'dan türetir.
// Örnek: GET /servers/{id}/channels → getServersByIdChannels
//
// Kural:
//   1. Her path segment'i camelCase'e dönüştürülür.
//   2. {param} segmentleri "ById" (ilk parametre) veya "By{Param}" olarak eklenir.
//   3. method prefix olarak eklenir.
//
// Mevcut operationId varsa dokunulmaz.

export function deriveOperationId(method: string, pathStr: string): string {
  const segments = pathStr.split('/').filter(Boolean);
  let result = '';
  for (const seg of segments) {
    const paramMatch = seg.match(/^\{(.+)\}$/);
    if (paramMatch) {
      const param = paramMatch[1]!;
      // _id → ById, serverId → ByServerId
      const normalized = param === 'id' ? 'ById' : `By${param.charAt(0).toUpperCase()}${param.slice(1)}`;
      result += normalized;
    } else {
      // kebab-case veya snake_case → camelCase segment
      const words = seg.split(/[-_]/);
      result += words
        .map((w, i) => i === 0 && result === ''
          ? w.toLowerCase()
          : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('');
    }
  }
  const prefix = method.toLowerCase();
  if (!result) return prefix;
  return prefix + result.charAt(0).toUpperCase() + result.slice(1);
}

export function ensureOperationIds(spec: OpenApiSpec): OpenApiSpec {
  const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  const seen = new Set<string>();

  // Mevcut operationId'leri topla — çakışma önlemek için
  for (const pathItem of Object.values(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op?.operationId) seen.add(op.operationId);
    }
  }

  const patched: Record<string, OpenApiPath> = {};
  for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
    const patchedPath: OpenApiPath = { ...pathItem };
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (op.operationId) { continue; }

      const candidate = deriveOperationId(method, pathStr);
      // Çakışma varsa sayaç ekle
      let suffix = 2;
      let unique = candidate;
      while (seen.has(unique)) { unique = `${candidate}${suffix++}`; }
      seen.add(unique);
      patchedPath[method] = { ...op, operationId: unique };
    }
    patched[pathStr] = patchedPath;
  }
  return { ...spec, paths: patched };
}

// ── Oturum C: spec validasyonu ───────────────────────────────────
// CI'da veya geliştirme sırasında uyarı üretir. Bloklayıcı değil.

export interface SpecWarning {
  level: 'warn' | 'error';
  path:  string;
  message: string;
}

export function validateSpec(spec: OpenApiSpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  const definedTags = new Set((spec.tags ?? []).map(t => t.name));
  const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

  if (Object.keys(spec.paths).length === 0) {
    warnings.push({ level: 'warn', path: 'paths', message: 'Spec boş — route annotation\'ları yüklenmedi.' });
  }

  for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const loc = `${method.toUpperCase()} ${pathStr}`;

      // Tanımsız tag kullanımı
      for (const tag of op.tags ?? []) {
        if (!definedTags.has(tag)) {
          warnings.push({ level: 'warn', path: loc, message: `Tanımsız tag: "${tag}"` });
        }
      }

      // Yanıt $ref kontrolü
      for (const [code, resp] of Object.entries(op.responses ?? {})) {
        if ('$ref' in resp && typeof resp.$ref === 'string') {
          if (!resolveRef(spec, resp.$ref)) {
            warnings.push({ level: 'error', path: `${loc} responses[${code}]`, message: `Çözülemeyen $ref: ${resp.$ref}` });
          }
        }
      }

      // requestBody şema $ref kontrolü
      for (const mediaType of Object.values(op.requestBody?.content ?? {})) {
        const schema = mediaType.schema;
        if (schema && '$ref' in schema && typeof schema.$ref === 'string') {
          if (!resolveRef(spec, schema.$ref)) {
            warnings.push({ level: 'error', path: `${loc} requestBody`, message: `Çözülemeyen $ref: ${schema.$ref}` });
          }
        }
      }
    }
  }

  return warnings;
}

// ── Deterministic canonical spec ─────────────────────────────────
function buildSpec(): OpenApiSpec {
  // ensureOperationIds returns a new paths object, keeping the imported JSON
  // immutable for tests and for any code retaining BASE_SPEC.
  return ensureOperationIds(BASE_SPEC);
}

// ── Spec cache (process başına bir kez üretilir) ─────────────────
let _spec: OpenApiSpec | null = null;

export function getSpec(): OpenApiSpec {
  if (!_spec) _spec = buildSpec();
  return _spec;
}

export function invalidateSpec(): void {
  _spec = null;
}

// ── Swagger UI Router ────────────────────────────────────────────
const swaggerRouter = express.Router();

// Ham spec JSON (CI validation, harici araçlar için)
swaggerRouter.get('/spec.json', (_req, res) => {
  res.json(getSpec());
});

// Oturum C: spec doğrulama endpoint'i (dev only)
if (process.env['NODE_ENV'] !== 'production') {
  swaggerRouter.get('/spec/validate', (_req, res) => {
    const warnings = validateSpec(getSpec());
    const errors   = warnings.filter(w => w.level === 'error');
    res.status(errors.length > 0 ? 422 : 200).json({
      ok:       errors.length === 0,
      warnings: warnings.filter(w => w.level === 'warn'),
      errors,
    });
  });

  swaggerRouter.post('/spec/refresh', (_req, res) => {
    invalidateSpec();
    res.json({ ok: true, message: 'Spec cache temizlendi.' });
  });
}

try {
  swaggerRouter.use('/', swaggerUi.serve);
  swaggerRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
    return swaggerUi.setup(getSpec(), {
      customSiteTitle: 'Bridge API Docs',
      customCss: `
        .swagger-ui .topbar { background: #2d9cdb; }
        .swagger-ui .topbar-wrapper img { display: none; }
        .swagger-ui .topbar-wrapper::before { content: '🌉 Bridge API'; color: white; font-size: 1.4em; font-weight: bold; }
      `,
      swaggerOptions: {
        persistAuthorization: true,
        url: '/api/docs/spec.json',
      },
    })(req, res, next);
  });
} catch {
  swaggerRouter.get('/', (_req, res: Response) => {
    res.send('<h2>Swagger UI yüklü değil</h2><p>npm install swagger-ui-express</p><p><a href="spec.json">spec.json\'u görüntüle</a></p>');
  });
}

export { swaggerRouter, BASE_SPEC };
