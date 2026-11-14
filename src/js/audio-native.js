// Sakinah — native background-audio bridge (Android only).
// Routes recitation through the AudioBridge Capacitor plugin → AudioService
// (foreground service + MediaSession): playback survives the screen being
// off, auto-advances without JavaScript, and shows lock-screen / Bluetooth
// head-unit controls (surah name, play/pause/next/prev).
// On every other platform this module stays dormant and quran.js uses the
// plain <audio> element exactly as before.
(function () {
  'use strict';

  const cap = window.Capacitor || null;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  let bridge = null;
  try {
    bridge = isNative && cap.Plugins && cap.Plugins.AudioBridge ? cap.Plugins.AudioBridge : null;
  } catch (e) { bridge = null; }
  const avail = !!bridge;
  try { console.log('[sakinah][an] native=' + isNative + ' bridge=' + !!bridge + ' plugins=' + (cap && cap.Plugins ? Object.keys(cap.Plugins).join(',') : 'none')); } catch (e) {}

  let active = false;        // a native session is live
  let playing = false;       // cached last event for the sync isPlaying()
  let stateCb = null;        // quran.js mirrors UI from these
  let dryCb = null;          // quran.js decides what "queue empty" means

  // queue bookkeeping — ayahs are appended ahead of the playing one
  let ctx = null;            // { reciter, reciterName, surahObj, idx, once }
  let curIdx = -1;           // surah index of the ayah currently playing
  let startIdx = 0;          // surah index of native queue position 0 (the
                             // service reports queue positions, not surah ones)
  let lastQueuedIdx = -1;    // highest index appended to the native queue
  const pending = new Set(); // indices being fetched right now (dupe guard)
  const AHEAD = 4;           // ayahs kept queued ahead of playback
  let beginning = false;     // a start() is in flight — "stopped"/"ended" from
                             // the session being replaced are stale, ignore them

  function titleFor(s, a) {
    return (s && (s.englishName || s.name) || 'Quran') + ' · Ayah ' + ((a && a.numberInSurah) || '');
  }

  async function toB64(ab) {
    const u8 = new Uint8Array(ab);
    let bin = '';
    const CH = 0x8000; // 32k-chunks keep String.fromCharCode under arg limits
    for (let i = 0; i < u8.length; i += CH) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  async function bytesOf(rec, num) {
    if (!window.AudioOffline) throw new Error('offline module missing');
    return await window.AudioOffline.getBytes(rec, num);
  }

  // fetch + append one ayah (dupe-guarded); resolves true when appended
  async function appendOne(s, nIdx, rec, recName) {
    if (!s || nIdx < 0 || nIdx >= s.ayahs.length) return false;
    if (nIdx <= lastQueuedIdx || pending.has(nIdx)) return false;
    pending.add(nIdx);
    try {
      const a = s.ayahs[nIdx];
      const bytes = await bytesOf(rec, a.number);
      if (!bridge || nIdx <= lastQueuedIdx) return false; // raced with another appender
      await bridge.append({
        b64: await toB64(bytes),
        num: String(a.number),
        title: titleFor(s, a),
        artist: recName || '',
      });
      lastQueuedIdx = nIdx;
      return true;
    } finally {
      pending.delete(nIdx);
    }
  }

  // keep ~AHEAD ayahs queued ahead of the playing one
  async function topUp() {
    if (!ctx || !ctx.surahObj || !bridge) return;
    for (let guard = 0; guard < AHEAD + 2; guard++) {
      if (!ctx) return;
      if (lastQueuedIdx + 1 >= ctx.surahObj.ayahs.length) return;
      if (lastQueuedIdx - Math.max(0, curIdx) >= AHEAD) return;
      try {
        const ok = await appendOne(ctx.surahObj, lastQueuedIdx + 1, ctx.reciter, ctx.reciterName);
        if (!ok) return; // already queued/pending — done for now
      } catch (e) {
        return; // network hiccup — the dry-wake retries when playback needs it
      }
    }
  }

  if (avail && bridge.addListener) {
    bridge.addListener('state', (d) => {
      const st = d && d.state;
      if (st === 'playing') {
        playing = true;
        if (typeof d.index === 'number' && d.index >= 0) curIdx = startIdx + d.index;
        if (stateCb) { try { stateCb('playing', d.num, curIdx); } catch (e) {} }
        topUp();
      } else if (st === 'paused') {
        playing = false;
        if (stateCb) { try { stateCb('paused', d.num, curIdx); } catch (e) {} }
      } else if (st === 'dry') {
        // backup for the evaluateJavascript wake; also fires in-process
        if (dryCb) { try { dryCb(); } catch (e) {} }
      } else if (st === 'ended') {
        if (beginning) return; // stale teardown of the replaced session
        playing = false; active = false;
        if (stateCb) { try { stateCb('ended', d.num, curIdx); } catch (e) {} }
      } else if (st === 'stopped') {
        if (beginning) return; // stale teardown of the replaced session
        playing = false; active = false;
        if (stateCb) { try { stateCb('stopped', d.num, curIdx); } catch (e) {} }
      } else if (st === 'error') {
        playing = false;
        if (stateCb) { try { stateCb('error', d.num, curIdx); } catch (e) {} }
      }
    });
  }

  // ---- session adoption / re-sync ---------------------------------------
  // The foreground service outlives the WebView: Android may destroy and
  // recreate the activity while recitation continues. After a reload the JS
  // state is gone (no floating bar, no way to stop the sound) — these rebuild
  // it from the service's live queue.

  /** take over a session that is already live in the service. quran.js has
   *  matched the playing ayah first:
   *  { surahObj, idx, pos, count, playing, reciter, reciterName } where idx is
   *  that ayah's surah index and pos its native queue position. */
  function adoptSession(q) {
    if (!avail || !q || !q.surahObj) return false;
    ctx = {
      reciter: q.reciter || '',
      reciterName: q.reciterName || '',
      surahObj: q.surahObj,
      once: false,
    };
    startIdx = Math.max(0, (q.idx || 0) - Math.max(0, q.pos || 0));
    curIdx = q.idx || 0;
    // items queued ahead of the playing one already sit in the native queue
    lastQueuedIdx = Math.max(curIdx, curIdx + Math.max(0, ((q.count || 1) - 1) - Math.max(0, q.pos || 0)));
    active = true;
    playing = !!q.playing;
    topUp();
    return true;
  }

  /** read the live native state; returns
   *  { playing, pos, count, num, title, reciter } or null when nothing runs */
  async function syncNow() {
    if (!avail) return null;
    let r = null;
    try { r = await bridge.query(); } catch (e) { return null; }
    if (!r) return null;
    const count = Math.max(0, Number(r.count) || 0);
    const pos = Math.max(0, Number(r.pos) || 0);
    const num = Number(r.num) || 0;
    const isPlaying = !!r.playing;
    if (count <= 0 || !num) {
      if (active) { // native side is gone — correct the cached state
        active = false; playing = false; ctx = null;
        if (stateCb) { try { stateCb('stopped', '', curIdx); } catch (e) {} }
      }
      return null;
    }
    active = true;
    playing = isPlaying;
    curIdx = startIdx + pos;
    const info = { playing: isPlaying, pos, count, num, title: r.title || '', reciter: r.reciter || '' };
    if (stateCb) { try { stateCb(isPlaying ? 'playing' : 'paused', String(num), curIdx); } catch (e) {} }
    return info;
  }

  /** native dry-wake entry (evaluateJavascript — works with the screen off);
   *  idx is a native queue position */
  function onDryWake(idx) {
    if (typeof idx === 'number' && idx >= 0) curIdx = startIdx + idx;
    if (dryCb) { try { dryCb(); } catch (e) {} }
  }

  // back from another app / lock screen: events may have been missed while
  // the WebView was suspended — re-read the native state so UI matches sound
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { syncNow(); }
    });
  }

  window.AudioNative = {
    available() { return avail; },

    /** quran.js installs { state(st, num, idx), dry() } handlers */
    setHandlers(h) { stateCb = h && h.state; dryCb = h && h.dry; },

    /** begin a session: first ayah's bytes resolve, then the service starts */
    async start(c) {
      if (!avail || !c || !c.surahObj) return false;
      const s = c.surahObj;
      const a = s.ayahs[c.idx];
      if (!a) return false;
      beginning = true; // ignore stale stopped/ended from the session we replace
      try {
        const bytes = await bytesOf(c.reciter, a.number); // throws E_OFFLINE like the web path
        ctx = { reciter: c.reciter, reciterName: c.reciterName, surahObj: s, once: !!c.once };
        startIdx = c.idx; // queue position 0 is this ayah
        curIdx = c.idx;
        lastQueuedIdx = c.idx;
        active = true;
        playing = true;
        await bridge.begin({
          b64: await toB64(bytes),
          num: String(a.number),
          title: titleFor(s, a),
          artist: c.reciterName || '',
          reciter: c.reciterName || 'Quran',
          reciterId: c.reciter || '',
          once: !!c.once,
        });
      } finally {
        beginning = false;
      }
      if (!c.once) topUp(); // fire-and-forget pre-buffer
      return true;
    },

    /** dry-wake from native (works with the screen off): queue the next ayah */
    async ensureNext() {
      if (!ctx || !ctx.surahObj || !bridge) return false;
      const nextIdx = curIdx + 1;
      if (nextIdx >= ctx.surahObj.ayahs.length) return false;
      if (nextIdx <= lastQueuedIdx) return true; // already queued — kick happens native-side
      try {
        const ok = await appendOne(ctx.surahObj, nextIdx, ctx.reciter, ctx.reciterName);
        if (!ok) return nextIdx <= lastQueuedIdx;
        return true;
      } catch (e) {
        // retry shortly while the service holds (120 s grace)
        const nIdx = nextIdx;
        const s = ctx.surahObj;
        setTimeout(() => { if (ctx) appendOne(s, nIdx, ctx.reciter, ctx.reciterName).catch(() => {}); }, 2000);
        return false;
      }
    },

    /** after an advance, top the queue back up */
    afterAdvance() { topUp(); },

    /** take over an already-running native session (see adoptSession) */
    adopt: adoptSession,

    /** read the live native state (see syncNow) */
    sync: syncNow,

    /** native dry-wake entry point (evaluateJavascript target) */
    onDry: onDryWake,

    /** surah index of the ayah the service is playing right now */
    currentIndex() { return curIdx; },

    stop() {
      if (!avail) return;
      active = false;
      playing = false;
      ctx = null;
      try { bridge.stop(); } catch (e) {}
    },
    pause() { if (avail) { try { bridge.pause(); } catch (e) {} } },
    resume() { if (avail) { try { bridge.resume(); } catch (e) {} } },
    next() { if (avail) { try { bridge.next(); } catch (e) {} } },
    prev() { if (avail) { try { bridge.prev(); } catch (e) {} } },
    isPlaying() { return playing; },
    isActive() { return active; },
  };
})();
