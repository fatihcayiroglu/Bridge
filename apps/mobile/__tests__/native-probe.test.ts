import { nativeProbe } from '../src/network';

afterEach(() => jest.restoreAllMocks());

const request = {
  method: 'GET' as const,
  redirect: 'error' as const,
  credentials: 'omit' as const,
  signal: new AbortController().signal,
};

test('accepts a response only for the requested public liveness endpoint', async () => {
  const url = 'https://chat.example/api/health/live';
  const response = new Response(
    JSON.stringify({ status: 'ok', check: 'liveness' }),
  );
  Object.defineProperty(response, 'url', { value: url });
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  expect(await nativeProbe(url, request)).toBe(response);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(url, request);
});

test.each([
  '',
  'https://another.example/api/health/live',
  'https://chat.example/wrong-path',
])(
  'does not accept a response with an absent or different final URL: %s',
  async finalUrl => {
    const response = new Response('{}');
    Object.defineProperty(response, 'url', { value: finalUrl });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(
      nativeProbe('https://chat.example/api/health/live', request),
    ).rejects.toThrow('Server response target could not be verified');
  },
);

test('rejects a redirect chain even when its final URL returns to the requested endpoint', async () => {
  const url = 'https://chat.example/api/health/live';
  const response = new Response('{}');
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: true });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  await expect(nativeProbe(url, request)).rejects.toThrow(
    'Server response target could not be verified',
  );
});
