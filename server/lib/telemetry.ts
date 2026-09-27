// server/lib/telemetry.ts
// OpenTelemetry tracer + Sentry entegrasyonu
//
// External secrets are hydrated by server/index.ts first; server/runtime.ts
// imports telemetry before the rest of the production runtime graph.
//
// OTel SDK'yı diğer modüllerden ÖNCE init etmek zorunludur (auto-instrumentation için).

import logger from './logger';
import { tryRequire } from './_optional-require';
import { envSafeNumber } from './envNumbers';
import { BRIDGE_VERSION } from './version';

// ── Tip tanımları (opsiyonel bağımlılıklar için) ────────────────────────────

type OtelSDK = {
  start(): void;
  shutdown(): Promise<void>;
};

type NodeSDKModule = { NodeSDK: new (opts: Record<string, unknown>) => OtelSDK };
type OTLPExporterModule = { OTLPTraceExporter: new (opts: Record<string, unknown>) => unknown };
type ResourceModule = { Resource: new (attrs: Record<string, string>) => unknown };
type SemConvModule = Record<string, string>;
type AutoInstrModule = { getNodeAutoInstrumentations: (cfg?: Record<string, unknown>) => unknown[] };
type OtelApiModule = {
  trace: {
    getTracer(name: string): {
      startSpan(name: string, opts?: Record<string, unknown>): {
        setAttributes(a: Record<string, string>): void;
        end(): void;
      };
    };
  };
};
type SentryModule = {
  init(opts: Record<string, unknown>): void;
  captureException(err: unknown): void;
  flush?(timeout?: number): Promise<boolean>;
};

// ── Ortam değişkenleri ──────────────────────────────────────────────────────

const OTEL_ENABLED   = process.env.OTEL_ENABLED !== 'false' && !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SENTRY_ENABLED = !!process.env.SENTRY_DSN;
const SERVICE_NAME   = process.env.OTEL_SERVICE_NAME || 'bridge';
const SERVICE_VERSION = BRIDGE_VERSION;
const ENVIRONMENT    = process.env.NODE_ENV || 'development';

// ── OTel başlatma ───────────────────────────────────────────────────────────

let sdk: OtelSDK | null = null;
let sentrySdk: SentryModule | null = null;

function initOpenTelemetry(): void {
  if (!OTEL_ENABLED) {
    logger.info({ otel: false }, 'OTel devre dışı (OTEL_EXPORTER_OTLP_ENDPOINT tanımlı değil)');
    return;
  }

  const nodeSdkMod   = tryRequire<NodeSDKModule>('@opentelemetry/sdk-node');
  const exporterMod  = tryRequire<OTLPExporterModule>('@opentelemetry/exporter-trace-otlp-http');
  const resourceMod  = tryRequire<ResourceModule>('@opentelemetry/resources');
  const semConvMod   = tryRequire<SemConvModule>('@opentelemetry/semantic-conventions');
  const autoInstMod  = tryRequire<AutoInstrModule>('@opentelemetry/auto-instrumentations-node');

  if (!nodeSdkMod || !exporterMod || !resourceMod || !semConvMod || !autoInstMod) {
    logger.warn({ otel: false }, 'OTel paketleri eksik — tracing devre dışı');
    return;
  }

  try {
    const { NodeSDK }                = nodeSdkMod;
    const { OTLPTraceExporter }      = exporterMod;
    const { Resource }               = resourceMod;
    const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = semConvMod;
    // OpenTelemetry bu sabitleri surumden surume yeniden adlandirdi. Modul
    // bunlari vermiyorsa hesaplanan anahtar `undefined` olur ve kaynak
    // (resource) SESSIZCE bozulur. Kanonik oznitelik adlarina duserek hem
    // tip guvenligi hem de calisma zamani dayanikliligi saglanir.
    const serviceNameKey =
      typeof SEMRESATTRS_SERVICE_NAME === 'string' ? SEMRESATTRS_SERVICE_NAME : 'service.name';
    const serviceVersionKey =
      typeof SEMRESATTRS_SERVICE_VERSION === 'string' ? SEMRESATTRS_SERVICE_VERSION : 'service.version';
    const { getNodeAutoInstrumentations } = autoInstMod;

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? Object.fromEntries(
            process.env.OTEL_EXPORTER_OTLP_HEADERS
              .split(',')
              .map(h => h.trim().split('=') as [string, string])
          )
        : {},
    });

    sdk = new NodeSDK({
      resource: new Resource({
        [serviceNameKey]:    SERVICE_NAME,
        [serviceVersionKey]: SERVICE_VERSION,
        'deployment.environment':      ENVIRONMENT,
      }),
      traceExporter: exporter,
      instrumentations: getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false }, // gürültülü
      }),
    });

    sdk.start();

    logger.info(
      { otel: true, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT, service: SERVICE_NAME },
      'OpenTelemetry başlatıldı'
    );
  } catch (err) {
    logger.warn({ err }, 'OTel başlatma başarısız — tracing devre dışı');
  }
}

// ── Sentry başlatma ─────────────────────────────────────────────────────────

function initSentry(): void {
  if (!SENTRY_ENABLED) {
    logger.info({ sentry: false }, 'Sentry devre dışı (SENTRY_DSN tanımlı değil)');
    return;
  }

  const Sentry = tryRequire<SentryModule>('@sentry/node');
  if (!Sentry) {
    logger.warn({ sentry: false }, '"@sentry/node" paketi yüklü değil — Sentry devre dışı');
    return;
  }

  try {
    Sentry.init({
      dsn:         process.env.SENTRY_DSN,
      environment: ENVIRONMENT,
      release:     process.env.SENTRY_RELEASE?.trim() || `${SERVICE_NAME}@${SERVICE_VERSION}`,
      tracesSampleRate: envSafeNumber('SENTRY_TRACES_SAMPLE_RATE', 0.1, { min: 0, max: 1 }),
      // Authentication/session material must never leave the process via
      // automatic request context capture.
      beforeSend(event: Record<string, unknown>) {
        if (event.request && typeof event.request === 'object') {
          const request = event.request as Record<string, unknown>;
          delete request.cookies;
          if (request.headers && typeof request.headers === 'object') {
            const headers = request.headers as Record<string, unknown>;
            for (const key of Object.keys(headers)) {
              if (['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'].includes(key.toLowerCase())) {
                delete headers[key];
              }
            }
          }
        }
        return event;
      },
      // OTel aktifse Sentry trace'lerini OTel üzerinden yönlendir
      integrations: OTEL_ENABLED ? [] : undefined,
    });
    sentrySdk = Sentry;

    logger.info({ sentry: true }, 'Sentry başlatıldı');
  } catch (err) {
    logger.warn({ err }, 'Sentry başlatma başarısız');
  }
}

// ── metrics.ts entegrasyonu ──────────────────────────────────────────────────
//
// metrics.ts Prometheus tabanlı; OTel ile çakışmaz.
// Her ikisi de aynı anda aktif olabilir.
// OTel span'ları otomatik olarak HTTP istek metriklerini de kapsar.

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
      logger.info({}, 'OTel SDK kapatıldı');
    } catch (err) {
      logger.warn({ err }, 'OTel SDK kapatma hatası');
    }
  }
  if (sentrySdk?.flush) {
    try {
      await sentrySdk.flush(2_000);
    } catch (err) {
      logger.warn({ err }, 'Sentry flush başarısız');
    }
  }
}

// SIGTERM/SIGINT'te temiz kapat. Jest isolateModules/resetModules gibi
// senaryolarda bu dosya tekrar import edilse bile process listener'ı çoğaltma.
const telemetrySignalHookKey = Symbol.for('bridge.telemetry.signalHookRegistered');
const telemetrySignalState = globalThis as typeof globalThis & { [telemetrySignalHookKey]?: boolean };
if (!telemetrySignalState[telemetrySignalHookKey]) {
  process.on('SIGTERM', () => { shutdownTelemetry().catch(() => {}); });
  process.on('SIGINT',  () => { shutdownTelemetry().catch(() => {}); });
  telemetrySignalState[telemetrySignalHookKey] = true;
}

// ── Init ─────────────────────────────────────────────────────────────────────
// Bu dosya import edildiği anda başlatır.
// server/runtime.ts'de diğer production-runtime import'larından ÖNCE gelmelidir.

initOpenTelemetry();
initSentry();

// Manuel kullanım için export
export { shutdownTelemetry, announceSpan };

/**
 * Basit span oluşturucu — route handler'larda kullanılabilir
 *
 * @example
 *   const span = announceSpan('db.query', { 'db.statement': sql });
 *   try { ... } finally { span.end(); }
 */
function announceSpan(name: string, attributes: Record<string, string> = {}): { end(): void } {
  if (!OTEL_ENABLED) return { end() {} };
  const otelApi = tryRequire<OtelApiModule>('@opentelemetry/api');
  if (!otelApi) return { end() {} };
  try {
    const tracer = otelApi.trace.getTracer(SERVICE_NAME);
    const span   = tracer.startSpan(name);
    span.setAttributes(attributes);
    return span;
  } catch {
    return { end() {} };
  }
}
