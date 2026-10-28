import { clearRefreshCookie, setRefreshCookie } from '../lib/authCookies';

describe('canonical refresh cookie contract', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldBaseUrl = process.env.BASE_URL;
  afterEach(() => {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldBaseUrl === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = oldBaseUrl;
  });

  it('keeps browser refresh tokens httpOnly, same-site strict, and path scoped', () => {
    process.env.NODE_ENV = 'test';
    process.env.BASE_URL = 'http://127.0.0.1:3000';
    const cookie = jest.fn();
    setRefreshCookie({ cookie } as never, 'opaque-refresh');
    expect(cookie).toHaveBeenCalledWith('bridge_refresh', 'opaque-refresh', expect.objectContaining({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api/refresh',
    }));
  });

  it('uses secure cookies in production and clears the same path', () => {
    process.env.NODE_ENV = 'production';
    process.env.BASE_URL = 'http://127.0.0.1:3000';
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    setRefreshCookie({ cookie } as never, 'opaque-refresh');
    clearRefreshCookie({ clearCookie } as never);
    expect(cookie.mock.calls[0][2].secure).toBe(true);
    expect(clearCookie).toHaveBeenCalledWith('bridge_refresh', expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'strict', path: '/api/refresh',
    }));
  });

  it.each(['development', 'staging'])('keeps refresh cookies Secure on configured HTTPS in %s', nodeEnv => {
    process.env.NODE_ENV = nodeEnv;
    process.env.BASE_URL = 'https://127.0.0.1:8443';
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    setRefreshCookie({ cookie } as never, 'opaque-refresh');
    clearRefreshCookie({ clearCookie } as never);
    expect(cookie).toHaveBeenCalledWith('bridge_refresh', 'opaque-refresh', expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'strict', path: '/api/refresh',
    }));
    expect(clearCookie).toHaveBeenCalledWith('bridge_refresh', expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'strict', path: '/api/refresh',
    }));
  });
});
