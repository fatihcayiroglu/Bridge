export function requireDisposable(env) {
  let url;
  try { url = new URL(env.PG_TEST_URL); } catch { throw Error('DISPOSABLE_CI_DATABASE_REQUIRED'); }
  if (env.GITHUB_ACTIONS !== 'true' || env.BRIDGE_PERF_DISPOSABLE !== '1' ||
      url.protocol !== 'postgresql:' || url.search || url.hash ||
      !['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/bridge_perf_[a-z0-9_]+$/.test(url.pathname)) {
    throw Error('DISPOSABLE_CI_DATABASE_REQUIRED');
  }
  return url.href;
}
