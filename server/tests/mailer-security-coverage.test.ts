const mockCreateTransport = jest.fn();
const mockInfo = jest.fn();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: (...args: unknown[]) => mockCreateTransport(...args) },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: (...args: unknown[]) => mockInfo(...args), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Mailer = typeof import('../lib/mailer');
const originalEnv = { ...process.env };

function loadMailer(env: Record<string, string | undefined>): Mailer {
  jest.resetModules();
  process.env = { ...originalEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return require('../lib/mailer') as Mailer;
}

afterAll(() => { process.env = originalEnv; });
beforeEach(() => { mockCreateTransport.mockReset(); mockInfo.mockReset(); });

describe('mailer production/security behavior', () => {
  it('builds the configured SMTP transport once and escapes verification/reset identities and tokens', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'smtp-1' });
    mockCreateTransport.mockReturnValue({ sendMail });
    const mailer = loadMailer({
      NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '2525', SMTP_SECURE: 'true',
      SMTP_USER: 'bridge-user', SMTP_PASS: 'secret', SMTP_FROM: 'Bridge <mail@example.com>',
      INSTANCE_URL: 'https://bridge.example.com',
    });

    await mailer.sendVerificationEmail('u@example.com', 'a&b?c', '<img src=x onerror=alert(1)>');
    await mailer.sendPasswordResetEmail('u@example.com', 'reset/+ token', '<script>bad()</script>');

    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.com', port: 2525, secure: true,
      auth: { user: 'bridge-user', pass: 'secret' },
    }));
    expect(sendMail).toHaveBeenCalledTimes(2);

    const verify = sendMail.mock.calls[0]![0] as { from: string; html: string };
    expect(verify.from).toBe('Bridge <mail@example.com>');
    expect(verify.html).toContain('a%26b%3Fc');
    expect(verify.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(verify.html).not.toContain('<img src=x onerror=alert(1)>');

    const reset = sendMail.mock.calls[1]![0] as { html: string };
    expect(reset.html).toContain('reset%2F%2B%20token');
    expect(reset.html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(reset.html).not.toContain('<script>bad()</script>');
  });

  it('escapes every user-controlled suspicious-login field before HTML delivery', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'smtp-2' });
    mockCreateTransport.mockReturnValue({ sendMail });
    const mailer = loadMailer({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' });

    await mailer.sendSuspiciousLoginAlert({
      to: 'u@example.com', username: '<b>User</b>', ip: '<img src=x>',
      userAgent: '<svg onload=alert(1)>', time: 'now & later',
    });

    const html = (sendMail.mock.calls[0]![0] as { html: string }).html;
    expect(html).toContain('&lt;b&gt;User&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('now &amp; later');
    expect(html).not.toContain('<svg onload=alert(1)>');
  });

  it('fails closed in production when SMTP authority is not configured', async () => {
    const mailer = loadMailer({ NODE_ENV: 'production', SMTP_HOST: undefined });
    await expect(mailer.sendVerificationEmail('u@example.com', 'secret-token', 'User'))
      .rejects.toThrow('SMTP_HOST is required');
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('keeps a non-network development transport without logging credential-bearing message bodies', async () => {
    const mailer = loadMailer({ NODE_ENV: 'test', SMTP_HOST: undefined });
    await expect(mailer.sendPasswordResetEmail('dev@example.com', 'TOP-SECRET-TOKEN', 'Dev')).resolves.toBeUndefined();
    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledTimes(1);
    const metadata = mockInfo.mock.calls[0]![0] as Record<string, unknown>;
    expect(metadata).toEqual(expect.objectContaining({ to: 'dev@example.com', event: 'mailer.dev.sent' }));
    expect(metadata).not.toHaveProperty('body');
    expect(JSON.stringify(mockInfo.mock.calls[0])).not.toContain('TOP-SECRET-TOKEN');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
