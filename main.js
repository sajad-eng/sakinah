'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'com.sakinah.app';
app.setAppUserModelId(APP_ID);

const AUTOTEST = !!process.env.SAKINAH_AUTOTEST;

let LOG_PATH;
try {
  LOG_PATH = process.env.SAKINAH_LOG || path.join(app.getPath('temp'), 'sakinah-main.log');
} catch {
  LOG_PATH = process.env.SAKINAH_LOG || path.join(__dirname, 'sakinah-main.log');
}

function logLine(s) {
  try { fs.appendFileSync(LOG_PATH, `[main] ${s}\n`); } catch {}
}

try {
  logLine(`boot pid=${process.pid} autotest=${AUTOTEST} electron=${process.versions.electron} notificationSupported=${Notification.isSupported()}`);
} catch {}

process.on('uncaughtException', (err) => logLine('uncaughtException: ' + ((err && err.stack) || err)));

// ---------- window / tray ----------
let win = null;
let tray = null;
let quitting = false;
let remindersEnabled = true;

const ICON_DIR = path.join(__dirname, 'src', 'assets', 'icons');
const winIcon = fs.existsSync(path.join(ICON_DIR, 'icon.png')) ? path.join(ICON_DIR, 'icon.png') : undefined;
let trayIconImg = null;
try {
  if (fs.existsSync(path.join(ICON_DIR, 'tray.png'))) {
    trayIconImg = nativeImage.createFromPath(path.join(ICON_DIR, 'tray.png'));
  }
} catch {}

const scheduleTimers = new Map();

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function maybeTrayHint() {
  try {
    const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
    if (fs.existsSync(flag)) return;
    fs.writeFileSync(flag, '1');
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Sakinah is still with you',
        body: 'The app lives quietly in your tray, so prayer reminders reach you even when the window is closed.',
      });
      n.on('click', () => showWindow());
      n.show();
    }
  } catch (err) { logLine('tray-hint failed: ' + err); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 1000,
    minHeight: 660,
    frame: false,
    backgroundColor: '#f6f2ea',
    show: false,
    icon: winIcon,
    title: 'Sakinah',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const loadOpts = (AUTOTEST && process.env.SAKINAH_HASH) ? { hash: process.env.SAKINAH_HASH } : undefined;
  win.loadFile(path.join(__dirname, 'src', 'index.html'), loadOpts);

  win.webContents.on('console-message', (...args) => {
    try {
      const ev = args[0];
      let msg = '';
      if (ev && typeof ev === 'object' && 'message' in ev) {
        msg = `${ev.level != null ? ev.level : ''}: ${ev.message}`;
      } else {
        msg = String(args[2] != null ? args[2] : args[1] != null ? args[1] : '');
      }
      logLine('renderer ' + msg);
    } catch {}
  });

  win.once('ready-to-show', () => {
    win.show();
    if (AUTOTEST) win.maximize();
  });

  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      maybeTrayHint();
    }
  });

  win.on('closed', () => { win = null; });
}

function createTray() {
  try {
    tray = new Tray(trayIconImg || winIcon);
    tray.setToolTip('Sakinah — Quran & Salah companion');
    rebuildTrayMenu();
    tray.on('double-click', () => showWindow());
  } catch (err) { logLine('tray failed: ' + err); }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Sakinah', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Prayer reminders',
      type: 'checkbox',
      checked: remindersEnabled,
      click: (item) => { remindersEnabled = item.checked; send('tray:reminders', item.checked); if (!item.checked) clearAllTimers(); },
    },
    { type: 'separator' },
    { label: 'Quit Sakinah', click: () => { quitting = true; app.quit(); } },
  ]));
}

function setRemindersEnabled(v) {
  remindersEnabled = !!v;
  rebuildTrayMenu();
}

// ---------- notifications ----------
function firePrayerNotification(p) {
  if (!remindersEnabled) return;
  try {
    if (!Notification.isSupported()) return;
    const nameEn = p.nameEn || p.key || 'prayer';
    const nameAr = p.nameAr || ' Salaat ';
    const title = p.mode === 'before' && p.minutes
      ? `${nameEn} in ${p.minutes} min${p.minutes === 1 ? '' : 's'}`
      : `It is time for ${nameEn}`;
    const body = `${nameAr} · Tap to open Sakinah and check it off.`;
    const n = new Notification({
      title,
      body,
      icon: winIcon,
      silent: false,
    });
    n.on('click', () => showWindow());
    n.show();
    logLine(`notification fired: ${p.key || ''} ${title}`);
  } catch (err) { logLine('notify failed: ' + err); }
}

ipcMain.handle('test-notification', () => {
  try {
    if (!Notification.isSupported()) return { ok: false, error: 'not supported' };
    const n = new Notification({
      title: 'Notifications work ✓',
      body: 'This is exactly how Sakinah will remind you at every prayer time — even from the tray.',
    });
    n.on('click', () => showWindow());
    n.show();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------- window controls ----------
ipcMain.on('win:min', () => { if (win) win.minimize(); });
ipcMain.on('win:max', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win:close', () => { if (win) win.close(); });

// ---------- network (done here to avoid CORS headaches in the renderer) ----------
async function safeFetch(url, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

ipcMain.handle('detect-location', async () => {
  try {
    const j = await safeFetch('https://ipwho.is/');
    if (j && j.success) {
      return {
        ok: true,
        city: j.city || '',
        region: j.region || '',
        country: j.country || '',
        country_code: j.country_code || '',
        latitude: j.latitude,
        longitude: j.longitude,
      };
    }
    return { ok: false, error: 'lookup failed' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('fetch-prayer-times', async (_ev, p = {}) => {
  try {
    let url;
    if (p.city && p.country) {
      url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(p.city)}&country=${encodeURIComponent(p.country)}&method=${p.method != null ? p.method : 3}&school=${p.school != null ? p.school : 0}`;
    } else {
      url = `https://api.aladhan.com/v1/timings/${encodeURIComponent(p.date)}?latitude=${p.latitude}&longitude=${p.longitude}&method=${p.method != null ? p.method : 3}&school=${p.school != null ? p.school : 0}`;
    }
    const j = await safeFetch(url);
    if (j && j.code === 200 && j.data) {
      const d = j.data;
      const pick = (k) => {
        const m = String((d.timings && d.timings[k]) || '').match(/^(\d{1,2}):(\d{2})/);
        return m ? { h: +m[1], m: +m[2] } : null;
      };
      const timings = {
        fajr: pick('Fajr'),
        sunrise: pick('Sunrise'),
        dhuhr: pick('Dhuhr'),
        asr: pick('Asr'),
        maghrib: pick('Maghrib'),
        isha: pick('Isha'),
      };
      return {
        ok: true,
        timings,
        gregorian: d.date ? d.date.gregorian : null,
        hijri: d.date ? d.date.hijri : null,
        meta: {
          latitude: d.meta ? d.meta.latitude : null,
          longitude: d.meta ? d.meta.longitude : null,
          timezone: d.meta ? d.meta.timezone : null,
          method: d.meta && d.meta.method ? d.meta.method.name : null,
          school: d.meta ? d.meta.school : null,
        },
      };
    }
    return { ok: false, error: 'unexpected API response' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---------- reminder scheduling (main process => works from tray) ----------
function clearAllTimers() {
  for (const t of scheduleTimers.values()) clearTimeout(t);
  scheduleTimers.clear();
}

ipcMain.handle('sync-schedule', (_ev, list) => {
  try {
    clearAllTimers();
    const now = Date.now();
    let scheduled = 0;
    for (const p of (list || [])) {
      const delay = p.at - now;
      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        scheduled++;
        const t = setTimeout(() => {
          scheduleTimers.delete(p.key);
          firePrayerNotification(p);
        }, delay);
        scheduleTimers.set(p.key, t);
      }
    }
    logLine(`schedule synced: ${scheduled} upcoming`);
    return { ok: true, scheduled };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('clear-schedule', () => { clearAllTimers(); return { ok: true }; });

ipcMain.handle('sync-reminders', (_ev, v) => { setRemindersEnabled(v); return { ok: true }; });

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    createTray();
    createWindow();

    // one-time welcome toast: proves notifications work on this machine
    try {
      const flag = path.join(app.getPath('userData'), 'welcome-shown');
      if (!fs.existsSync(flag) && Notification.isSupported()) {
        fs.writeFileSync(flag, '1');
        setTimeout(() => {
          try {
            const n = new Notification({
              title: 'Welcome to Sakinah',
              body: 'Rest easy — a gentle reminder will appear here at each prayer time, even while the window is closed.',
            });
            n.on('click', () => showWindow());
            n.show();
          } catch {}
        }, 30000);
      }
    } catch {}

    if (AUTOTEST) {
      setTimeout(async () => {
        try {
          if (win && !win.isDestroyed()) {
            const img = await win.webContents.capturePage();
            const out = process.env.SAKINAH_SHOT;
            if (out) {
              fs.writeFileSync(out, img.toPNG());
              logLine('screenshot saved: ' + out);
            }
          }
        } catch (err) { logLine('screenshot failed: ' + err); }
        quitting = true;
        app.exit(0);
      }, 4000);
    }
  });

  app.on('window-all-closed', () => {
    // keep running in the tray on Windows; only truly quit when asked
    if (quitting) app.quit();
  });

  app.on('before-quit', () => { quitting = true; });
}
