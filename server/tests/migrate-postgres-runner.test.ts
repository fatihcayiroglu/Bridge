const mockClient = {
  connect: jest.fn(), query: jest.fn(), end: jest.fn(),
};
const mockClientCtor = jest.fn((..._args: unknown[]) => mockClient);
const mockFs = {
  readdirSync: jest.fn(), readFileSync: jest.fn(), existsSync: jest.fn(),
};

jest.mock('pg', () => ({ Client: function MockClient(...args: unknown[]) { return mockClientCtor(...args); } }));
jest.mock('fs', () => ({ __esModule: true, default: mockFs }));

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };
let stdout: jest.SpyInstance;
let stderr: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('migration runner did not settle');
}

function baseQuery(applied: string[] = []) {
  mockClient.query.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('SELECT id FROM schema_migrations')) return { rows: applied.map(id => ({ id })) };
    return { rows: [] };
  });
}

function run(command: string, steps?: string): void {
  jest.resetModules();
  process.argv = ['node', 'migrate-postgres.js', command, ...(steps ? [steps] : [])];
  process.env = { ...originalEnv, DATABASE_URL: 'postgres://bridge@test/bridge' };
  require('../db/migrate-postgres');
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.exitCode;
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.end.mockResolvedValue(undefined);
  mockFs.readdirSync.mockReturnValue(['002_second.sql', 'README.md', '001_first.sql']);
  mockFs.readFileSync.mockImplementation((file: unknown) => `SQL:${String(file).split(/[\\/]/).pop()}`);
  mockFs.existsSync.mockReturnValue(true);
  stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  stdout.mockRestore(); stderr.mockRestore(); exitSpy.mockRestore();
  process.argv = [...originalArgv]; process.env = { ...originalEnv }; delete process.exitCode;
});

afterAll(() => { process.argv = originalArgv; process.env = originalEnv; });

describe('PostgreSQL migration runner executable contract', () => {
  it('status sorts migrations, reports applied/pending truth and closes the client', async () => {
    baseQuery(['001_first.sql']);
    run('status');
    await settleUntil(() => mockClient.end.mock.calls.length === 1);

    expect(mockClientCtor).toHaveBeenCalledWith({ connectionString: 'postgres://bridge@test/bridge' });
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls.map(c => String(c[0])).join('');
    expect(output.indexOf('001_first.sql')).toBeLessThan(output.indexOf('002_second.sql'));
    expect(output).toContain('applied');
    expect(output).toContain('pending');
    expect(output).toContain('Toplam: 2');
  });

  it('up skips already-applied files and commits each pending migration with durable metadata', async () => {
    baseQuery(['001_first.sql']);
    run('up');
    await settleUntil(() => mockClient.end.mock.calls.length === 1);

    expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
    expect(String(mockFs.readFileSync.mock.calls[0]![0])).toContain('002_second.sql');
    const sqls = mockClient.query.mock.calls.map(c => String(c[0]));
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('SQL:002_second.sql');
    expect(sqls.some(s => s.includes('INSERT INTO schema_migrations'))).toBe(true);
    expect(sqls).toContain('COMMIT');
    expect(stdout.mock.calls.map(c => String(c[0])).join('')).toContain('Migration tamamlandı. (1 yeni)');
  });

  it('up rolls back a failed migration and surfaces the canonical SQL error', async () => {
    const failure = new Error('DDL exploded');
    mockClient.query.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('SELECT id FROM schema_migrations')) return { rows: [] };
      if (text === 'SQL:001_first.sql') throw failure;
      return { rows: [] };
    });
    run('up');
    await settleUntil(() => exitSpy.mock.calls.length > 0);

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('Failed: 001_first.sql');
    expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('DDL exploded');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('down rolls back only the newest applied migration and marks it rolled back atomically', async () => {
    baseQuery(['001_first.sql', '002_second.sql']);
    run('down');
    await settleUntil(() => mockClient.end.mock.calls.length === 1);

    expect(mockFs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('002_second.down.sql'), 'utf8');
    const update = mockClient.query.mock.calls.find(c => String(c[0]).includes('UPDATE schema_migrations'));
    expect(update?.[1]).toEqual(['002_second.sql']);
    expect(mockClient.query.mock.calls.map(c => String(c[0]))).toContain('COMMIT');
    expect(stdout.mock.calls.map(c => String(c[0])).join('')).toContain('Rollback tamamlandı. (1 migration geri alındı)');
  });

  it('rollback N is newest-first and fail-closes when the next DOWN script is missing', async () => {
    baseQuery(['001_first.sql', '002_second.sql']);
    mockFs.existsSync.mockImplementation((file: unknown) => !String(file).endsWith('002_second.down.sql'));
    run('rollback', '2');
    await settleUntil(() => process.exitCode === 1);

    expect(mockClient.end).toHaveBeenCalledTimes(1);
    expect(mockClient.query.mock.calls.some(c => String(c[0]) === 'BEGIN')).toBe(false);
    expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('DOWN script yok');
  });

  it('reports a no-op cleanly when all migrations are already applied', async () => {
    baseQuery(['001_first.sql', '002_second.sql']);
    run('up');
    await settleUntil(() => mockClient.end.mock.calls.length === 1);
    expect(mockFs.readFileSync).not.toHaveBeenCalled();
    expect(stdout.mock.calls.map(c => String(c[0])).join('')).toContain('Uygulanacak migration yok');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
