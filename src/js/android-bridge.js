// Sakinah — Android/WebView bridge replace for window.sakinah.
// On Electron the preload.js defines window.sakinah (ipc bridge); this file
// only activates when that is missing — giving phones internet prayer times
// via the same public APIs the desktop main process uses.
(function () {
  'use strict';
  if (window.sakinah) return; // desktop bridge already present

  function safeFetchJson(url) {
    return fetch(url).then(function (r) { return r.json(); });
  }

  window.sakinah = {
    win: {
      minimize: function () {}, maximizeToggle: function () {}, close: function () {},
      onMaximized: function () {}
    },
    detectLocation: async function () {
      try {
        const j = await safeFetchJson('https://ipwho.is/');
        if (j && j.success) {
          return {
            ok: true,
            city: j.city || '', region: j.region || '', country: j.country || '',
            country_code: j.country_code || '',
            latitude: j.latitude, longitude: j.longitude
          };
        }
        return { ok: false, error: 'lookup failed' };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    fetchPrayerTimes: async function (p) {
      p = p || {};
      try {
        let url;
        if (p.city && p.country) {
          url = 'https://api.aladhan.com/v1/timingsByCity?city=' + encodeURIComponent(p.city) +
            '&country=' + encodeURIComponent(p.country) +
            '&method=' + (p.method != null ? p.method : 3) +
            '&school=' + (p.school != null ? p.school : 0);
        } else {
          url = 'https://api.aladhan.com/v1/timings/' + encodeURIComponent(p.date || '') +
            '?latitude=' + p.latitude + '&longitude=' + p.longitude +
            '&method=' + (p.method != null ? p.method : 3) +
            '&school=' + (p.school != null ? p.school : 0);
        }
        const j = await safeFetchJson(url);
        if (j && j.code === 200 && j.data) {
          const d = j.data;
          const pick = function (k) {
            const m = String((d.timings && d.timings[k]) || '').match(/^(\d{1,2}):(\d{2})/);
            return m ? { h: +m[1], m: +m[2] } : null;
          };
          return {
            ok: true,
            timings: {
              fajr: pick('Fajr'), sunrise: pick('Sunrise'), dhuhr: pick('Dhuhr'),
              asr: pick('Asr'), maghrib: pick('Maghrib'), isha: pick('Isha')
            },
            gregorian: d.date ? d.date.gregorian : null,
            hijri: d.date ? d.date.hijri : null,
            meta: {
              latitude: d.meta ? d.meta.latitude : null,
              longitude: d.meta ? d.meta.longitude : null,
              timezone: d.meta ? d.meta.timezone : null,
              method: d.meta && d.meta.method ? d.meta.method.name : null
            }
          };
        }
        return { ok: false, error: 'api error' };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    syncSchedule: async function () { return 0; },
    clearSchedule: async function () { return 0; },
    syncReminders: async function () { return 0; },
    testNotification: async function () { return 0; },
    onTrayCommand: function () {}
  };
  console.log('[sakinah] android bridge active');
})();
