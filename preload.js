'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sakinah', {
  win: {
    minimize: () => ipcRenderer.send('win:min'),
    maximizeToggle: () => ipcRenderer.send('win:max'),
    close: () => ipcRenderer.send('win:close'),
    onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(v)),
  },
  detectLocation: () => ipcRenderer.invoke('detect-location'),
  fetchPrayerTimes: (payload) => ipcRenderer.invoke('fetch-prayer-times', payload),
  syncSchedule: (list) => ipcRenderer.invoke('sync-schedule', list),
  clearSchedule: () => ipcRenderer.invoke('clear-schedule'),
  syncReminders: (enabled) => ipcRenderer.invoke('sync-reminders', enabled),
  testNotification: () => ipcRenderer.invoke('test-notification'),
  onTrayCommand: (cb) => ipcRenderer.on('tray:reminders', (_e, v) => cb(v)),
});
