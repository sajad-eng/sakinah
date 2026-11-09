// Sakinah — dashboard: salah check-offs, prayer times, reminders, settings
// Depends on: window.Store, window.Quran, window.QURAN_AR/EN, window.sakinah (preload)

(function () {
  'use strict';

  const api = window.sakinah || {
    win: { minimize() {}, maximizeToggle() {}, close() {}, onMaximized() {} },
    detectLocation: () => Promise.resolve({ ok: false }),
    fetchPrayerTimes: () => Promise.resolve({ ok: false }),
    syncSchedule: () => Promise.resolve({ ok: true }),
    clearSchedule: () => Promise.resolve({ ok: true }),
    syncReminders: () => Promise.resolve({ ok: true }),
    testNotification: () => Promise.resolve({ ok: false }),
    onTrayCommand: () => {},
  };

  const el = (id) => document.getElementById(id);
  const store = window.Store;

  // ------------------------------------------------------------------
  // constants
  // ------------------------------------------------------------------

  const PRAYERS = [
    { key: 'fajr', en: 'Fajr', ar: 'ٱلْفَجْر' },
    { key: 'dhuhr', en: 'Dhuhr', ar: 'ٱلظُّهْر' },
    { key: 'asr', en: 'ʿAsr', ar: 'ٱلْعَصْر' },
    { key: 'maghrib', en: 'Maghrib', ar: 'ٱلْمَغْرِب' },
    { key: 'isha', en: 'ʿIshāʾ', ar: 'ٱلْعِشَاء' },
  ];

  const METHODS = [
    { id: 3, label: 'Muslim World League' },
    { id: 4, label: 'Umm al-Qura, Makkah' },
    { id: 5, label: 'Egyptian General Authority of Survey' },
    { id: 2, label: 'ISNA (North America)' },
    { id: 1, label: 'Univ. of Islamic Sciences, Karachi' },
    { id: 8, label: 'Gulf Region' },
    { id: 13, label: 'Diyanet (Turkey)' },
    { id: 17, label: 'JAKIM (Malaysia)' },
    { id: 9, label: 'Kuwait' },
    { id: 10, label: 'Qatar' },
    { id: 16, label: 'Dubai' },
  ];

  const METHOD_BY_COUNTRY = {
    SA: 4, YE: 4, AE: 8, OM: 8, BH: 8, KW: 9, QA: 10,
    TR: 13, MY: 17, ID: 17, US: 2, CA: 2, PK: 1, IN: 1, BD: 1,
    EG: 5, IQ: 5, SY: 5, LB: 5, JO: 5, PS: 5, SD: 5, LY: 5, DZ: 5, MA: 3, TN: 5,
  };

  const DEFAULTS = {
    theme: 'auto',
    method: 3,
    methodTouched: false,
    school: 0,
    offsetMin: 0,
    timeFormat: '12h',
    locationMode: 'auto',
    city: '',
    country: '',
    latitude: null,
    longitude: null,
    reminders: true,
  };

  let S = Object.assign({}, DEFAULTS, (store ? store.get('settings', {}) : {}));

  // runtime
  let times = null;       // { fajr:{h,m}, ... }
  let hijriInfo = null;
  let gregInfo = null;
  let locLabel = '';
  let todayKey = localToday();
  let slots = [];         // [{key,en,ar,time:Date|null}]
  let nextSlot = null;
  let prevSlot = null;
  let timingsOk = false;
  let bootDone = false;

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function localToday(d) {
    const t = d || new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }

  function dmy(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}-${m}-${y}`;
  }

  function saveSettings() {
    if (store) store.set('settings', S);
  }

  function fmtClock(h, m) {
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '—';
    if (S.timeFormat === '24h') {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    const suffix = h < 12 ? 'am' : 'pm';
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
  }

  function timeParts(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    return { h, m, s };
  }

  function humanCountdown(totalSec) {
    if (totalSec <= 0) return 'now';
    if (totalSec < 60) return `${totalSec}s`;
    const { h, m } = timeParts(totalSec);
    if (h > 0) return `${h} hr ${m} min`;
    return `${m} min`;
  }

  function log(...args) {
    try { console.log('[sakinah]', ...args); } catch {}
  }

  function autotestState(extra) {
    if (location.hash.indexOf('autotest') === -1) return;
    const state = Object.assign({
      timedonce: timingsOk,
      next: nextSlot ? nextSlot.en : null,
      theme: document.documentElement.getAttribute('data-theme'),
      api: !!window.sakinah,
      surahs: window.QURAN_AR && window.QURAN_AR.data ? window.QURAN_AR.data.surahs.length : 0,
      view: activeView,
    }, extra);
    console.log('AUTOTEST-STATE ' + JSON.stringify(state));
  }

  // ------------------------------------------------------------------
  // theme
  // ------------------------------------------------------------------

  function applyTheme() {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const resolve = () => {
      const dark = S.theme === 'dark' || (S.theme === 'auto' && mq.matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    resolve();
    if (!applyTheme.bound) {
      try {
        mq.addEventListener('change', resolve);
      } catch {
        if (mq.addListener) mq.addListener(resolve);
      }
      applyTheme.bound = true;
    }
  }

  function cycleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    S.theme = cur === 'dark' ? 'light' : 'dark';
    saveSettings();
    applyTheme();
    autotestState();
  }

  // ------------------------------------------------------------------
  // shell: titlebar, tabs
  // ------------------------------------------------------------------

  let activeView = 'today';

  function initShell() {
    el('win-min').addEventListener('click', () => api.win.minimize());
    el('win-max').addEventListener('click', () => api.win.maximizeToggle());
    el('win-close').addEventListener('click', () => api.win.close());
    api.win.onMaximized((v) => document.body.classList.toggle('is-maximized', !!v));

    el('theme-btn').addEventListener('click', cycleTheme);
    el('settings-btn').addEventListener('click', openSettings);

    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => switchView(t.dataset.view));
    });

    api.onTrayCommand((enabled) => {
      S.reminders = !!enabled;
      saveSettings();
      resyncSchedule();
      log('tray toggle: reminders', enabled);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSettings();
    });
  }

  function switchView(name) {
    activeView = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    autotestState();
  }

  // ------------------------------------------------------------------
  // prayer data
  // ------------------------------------------------------------------

  async function ensureLocation() {
    if (S.locationMode === 'auto' && (S.latitude == null || S.longitude == null)) {
      const loc = await api.detectLocation();
      if (loc && loc.ok && Number.isFinite(loc.latitude)) {
        S.city = loc.city || S.city;
        S.country = loc.country || S.country;
        S.latitude = loc.latitude;
        S.longitude = loc.longitude;
        if (!S.methodTouched && METHOD_BY_COUNTRY[loc.country_code] != null) {
          S.method = METHOD_BY_COUNTRY[loc.country_code];
        }
        saveSettings();
        log('location detected:', loc.city, loc.country, loc.latitude, loc.longitude);
        return true;
      }
      log('location detection failed', loc && loc.error);
      return false;
    }
    return true;
  }

  async function refreshTimings(opts = {}) {
    await ensureLocation();

    const payload = (S.locationMode === 'manual' && S.city && S.country)
      ? { city: S.city, country: S.country, method: S.method, school: S.school }
      : { date: dmy(todayKey), latitude: S.latitude, longitude: S.longitude, method: S.method, school: S.school };

    if (payload.latitude == null) {
      const cached = store && store.get('timings', null);
      if (cached && cached.date === todayKey) applyTimings(cached);
      else renderTimesError('Could not determine your location yet. Check your connection or enter a city in Settings.');
      return;
    }

    const res = await api.fetchPrayerTimes(payload);
    if (res && res.ok && res.timings) {
      timingsOk = true;
      const pack = {
        date: todayKey,
        timings: res.timings,
        hijri: res.hijri,
        gregorian: res.gregorian,
        meta: res.meta,
        label: (S.city || locLabel || ''),
      };
      if (store) store.set('timings', pack);
      applyTimings(pack);
      log('timings loaded for', todayKey, payload.city || payload.latitude);
    } else {
      const cached = store && store.get('timings', null);
      if (cached && cached.date === todayKey) {
        applyTimings(cached);
      } else {
        renderTimesError('Prayer times are unavailable right now — check your internet connection, then retry.');
      }
      log('timings fetch failed', res && res.error);
    }
    autotestState();
  }

  function renderTimesError(msg) {
    timingsOk = false;
    const row = el('prayer-row');
    row.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'empty-state';
    card.textContent = msg;
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = 'Retry';
    b.addEventListener('click', () => refreshTimings());
    card.appendChild(b);
    row.appendChild(card);
  }

  function applyTimings(pack) {
    times = pack.timings;
    hijriInfo = pack.hijri;
    gregInfo = pack.gregorian;
    locLabel = pack.label || '';
    timingsOk = true;

    buildSlots();
    renderGreeting();
    renderChips();
    renderStreak();
    renderWeek();
    resyncSchedule();
    updateCountdown(true);

    if (!bootDone) bootDone = true;
  }

  function slotDateFrom(h, m) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  function buildSlots() {
    slots = PRAYERS
      .map((p) => {
        const t = times && times[p.key];
        if (!t) return null;
        return { ...p, time: slotDateFrom(t.h, t.m) };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
  }

  function computeNext() {
    const now = new Date();
    nextSlot = slots.find((s) => s.time > now) || null;
    if (nextSlot) {
      const idx = slots.indexOf(nextSlot);
      prevSlot = idx > 0 ? slots[idx - 1] : slots[slots.length - 1];
    } else {
      // tomorrow's fajr
      const first = slots[0];
      if (first) {
        const t = new Date(first.time);
        t.setDate(t.getDate() + 1);
        nextSlot = Object.assign({}, first, { time: t });
        prevSlot = slots[slots.length - 1];
      }
    }
  }

  // ------------------------------------------------------------------
  // reminders (fire from the main process, so they work minimized/tray)
  // ------------------------------------------------------------------

  let lastNextKey = '';

  async function resyncSchedule() {
    try {
      computeNext();
      if (!slots.length) return;
      if (!S.reminders) {
        await api.clearSchedule();
        return;
      }
      const list = slots.map((s) => {
        const at = new Date(s.time).getTime() - (S.offsetMin || 0) * 60000;
        return {
          key: s.key,
          nameEn: s.en,
          nameAr: s.ar,
          mode: S.offsetMin > 0 ? 'before' : 'at',
          minutes: S.offsetMin,
          at,
        };
      }).filter((x) => Number.isFinite(x.at));
      await api.syncSchedule(list);
      log('schedule synced:', list.length, 'reminders');
    } catch (err) {
      log('schedule sync error', err);
    }
  }

  // ------------------------------------------------------------------
  // check-offs
  // ------------------------------------------------------------------

  function getLog() { return (store && store.get('log', {})) || {}; }
  function saveLog(log) { if (store) store.set('log', log); }

  function dayChecks(dateKey) { return getLog()[dateKey] || {}; }
  function isDone(dateKey, key) { return !!(dayChecks(dateKey)[key]); }

  function setDone(dateKey, key, val) {
    const logAll = getLog();
    if (!logAll[dateKey]) logAll[dateKey] = {};
    logAll[dateKey][key] = !!val;
    saveLog(logAll);
    renderChips();
    renderStreak();
    renderWeek();
    autotestState({ toggled: key, val });
  }

  function streakCount() {
    const logAll = getLog();
    let streak = 0;
    let d = new Date();
    const includesToday = PRAYERS.every((p) => logAll[localToday(d)] && logAll[localToday(d)][p.key]);
    if (!includesToday) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 365 * 5; i++) {
      const k = localToday(d);
      if (!logAll[k]) break;
      if (PRAYERS.every((p) => logAll[k][p.key])) {
        streak++;
        d.setDate(d.getDate() - 1);
      } else break;
    }
    return streak;
  }

  // ------------------------------------------------------------------
  // rendering: today
  // ------------------------------------------------------------------

  function renderGreeting() {
    const hour = new Date().getHours();
    let greet = 'Good day';
    if (hour < 5) greet = 'A quiet night';
    else if (hour < 12) greet = 'Good morning';
    else if (hour < 16) greet = 'Good afternoon';
    else if (hour < 20) greet = 'Good evening';
    else greet = 'A restful night';
    el('greeting').textContent = greet + ' — may your salah be easy today.';

    const g = gregInfo;
    let gregText = '';
    if (g) {
      gregText = `${g.weekday && g.weekday.en ? g.weekday.en : ''}, ${g.day} ${g.month && g.month.en ? g.month.en : ''} ${g.year}`;
    } else {
      gregText = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    el('date-line').textContent = gregText;

    const h = hijriInfo;
    const hijriEl = el('hijri-line');
    if (h) {
      hijriEl.textContent = `${h.day} ${h.month && h.month.en ? h.month.en : ''} ${h.year} AH`;
      hijriEl.style.display = '';
    } else {
      hijriEl.style.display = 'none';
    }

    const loc = el('loc-line');
    if (locLabel) {
      loc.innerHTML = '';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.innerHTML = '<use href="#i-pin"/>';
      const span = document.createElement('span');
      span.textContent = locLabel + (S.locationMode === 'manual' ? ' (manual)' : '');
      loc.appendChild(svg);
      loc.appendChild(span);
    }
  }

  function renderChips() {
    const row = el('prayer-row');
    row.innerHTML = '';
    if (!times) { renderTimesError(times === null ? 'Fetching times…' : 'Times unavailable'); return; }

    const now = new Date();
    computeNext();

    for (const p of slots) {
      const done = isDone(todayKey, p.key);
      const isNext = nextSlot && nextSlot.key === p.key && nextSlot.time.getTime() === p.time.getTime();
      const missed = !done && p.time < now;

      const chip = document.createElement('button');
      chip.className = 'card prayer-chip' + (done ? ' done' : '') + (isNext ? ' next' : '') + (missed ? ' missed' : '');
      chip.setAttribute('aria-label', `${p.en} at ${fmtClock(p.time.getHours(), p.time.getMinutes())}${done ? ', done' : ''}`);

      const time = document.createElement('div');
      time.className = 'p-time';
      time.textContent = fmtClock(p.time.getHours(), p.time.getMinutes());

      const name = document.createElement('div');
      name.className = 'p-name';
      const ar = document.createElement('div');
      ar.className = 'p-ar';
      ar.setAttribute('lang', 'ar');
      ar.textContent = p.ar;
      const en = document.createElement('div');
      en.className = 'p-en';
      en.textContent = p.en;
      name.appendChild(ar);
      name.appendChild(en);

      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.innerHTML = '<svg viewBox="0 0 24 24"><path class="tick-path" d="M5 12.5 10 17.5 19 7.5"/></svg>';

      chip.appendChild(time);
      chip.appendChild(name);
      chip.appendChild(tick);
      chip.dataset.key = p.key;

      chip.addEventListener('click', () => {
        const nextVal = !isDone(todayKey, p.key);
        setDone(todayKey, p.key, nextVal);
        chip.classList.add('pop');
        setTimeout(() => chip.classList.remove('pop'), 400);
      });

      row.appendChild(chip);
    }

    // the greeting sub area times of every slot
    computeNext();
  }

  function renderStreak() {
    const streak = streakCount();
    const checks = dayChecks(todayKey);
    const doneToday = PRAYERS.filter((p) => checks[p.key]).length;
    const total = 5 * 7;
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = localToday(d);
      const c = getLog()[k] || {};
      PRAYERS.forEach((p) => { if (c[p.key]) weekCount++; });
    }
    const main = document.querySelector('#streak-card .streak-main');
    main.innerHTML = '';
    const num = document.createElement('div');
    num.className = 'streak-num';
    num.textContent = String(streak);
    const label = document.createElement('div');
    label.className = 'streak-label';
    label.textContent = streak === 1 ? 'day streak' : 'days in a row';
    main.appendChild(num);
    main.appendChild(label);

    const sub = el('streak-sub');
    const isComplete = doneToday === 5;
    const head = isComplete ? 'Today is complete — 5/5, alhamdulillah.' : `So far today: ${doneToday} of 5.`;
    sub.textContent = '';
    sub.appendChild(document.createTextNode(head + ' '));
    if (streak > 0) {
      const b = document.createElement('b');
      b.textContent = `${streak}-day streak`;
      sub.appendChild(document.createTextNode('You are on a '));
      sub.appendChild(b);
      sub.appendChild(document.createTextNode(' — keep it going gently.'));
    } else if (!isComplete) {
      sub.appendChild(document.createTextNode('Tap a circle when you have prayed — Salah is the anchor of the day.'));
    } else {
      sub.appendChild(document.createTextNode('A steady heart begins again — this is the first of many.'));
    }
  }

  function renderWeek() {
    const card = el('week-card');
    card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'set-title';
    title.style.color = 'var(--accent-deep)';
    title.textContent = 'Last 7 days';
    if (document.documentElement.getAttribute('data-theme') === 'dark') title.style.color = 'var(--accent)';

    const grid = document.createElement('div');
    grid.className = 'week-grid';

    for (let i = 0; i < 7; i++) {
      const inp = new Date();
      inp.setDate(inp.getDate() - i);
      const k = localToday(inp);
      const c = getLog()[k] || {};
      const col = document.createElement('div');
      col.className = 'week-col' + (i === 0 ? ' today' : '');

      const dayName = document.createElement('div');
      dayName.className = 'week-day';
      dayName.textContent = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][inp.getDay()];
      if (i === 0) dayName.textContent = 'Today';

      const dots = document.createElement('div');
      dots.className = 'week-dots';
      let on = 0;
      PRAYERS.forEach((p) => {
        const dot = document.createElement('div');
        dot.className = 'wdot' + (c[p.key] ? ' on' : '');
        if (c[p.key]) on++;
        dots.appendChild(dot);
      });

      const count = document.createElement('div');
      count.className = 'week-count';
      count.textContent = `${on}/5`;

      col.appendChild(dayName);
      col.appendChild(dots);
      col.appendChild(count);
      grid.appendChild(col);
    }

    card.appendChild(title);
    card.appendChild(grid);
  }

  // ------------------------------------------------------------------
  // ayah of the day
  // ------------------------------------------------------------------

  function renderAyahOfDay() {
    const body = el('ayah-body');
    body.innerHTML = '';
    try {
      const surahs = window.QURAN_AR && window.QURAN_AR.data && window.QURAN_AR.data.surahs;
      const surahsEn = window.QURAN_EN && window.QURAN_EN.data && window.QURAN_EN.data.surahs;
      if (!surahs || !surahs.length) throw new Error('no data');

      let total = 6236;
      try {
        total = surahs.reduce((acc, s) => acc + s.ayahs.length, 0);
      } catch {}
      const today = new Date();
      const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const dayIdx = Math.floor(midnight / 86400000) % total;
      let target = dayIdx;
      let sIdx = 0, aIdx = 0;
      for (let s = 0; s < surahs.length; s++) {
        if (target < surahs[s].ayahs.length) { sIdx = s; aIdx = target; break; }
        target -= surahs[s].ayahs.length;
      }
      const sA = surahs[sIdx];
      const sE = surahsEn && surahsEn[sIdx];
      const aA = sA.ayahs[aIdx];
      const aE = sE && sE.ayahs[aIdx] ? sE.ayahs[aIdx].text : '';

      const ar = document.createElement('div');
      ar.className = 'ayah-ootd-ar'
      ar.setAttribute('lang', 'ar');
      ar.textContent = aA.text;

      const tr = document.createElement('div');
      tr.className = 'ayah-ootd-trans';
      tr.textContent = aE;

      const foot = document.createElement('div');
      foot.className = 'ayah-ootd-foot';
      const ref = document.createElement('div');
      ref.className = 'ayah-ootd-ref';
      ref.textContent = `${sA.englishName} · ${sA.number}:${aA.numberInSurah}`;
      const play = document.createElement('button');
      play.className = 'btn';
      const thisAyahPlaying = () => {
        try {
          return Quran.player.isPlaying() && Quran.player.currentGlobal() === aA.number;
        } catch { return false; }
      };
      const refreshPlayLabel = () => {
        play.innerHTML = thisAyahPlaying()
          ? '<svg class="btn-svg"><use href="#i-stop"/></svg> Stop'
          : '<svg class="btn-svg"><use href="#i-play"/></svg> Listen';
      };
      play.addEventListener('click', () => {
        if (thisAyahPlaying()) Quran.player.stop();
        else Quran.player.playAyahOnce(aA.number); // play ONLY this ayah, then stop
      });
      try { Quran.player.onStateChange(refreshPlayLabel); } catch {}
      refreshPlayLabel();
      foot.appendChild(ref);
      foot.appendChild(play);

      body.appendChild(ar);
      body.appendChild(tr);
      body.appendChild(foot);
    } catch (err) {
      body.textContent = 'Ayah of the day is unavailable (Quran data missing).';
      log('ayah of day error', err);
    }
  }

  // ------------------------------------------------------------------
  // countdown loop
  // ------------------------------------------------------------------

  const RING_C = 2 * Math.PI * 86;
  let ringLogged = false;

  function updateCountdown(force) {
    if (!times || !slots.length) return;
    const now = new Date();

    // day rollover
    const tk = localToday(now);
    if (tk !== todayKey) {
      todayKey = tk;
      log('day changed →', tk);
      refreshTimings();
      return;
    }

    computeNext();
    if (!nextSlot) return;

    const untilNext = Math.max(0, Math.floor((nextSlot.time - now) / 1000));
    const isNow = untilNext <= 45;

    el('next-name-ar').textContent = nextSlot.ar;
    el('next-name-en').textContent = nextSlot.en;
    const kicker = el('next-kicker');
    const cd = el('countdown');
    cd.removeAttribute('lang');
    if (isNow) {
      kicker.textContent = 'It is now time for';
      cd.setAttribute('lang', 'ar');
      cd.textContent = 'حَافِظُوا عَلَى الصَّلَوَاتِ';
      el('countdown-at').textContent = '';
    } else {
      kicker.textContent = 'Next prayer';
      cd.textContent = 'in ' + humanCountdown(untilNext);
      el('countdown-at').textContent = 'at ' + fmtClock(nextSlot.time.getHours(), nextSlot.time.getMinutes());
    }
    el('countdown-card').classList.toggle('is-now', isNow);

    // progress ring: fraction of prev→next interval elapsed
    const prog = el('ring-prog');
    if (prevSlot) {
      const span = (nextSlot.time - prevSlot.time) / 1000;
      const frac = span > 0 ? Math.min(1, Math.max(0, (now - prevSlot.time) / 1000 / span)) : 0;
      prog.style.strokeDashoffset = String(RING_C * (1 - frac));
      if (!ringLogged) {
        ringLogged = true;
        log(`ring frac=${frac.toFixed(3)} prev=${prevSlot.en} next=${nextSlot.en}`);
      }
    } else {
      prog.style.strokeDashoffset = String(RING_C);
    }

    // if the "next" prayer changed (a prayer time passed), refresh the chips
    const keyNow = `${todayKey}:${nextSlot ? nextSlot.key : ''}`;
    if (keyNow !== lastNextKey) {
      lastNextKey = keyNow;
      renderChips();
    }
  }

  // ------------------------------------------------------------------
  // settings modal
  // ------------------------------------------------------------------

  function openSettings() {
    el('settings-backdrop').classList.remove('hidden');
    const methodSel = el('set-method');
    methodSel.innerHTML = '';
    METHODS.forEach((m) => {
      const o = document.createElement('option');
      o.value = String(m.id);
      o.textContent = m.label;
      if (Number(S.method) === m.id) o.selected = true;
      methodSel.appendChild(o);
    });

    const recSel = el('set-reciter');
    recSel.innerHTML = '';
    const wantedReciter = (store ? store.get('reciter', 'ar.alafasy') : 'ar.alafasy');
    (window.Quran && Quran.RECITERS || []).forEach((r) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name;
      if (r.id === wantedReciter) o.selected = true;
      recSel.appendChild(o);
    });

    document.querySelector(`input[name="locmode"][value="${S.locationMode === 'manual' ? 'manual' : 'auto'}"]`).checked = true;
    el('set-city').value = S.city || '';
    el('set-country').value = S.country || '';
    el('set-school').value = String(S.school);
    el('set-offset').value = String(S.offsetMin);
    el('set-timeformat').value = S.timeFormat;
    document.querySelector(`input[name="theme"][value="${S.theme}"]`).checked = true;

    document.querySelectorAll('input[name="locmode"]').forEach((r) => {
      r.addEventListener('change', () => {
        el('manual-row').classList.toggle('hidden', r.value !== 'manual' || !r.checked);
      });
    });

    const locLine = el('set-loc-current');
    const h = hijriInfo ? '' : '';
    if (S.city) {
      locLine.innerHTML = `Currently using <b>${escapeHtml(S.city)}, ${escapeHtml(S.country || '')}</b> · lat ${S.latitude != null ? Number(S.latitude).toFixed(2) : '?'}, lon ${S.longitude != null ? Number(S.longitude).toFixed(2) : '?'}`;
    } else {
      locLine.textContent = 'Not detected yet.';
    }
    toggleManualRow();
  }

  function toggleManualRow() {
    const mode = (document.querySelector('input[name="locmode"]:checked') || {}).value || 'auto';
    el('manual-row').classList.toggle('hidden', mode !== 'manual');
  }

  function closeSettings() {
    el('settings-backdrop').classList.add('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initSettings() {
    el('settings-close').addEventListener('click', closeSettings);
    el('settings-backdrop').addEventListener('mousedown', (e) => {
      if (e.target === el('settings-backdrop')) closeSettings();
    });
    el('btn-redetect').addEventListener('click', async () => {
      const btn = el('btn-redetect');
      btn.disabled = true;
      S.locationMode = 'auto';
      S.latitude = null;
      S.longitude = null;
      saveSettings();
      await refreshTimings();
      btn.disabled = false;
      openSettings(); // refresh view
    });
    el('btn-test-notif').addEventListener('click', async () => {
      const res = await api.testNotification();
      el('set-loc-current').innerHTML = res && res.ok ? 'A test notification should be appearing right now ✓' : 'Notifications are not available on this system.';
    });
    el('btn-save-settings').addEventListener('click', () => {
      const mode = (document.querySelector('input[name="locmode"]:checked') || {}).value || 'auto';
      const method = Number(el('set-method').value);
      S.methodTouched = S.method !== method ? true : S.methodTouched;
      S.method = method;
      S.school = Number(el('set-school').value);
      S.offsetMin = Number(el('set-offset').value);
      S.timeFormat = el('set-timeformat').value;
      S.theme = (document.querySelector('input[name="theme"]:checked') || {}).value || 'auto';
      S.locationMode = mode;

      if (mode === 'manual') {
        const city = (el('set-city').value || '').trim();
        const country = (el('set-country').value || '').trim();
        if (city && country) {
          S.city = city;
          S.country = country;
          S.latitude = null; // will be updated from API meta
        }
      }

      saveSettings();
      applyTheme();
      renderGreeting();
      renderChips();
      // reciter
      const recSel = el('set-reciter');
      if (recSel.value && store) store.set('reciter', recSel.value);
      if (window.Quran && Quran.setReciter) Quran.setReciter(recSel.value);

      closeSettings();
      refreshTimings();
      resyncSchedule();
      autotestState({ saved: true });
    });
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------

  window.addEventListener('error', (e) => {
    try { console.error('[sakinah] error:', e.message, e.filename, e.lineno); } catch {}
  });

  function boot() {
    applyTheme();
    initShell();
    initSettings();

    // cached timings for instant first paint
    const cached = store && store.get('timings', null);
    if (cached && cached.date === todayKey && cached.timings) {
      applyTimings(cached);
      log('timings from cache');
    } else {
      renderTimesError('Fetching prayer times…');
    }

    // quran reader
    try {
      Quran.init({
        list: el('surah-list'),
        search: el('surah-search'),
        content: el('reader-content'),
      });
    } catch (err) {
      log('quran init error stack:', (err && err.stack) || String(err));
    }

    renderAyahOfDay();
    renderStreak();
    renderWeek();

    refreshTimings();

    setInterval(() => {
      if (times) updateCountdown(true);
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (localToday() !== todayKey) refreshTimings();
      }
    });

    // gentle re-sync of schedule every 10 min (keeps awake after sleep)
    setInterval(() => { if (timingsOk) resyncSchedule(); }, 10 * 60 * 1000);

    // autotest hooks
    if (location.hash.indexOf('autotest') !== -1) {
      const params = new URLSearchParams(location.hash.replace(/^#/, ''));
      const pv = params.get('view');
      if (pv) setTimeout(() => switchView(pv), 300);
      const pt = params.get('theme');
      if (pt) document.documentElement.setAttribute('data-theme', pt);
      const toggled = params.get('check');
      if (toggled) setTimeout(() => setDone(localToday(), toggled, true), 400);
      if (params.get('settings')) setTimeout(() => openSettings(), 500);
      const ps = params.get('sura');
      const ppg = params.get('page');
      if (ps) setTimeout(() => Quran.open(Number(ps), ppg ? Number(ppg) : undefined), 450);
      const pon = params.get('once');
      if (pon) setTimeout(() => {
        const g = Number(pon);
        Quran.player.playAyahOnce(g);
        log('once-play  global=' + g + ' isOnce=' + Quran.player.isOnce() + ' playing=' + Quran.player.isPlaying());
      }, 700);
      const spx = params.get('scrollpx');
      if (spx) setTimeout(() => {
        const sc = document.querySelector('#view-quran.active .reader-scroll') || document.querySelector('.reader-scroll');
        if (sc) {
          sc.scrollTop = Number(spx);
          log('scroll check  scrollHeight=' + sc.scrollHeight + '  clientHeight=' + sc.clientHeight + '  scrollTop=' + sc.scrollTop);
        } else {
          log('scroll check: .reader-scroll not found');
        }
      }, 900);
      const snapshot = (when) => setTimeout(() => {
        try {
          const st = Quran.flip.state();
          const sc = document.querySelector('.reader-scroll');
          const firstAyah = document.querySelector('.ayah[data-i]');
          log('reader state ' + JSON.stringify({
            page: st.page, of: st.of,
            scrollTop: sc && sc.scrollTop, scrollHeight: sc && sc.scrollHeight,
            firstAyah: firstAyah ? (Number(firstAyah.dataset.i) + 1) : null,
            ayahCount: document.querySelectorAll('.ayah').length,
            playing: Quran.player.isPlaying(), once: Quran.player.isOnce(),
          }) + ' @' + when);
        } catch (e) { log('snapshot error', e); }
      }, when);
      snapshot(1600);
      snapshot(3600);
    }

    setTimeout(() => autotestState(), 2500);
    log('boot complete');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
