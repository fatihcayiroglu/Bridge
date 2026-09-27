import { clearRefreshCookie, setRefreshCookie } from '../lib/authCookies';

describe('canonical refresh cookie contract', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = oldNodeEnv; });

  it('keeps browser refresh tokens httpOnly, same-site strict, and path scoped', () => {
    process.env.NODE_ENV = 'test';
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
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    setRefreshCookie({ cookie } as never, 'opaque-refresh');
    clearRefreshCookie({ clearCookie } as never);
    expect(cookie.mock.calls[0][2].secure).toBe(true);
    expect(clearCookie).toHaveBeenCalledWith('bridge_refresh', expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'strict', path: '/api/refresh',
    }));
  });
});
