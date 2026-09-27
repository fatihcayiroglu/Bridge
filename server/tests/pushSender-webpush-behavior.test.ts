'use strict';

const sendNotification = jest.fn();
const setVapidDetails = jest.fn();
const assertUrlIsPublic = jest.fn();
const removePushSubscriptionWhere = jest.fn();
const loggerWarn = jest.fn();

jest.mock('web-push', () => ({
  __esModule: true,
  default: { sendNotification, setVapidDetails },
}), { virtual: true });
jest.mock('../lib/ssrfGuard', () => ({
  assertUrlIsPublic: (...args: unknown[]) => assertUrlIsPublic(...args),
}));
jest.mock('../db/repositories', () => ({
  Notifications: {
    removePushSubscriptionWhere: (...args: unknown[]) => removePushSubscriptionWhere(...args),
  },
  Members: {}, Channels: {}, Messages: {}, Dms: {},
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: (...args: unknown[]) => loggerWarn(...args), info: jest.fn() },
}));

describe('sendWebPush provider, SSRF, retry, and cleanup behavior', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.VAPID_PUBLIC_KEY = 'public-key';
    process.env.VAPID_PRIVATE_KEY = 'private-key';
    delete process.env.VAPID_SUBJECT;
    assertUrlIsPublic.mockResolvedValue(undefined);
    sendNotification.mockResolvedValue(undefined);
    removePushSubscriptionWhere.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    jest.useRealTimers();
  });

  it('loads the provider, configures the default VAPID subject, and sends serialized payload', async () => {
    const { sendWebPush } = require('../lib/pushSender') as typeof import('../lib/pushSender');
    const subscription = { endpoint: 'https://push.example.test/sub', keys: { p256dh: 'a', auth: 'b' } };
    await sendWebPush(subscription, { title: 'Bridge', body: 'hello', data: { channelId: 'c1' } });

    expect(setVapidDetails).toHaveBeenCalledWith('mailto:admin@bridge.app', 'public-key', 'private-key');
    expect(assertUrlIsPublic).toHaveBeenCalledWith(subscription.endpoint);
    expect(sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify({ title: 'Bridge', body: 'hello', data: { channelId: 'c1' } }),
    );
  });

  it('blocks a rebinding/private endpoint at send time before invoking the provider', async () => {
    assertUrlIsPublic.mockRejectedValueOnce(new Error('private address'));
    const { sendWebPush } = require('../lib/pushSender') as typeof import('../lib/pushSender');
    await expect(sendWebPush(
      { endpoint: 'https://127.0.0.1/push', keys: {} },
      { title: 'Bridge', body: 'blocked' },
    )).resolves.toBeUndefined();

    expect(sendNotification).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'push.webpush.blocked_ssrf', endpoint: 'https://127.0.0.1/push' }),
      expect.any(String),
    );
  });

  it.each([404, 410])('removes a terminal HTTP %s subscription without retrying', async (statusCode) => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode }));
    const { sendWebPush } = require('../lib/pushSender') as typeof import('../lib/pushSender');
    const endpoint = `https://push.example.test/${statusCode}`;
    await sendWebPush({ endpoint, keys: {} }, { title: 'Bridge', body: 'gone' });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(removePushSubscriptionWhere).toHaveBeenCalledWith({ endpoint }, { multi: false });
  });

  it('logs cleanup failure while keeping terminal delivery best-effort', async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    removePushSubscriptionWhere.mockRejectedValueOnce(new Error('database unavailable'));
    const { sendWebPush } = require('../lib/pushSender') as typeof import('../lib/pushSender');
    await sendWebPush(
      { endpoint: 'https://push.example.test/stale', keys: {} },
      { title: 'Bridge', body: 'gone' },
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'push.webpush.cleanup_failed', err: 'database unavailable' }),
      expect.any(String),
    );
  });

  it('retries transient provider failures with bounded backoff and eventually succeeds', async () => {
    jest.useFakeTimers();
    sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('still busy'), { status: 503 }))
      .mockResolvedValueOnce(undefined);
    const { sendWebPush } = require('../lib/pushSender') as typeof import('../lib/pushSender');
    const pending = sendWebPush(
      { endpoint: 'https://push.example.test/retry', keys: {} },
      { title: 'Bridge', body: 'retry' },
    );
    await jest.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(sendNotification).toHaveBeenCalledTimes(3);
    expect(removePushSubscriptionWhere).not.toHaveBeenCalled();
  });

  it('does not retry authentication/payload failures and logs the provider error', async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 401 }));
    const { sendWebPush } = require('../lib/pushSender') as typeof import('../lib/pushSender');
    await sendWebPush(
      { endpoint: 'https://push.example.test/auth', keys: {} },
      { title: 'Bridge', body: 'bad auth' },
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'push.webpush.failed', err: 'unauthorized' }),
      expect.any(String),
    );
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
