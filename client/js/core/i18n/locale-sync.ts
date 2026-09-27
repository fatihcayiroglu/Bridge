// client/js/core/i18n/locale-sync.ts
//
// Tell the server which language this person reads (Final21 Phase 16).
//
// Everything the server writes to a person — push notification titles — used to be Turkish for
// every reader, because nothing carried the reader's locale to the server. The client picks the
// locale; this reports it so `server/lib/serverLocale.ts` can write in that language.
//
// Best effort by design: a failure here changes WORDING of a future push, never the product.

import { readToken } from '../auth-compat.js';
import { apiFetch } from '../api-fetch.js';
import { getAPI } from '../globals.js';
import { createLogger } from '../logger.js';

const log = createLogger('LocaleSync');

/** The last value actually accepted by the server, so a locale is reported once. */
let reported: string | null = null;

/** Reset between tests and on logout: the next person may read another language. */
export function resetReportedLocale(): void { reported = null; }

export async function reportLocaleToServer(locale: string): Promise<'skipped' | 'sent' | 'failed'> {
  if (!locale || locale === reported) return 'skipped';
  // Before sign-in there is nobody to store it for; `bridge:auth-success` reports it again.
  if (!readToken()) return 'skipped';
  try {
    const response = await apiFetch(`${getAPI()}/api/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
    if (!response.ok) { log.warn('Dil sunucuya bildirilemedi', { status: response.status }); return 'failed'; }
    reported = locale;
    return 'sent';
  } catch (error) {
    log.warn('Dil sunucuya bildirilemedi', error);
    return 'failed';
  }
}
