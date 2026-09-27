// electron/tests/updater-install.test.ts
//
// Final21 Faz 19 — indirilen güncelleme SESSİZ kurulur ve uygulama yeniden açılır.
// Kanıt (kurulu uygulamayla, gerçek besleme): tools/desktop-update-lifecycle.mjs P5 — sihirbaz kipinde
// kurucu "Bu uygulama kimler için kurulsun?" sayfasında kullanıcıyı bekliyordu.

import fs from 'fs';
import os from 'os';
import path from 'path';

const RESOURCES = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-updater-'));
fs.writeFileSync(path.join(RESOURCES, 'app-update.yml'),
  'provider: generic\nurl: https://updates.bridge.example/\npublisherName:\n  - Bridge Contributors\n');
const savedForce = process.env.BRIDGE_UPDATER_FORCE;
const savedResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
process.env.BRIDGE_UPDATER_FORCE = 'true';
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true, writable: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { autoUpdater } = require('electron-updater') as { autoUpdater: { emit: (e: string, ...a: unknown[]) => void; quitAndInstall: jest.Mock } };
import { getUpdatePolicy, installDownloadedUpdate, setupBridgeAutoUpdater, teardownBridgeAutoUpdater } from '../updater';

beforeAll(() => {
  jest.useFakeTimers();
  setupBridgeAutoUpdater(() => null);
});
afterAll(() => {
  teardownBridgeAutoUpdater();
  jest.useRealTimers();
  fs.rmSync(RESOURCES, { recursive: true, force: true });
  if (savedForce === undefined) delete process.env.BRIDGE_UPDATER_FORCE; else process.env.BRIDGE_UPDATER_FORCE = savedForce;
  Object.defineProperty(process, 'resourcesPath', { value: savedResources, configurable: true, writable: true });
});

it('test ortamında güncelleyici imzalı besleme ile ETKİN', () => {
  expect(getUpdatePolicy()).toEqual({ enabled: true, signed: true });
});

it('indirilmiş güncelleme yokken kurulum İSTENMEZ', () => {
  const state = installDownloadedUpdate();
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect(state.canInstall).toBe(false);
});

it('indirilen güncelleme SESSİZ kurulur ve uygulama kendiliğinden yeniden açılır', () => {
  autoUpdater.emit('update-downloaded', { version: '1.125.1' });
  installDownloadedUpdate();
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
});
