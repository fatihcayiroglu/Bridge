import pino from 'pino';
import logger from '../../lib/logger';

/** Observe actual Pino serialization after production serializers and the ALS mixin. */
export function captureActualLogRecords() {
  const records: Array<Record<string, unknown>> = [];
  const destination = Reflect.get(logger, pino.symbols.streamSym) as { write(line: string): unknown };
  const writer = jest.spyOn(destination, 'write').mockImplementation((line: string) => {
    records.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { records, restore: () => writer.mockRestore() };
}
