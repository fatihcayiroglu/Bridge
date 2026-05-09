// electron/preload.js
// Exposes a safe IPC bridge to renderer for native notifications + deep links

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronBridge', {
  // Send a native OS notification via main process
  notify: (title, body) => ipcRenderer.send('bridge:notify', { title, body }),

  // Listen for tray notification toggle
  onNotificationsToggle: (cb) => ipcRenderer.on('tray:notifications-toggle', (_, enabled) => cb(enabled)),
});

// Sunucu kontrol API'si
contextBridge.exposeInMainWorld('serverControl', {
  start:     ()   => ipcRenderer.send('server:start'),
  stop:      ()   => ipcRenderer.send('server:stop'),
  restart:   ()   => ipcRenderer.send('server:restart'),
  getStatus: ()   => ipcRenderer.invoke('server:getStatus'),
  onStatus:  (cb) => ipcRenderer.on('server:status', (_, data) => cb(data)),
  onLog:     (cb) => ipcRenderer.on('server:log',    (_, data) => cb(data)),
  offStatus: (cb) => ipcRenderer.removeListener('server:status', cb),
  offLog:    (cb) => ipcRenderer.removeListener('server:log',    cb),
});
