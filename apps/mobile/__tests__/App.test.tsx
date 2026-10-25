import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  userEvent,
} from '@testing-library/react-native';
import App from '../App';
import * as ReactNative from 'react-native';

afterEach(() => jest.restoreAllMocks());
import type { ProbeTransport } from '@bridge/core';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });

test('native connect screen verifies the real public protocol contract without sending credentials', async () => {
  const transport = jest
    .fn<ReturnType<ProbeTransport>, Parameters<ProbeTransport>>()
    .mockResolvedValue(reply({ status: 'ok', check: 'liveness' }));
  await render(<App transport={transport} />);
  await fireEvent.changeText(
    screen.getByLabelText('Server address'),
    'chat.example.com/path',
  );
  await userEvent.press(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByTestId('connection-success')).toHaveTextContent(
    'Server verified',
  );
  expect(transport).toHaveBeenCalledWith(
    'https://chat.example.com/api/health/live',
    expect.objectContaining({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
    }),
  );
});

test('rejects an insecure remote server before transport and preserves private failure details', async () => {
  const transport = jest
    .fn<ReturnType<ProbeTransport>, Parameters<ProbeTransport>>()
    .mockResolvedValue(reply({ privateToken: 'must-not-appear' }, false));
  await render(<App transport={transport} />);
  await fireEvent.changeText(
    screen.getByLabelText('Server address'),
    'http://remote.example',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Use HTTPS to protect your connection.',
  );
  expect(transport).not.toHaveBeenCalled();
  await fireEvent.changeText(
    screen.getByLabelText('Server address'),
    'https://remote.example',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This address did not return a Bridge liveness response.',
  );
  expect(screen.queryByText(/must-not-appear/)).toBeNull();
});

test('editing the native server input cancels an old probe and prevents stale success', async () => {
  let finish!: (value: Awaited<ReturnType<ProbeTransport>>) => void;
  const transport = jest
    .fn<ReturnType<ProbeTransport>, Parameters<ProbeTransport>>()
    .mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
  await render(<App transport={transport} />);
  await fireEvent.changeText(
    screen.getByLabelText('Server address'),
    'https://old.example',
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  const signal = transport.mock.calls[0]![1].signal;
  await fireEvent.changeText(
    screen.getByLabelText('Server address'),
    'https://new.example',
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish(reply({ status: 'ok', check: 'liveness' }));
  });
  expect(screen.queryByTestId('connection-success')).toBeNull();
  expect(screen.getByLabelText('Server address')).toHaveDisplayValue(
    'https://new.example',
  );
});

test('the dark native form submits from the keyboard through the real runtime adapter', async () => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');
  const url = 'https://chat.example.com/api/health/live';
  const response = new Response(
    JSON.stringify({ status: 'ok', check: 'liveness' }),
  );
  Object.defineProperty(response, 'url', { value: url });
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  await render(<App />);
  const input = screen.getByLabelText('Server address');
  await fireEvent.changeText(input, 'HTTPS://Chat.Example.com:443/path');
  await fireEvent(input, 'submitEditing', {
    nativeEvent: { text: 'HTTPS://Chat.Example.com:443/path' },
  });
  expect(await screen.findByTestId('connection-success')).toHaveTextContent(
    'Server verified',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    url,
    expect.objectContaining({ credentials: 'omit' }),
  );
});
