// Sakinah — offline recitation cache (IndexedDB) + downloader + Opus transcoder.
// Depends on: window.Store (storage.js), optionally window.QURAN_AR (data/quran-ar.js).
//
// Playback resolution: memory object-URLs -> IndexedDB -> CDN (fetch + optional
// transcode + persist). The CDN hosts only 64 and 128 kbps per-ayah MP3s, and
// availability differs per reciter (Abdul Basit & As-Sudais: 64 only,
// Al-Minshawi: 128 only) — call  fetchAyah()  handles the per-reciter  probing.
// Downloads stored as Opus 24/32 kbps mono Ogg (built-in AudioEncoder + OggOpus
// muxer) when supported, else the original MP3. Whole Quran ≈ 450 MB with Opus
// 32 instead of ≈ 906 MB of MP3 at identical voice quality.

(function () {
  'use strict';

  const DB_NAME = 'sakinah-audio';
  const STORE = 'ayahs';
  const DB_VERSION = 1;

  const BITRATES = ['64', '128'];
  const AUDIO_BASE = 'https://cdn.islamic.network/quran/audio/';
  const CONCURRENCY = 14;         // parallel downloads within a job (line scales to ~2.5 MB/s aggregate)
  const PROBE_TIMEOUT = 12000;    // ms per fetch attempt

  // ------------------------------------------------------------------
  // settings helpers (window.Store)
  // ------------------------------------------------------------------
  function st(k, v) { return window.Store ? window.Store.get(k, v) : v; }
  function stSet(k, val) { if (window.Store) try { window.Store.set(k, val); } catch (e) {} }

  function codecSetting() { return st('audioCodec', 'opus32'); }
  function autoSave() { return st('audioAutoSave', true) !== false; }

  // ------------------------------------------------------------------
  // debug
  // ------------------------------------------------------------------
  function dbg(m) { try { console.log('[sakinah][audio] ' + m); } catch (e) {} }

  // ------------------------------------------------------------------
  // errors
  // ------------------------------------------------------------------
  function mkErr(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

  // ==================================================================
  // IndexedDB layer
  // ==================================================================
  let dbPromise = null;
  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(mkErr('IDB', String(e))); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(mkErr('IDB', String(req.error)));
    });
    return dbPromise;
  }

  async function idbGetRaw(rec, num) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readonly');
      const r = t.objectStore(STORE).get(rec + '|' + num);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(mkErr('IDB', String(r.error)));
    });
  }

  async function idbPutRaw(rec, num, value) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(value, rec + '|' + num);
      t.oncomplete = () => resolve();
      t.onabort = t.onerror = () => reject(mkErr('IDB', String(t.error)));
    });
  }

  async function idbDeleteKeys(keys) {
    if (!keys.length) return 0;
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      keys.forEach((k) => s.delete(k));
      t.oncomplete = () => resolve(keys.length);
      t.onabort = t.onerror = () => reject(mkErr('IDB', String(t.error)));
    });
  }

  // cursor to delete every record whose key begins with `prefix`
  async function idbDeletePrefix(prefix) {
    const d = await idb();
    const keys = [];
    await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readonly');
      const cur = t.objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        if (String(c.key).indexOf(prefix) === 0) keys.push(c.key);
        c.continue();
      };
      cur.onerror = () => reject(mkErr('IDB', String(cur.error)));
      t.oncomplete = () => resolve();
    });
    return idbDeleteKeys(keys);
  }

  // ==================================================================
  // in-memory index (keys + sizes per reciter) & object-URL LRU
  // ==================================================================
  const sizesByKey = new Map();      // "rec|num" -> stored bytes
  let indexReady = false;
  const memUrls = new Map();         // "rec|num" -> { url, bytes }
  const MEM_MAX = 48;

  // ==================================================================
  // Bundled voice tier (Android APK asset, e.g. Mishary Al-Afasy)
  // ==================================================================
  // bundle/voice/manifest.json is staged into the APK's assets/public/voice/
  // folder; the app fetches it at boot (same-origin, no CORS). Bundled ayahs
  // are registered into sizesByKey so every counter / skip check treats them
  // as "already downloaded" — they're inside the APK, always available.
  let BUNDLED = null;                // { [rec]: { ext, mime, nums: Map(num→bytes) } }

  async function loadBundled() {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
    if (BUNDLED) return;
    try {
      const r = await fetch('/voice/manifest.json');
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.reciters) return;
      BUNDLED = {};
      for (const rec of Object.keys(j.reciters)) {
        const e = j.reciters[rec];
        const nums = new Map();
        for (const n of Object.keys(e.sizes || {})) nums.set(Number(n), e.sizes[n]);
        BUNDLED[rec] = { ext: e.ext || 'ogg', mime: e.mime || 'audio/ogg', codec: e.codec || 'opus32', nums };
        reseedBundled(rec);
      }
      const tot = Object.keys(BUNDLED).map((rec) => rec + ':' + BUNDLED[rec].nums.size).join(', ');
      dbg('bundled voice(s): ' + tot);
    } catch (e) {
      dbg('no bundled voice manifest (fine): ' + ((e && e.message) || e));
    }
  }

  function reseedBundled(rec) {
    if (!BUNDLED) return;
    const reseed = rec
      ? [rec]
      : Object.keys(BUNDLED);
    for (const r of reseed) {
      const b = BUNDLED[r];
      if (!b) continue;
      for (const [n, sz] of b.nums) {
        const k = r + '|' + n;
        if (!sizesByKey.has(k)) sizesByKey.set(k, sz);
      }
    }
  }

  function bundledUrl(rec, num) {
    if (!BUNDLED || !BUNDLED[rec]) return null;
    const b = BUNDLED[rec];
    if (!b.nums.has(Number(num))) return null;
    return '/voice/' + rec + '/' + Number(num) + '.' + b.ext;
  }

  function isBundled(rec, num) {
    if (num == null) return !!(BUNDLED && BUNDLED[rec]);
    return !!bundledUrl(rec, num);
  }

  function bundledAyahs(rec) {
    return BUNDLED && BUNDLED[rec] ? BUNDLED[rec].nums.size : 0;
  }

  function rememberUrl(rec, num, url, bytes) {
    const k = rec + '|' + num;
    if (memUrls.has(k)) { try { URL.revokeObjectURL(memUrls.get(k).url); } catch (e) {} memUrls.delete(k); }
    memUrls.set(k, { url, bytes: bytes || 0 });
    if (memUrls.size > MEM_MAX) {
      for (const old of memUrls.keys()) {
        try { URL.revokeObjectURL(memUrls.get(old).url); } catch (e) {}
        memUrls.delete(old);
        if (memUrls.size <= MEM_MAX - 8) break;
      }
    }
  }

  let warmPromise = null;
  function boot() {
    if (warmPromise) return warmPromise;
    warmPromise = (async () => {
      try {
        const d = await idb();
        await new Promise((resolve, reject) => {
          const t = d.transaction(STORE, 'readonly');
          const cur = t.objectStore(STORE).openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            sizesByKey.set(String(c.key), (c.value && c.value.s) || 0);
            c.continue();
          };
          cur.onerror = () => reject(mkErr('IDB', String(cur.error)));
          t.oncomplete = () => resolve();
        });
        indexReady = true;
        dbg('cache index ready: ' + sizesByKey.size + ' ayahs');
        await loadBundled();
        resumePersistedJobs();
      } catch (err) {
        dbg('cache index failed (memory-only playback): ' + (err && err.message));
        indexReady = false; // degrade gracefully — CDN streaming still works
      }
      emitStats();
      emitQueue();
    })();
    return warmPromise;
  }

  // ==================================================================
  // Opus transcoding (WebCodecs) + OggOpus muxer
  // ==================================================================
  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let x = n << 24;
      for (let i = 0; i < 8; i++) x = (x << 1) ^ ((x & 0x80000000) ? 0x04c11db7 : 0);
      t[n] = (x >>> 0);
    }
    return t;
  })();
  function oggCrc(u8) {
    let c = 0;
    for (let i = 0; i < u8.length; i++) c = ((c << 8) ^ crcTable[((c >>> 24) ^ u8[i]) & 0xff]) >>> 0;
    return c >>> 0;
  }

  // packets: Uint8Array[] of raw Opus packets; sampleAt: samples per packet
  // (granule positions); returns a playable .ogg byte array
  function muxOggOpus(packets, samplesAt) {
    const SR = 48000;
    const PRESKIP = 312;
    const SERIAL = 0x53414b49; // 'SAKI'
    let out = [];

    function page(bodyJunks, headerType, granule, seq, isLast) {
      const lacing = [];
      for (const b of bodyJunks) {
        let rem = b.length;
        while (rem >= 255) { lacing.push(255); rem -= 255; }
        lacing.push(rem); // 0..254 terminates this packet's lacing chain (255 = "continued")
      }
      const bodyLen = bodyJunks.reduce((a, b) => a + b.length, 0);
      const head = new Uint8Array(27 + lacing.length);
      const dv = new DataView(head.buffer);
      head.set([0x4f, 0x67, 0x67, 0x53], 0);      // 'OggS'
      head[4] = 0;                                 // version
      head[5] = headerType | (isLast ? 4 : 0);     // capture flags
      dv.setBigUint64 ? dv.setBigUint64(6, BigInt(Math.max(0, granule)), true) : dv.setUint32(6, granule, true);
      dv.setUint32(14, SERIAL, true);
      dv.setUint32(18, seq, true);
      dv.setUint32(22, 0, true);                   // CRC placeholder
      head[26] = lacing.length;
      for (let i = 0; i < lacing.length; i++) head[27 + i] = lacing[i];
      const full = new Uint8Array(head.length + bodyLen);
      full.set(head, 0);
      let o = head.length;
      for (const b of bodyJunks) { full.set(b, o); o += b.length; }
      // CRC is computed over the final page (CRC slots zeroed) and must be
      // written into `full` — the buffer that actually ships.
      new DataView(full.buffer).setUint32(22, oggCrc(full), true);
      out.push(full);
    }

    // stream header page (BOS): OpusHead
    const oh = new Uint8Array(19);
    const odv = new DataView(oh.buffer);
    oh.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);  // 'OpusHead'
    oh[8] = 1;           // version
    oh[9] = 1;           // channels: mono
    odv.setUint16(10, PRESKIP, true);
    odv.setUint32(12, SR, true);
    odv.setInt16(16, 0, true);   // output gain
    oh[18] = 0;          // channel mapping family
    page([oh], 2, 0, 0, false);

    // OpusTags page
    const vendor = 'sakinah-opus';
    const vt = new Uint8Array(8 + 4 + vendor.length + 4);
    vt.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);  // 'OpusTags'
    const vdv = new DataView(vt.buffer);
    vdv.setUint32(8, vendor.length, true);
    for (let i = 0; i < vendor.length; i++) vt[12 + i] = vendor.charCodeAt(i);
    vdv.setUint32(12 + vendor.length, 0, true);   // no comments
    page([vt], 0, 0, 1, false);

    // one data page per packet
    let seq = 2, granule = 0;
    for (let i = 0; i < packets.length; i++) {
      granule += samplesAt[i];
      page([packets[i]], 0, granule, seq, i === packets.length - 1);
      seq++;
    }
    const total = out.reduce((a, b) => a + b.length, 0);
    const blob = new Uint8Array(total);
    let off = 0;
    for (const p of out) { blob.set(p, off); off += p.length; }
    out = null;
    return blob;
  }

  let encoderCapsPromise = null;
  function encoderSupported(kbps) {
    if (!window.AudioEncoder || !window.AudioData) return Promise.resolve(false);
    if (!encoderCapsPromise) {
      try {
        encoderCapsPromise = AudioEncoder.isConfigSupported({
          codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000,
        }).then((r) => !!(r && r.supported)).catch(() => false);
      } catch (e) { encoderCapsPromise = Promise.resolve(false); }
    }
    return encoderCapsPromise;
  }

  // ArrayBuffer (original mp3) -> { blob, codec, samples }
  async function transcodeToOpus(ab, kbps) {
    if (!(await encoderSupported(kbps))) throw mkErr('NO_ENCODER', 'AudioEncoder/Opus unavailable');
    // defensive copy: decodeAudioData detaches its input buffer
    let buf = ab;
    try { buf = ab.slice(0); } catch (e) { throw mkErr('DECODE', 'source buffer detached'); }
    // decode + resample to 48 kHz mono in one step
    let decoded;
    try {
      const oc = new OfflineAudioContext(1, 1, 48000);
      decoded = await oc.decodeAudioData(buf);
    } catch (e) { throw mkErr('DECODE', String((e && e.message) || e)); }
    if (!decoded || !decoded.length) throw mkErr('DECODE', 'empty decode');

    const rate = 48000;
    const frames = decoded.length; // mono, resampled
    let encErr = null;
    const chunks = []; // Uint8Array + duration (us)
    let encoder = null;
    try {
      encoder = new AudioEncoder({
        output: (chunk) => {
          if (!chunk || !chunk.byteLength) return;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({ d: data, dur: chunk.duration || 0 });
        },
        error: (e) => { encErr = e; },
      });
      encoder.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: kbps * 1000 });

      const CHUNK = 48000; // 1 s slices
      const ch = decoded.getChannelData(0);
      for (let off = 0; off < frames; off += CHUNK) {
        const len = Math.min(CHUNK, frames - off);
        const slice = new Float32Array(ch.subarray(off, off + len));
        const ad = new AudioData({
          format: 'f32', sampleRate: rate, numberOfFrames: len,
          numberOfChannels: 1, timestamp: Math.round((off / rate) * 1e6), data: slice,
        });
        encoder.encode(ad);
        ad.close();
      }
      await encoder.flush();
      encoder.close();
      encoder = null;
    } catch (e) {
      throw mkErr('ENCODE', String((e && e.message) || e));
    } finally {
      try { if (encoder) encoder.close(); } catch (e) {}
    }
    if (encErr) throw mkErr('ENCODE', String((encErr && encErr.message) || encErr));
    if (!chunks.length) throw mkErr('ENCODE', 'no packets produced');

    // samples per packet for granule positions (duration in µs → samples @48k)
    const samplesAt = chunks.map((c) => Math.max(1, Math.round(((c.dur || 20000) * rate) / 1e6)));
    const ogg = muxOggOpus(chunks.map((c) => c.d), samplesAt);
    return {
      blob: new Blob([ogg], { type: 'audio/ogg' }),
      codec: 'opus' + kbps,
      packetCount: chunks.length,
      decodedSamples: frames,
    };
  }

  // ==================================================================
  // CDN fetching with per-reciter bitrate discovery
  // ==================================================================
  const bitrateMemo = st('audioBitrateMemo', {}); // { rec: { "64": true|false, "128": ... } }

  function bitrateOrder(rec) {
    const m = bitrateMemo[rec] || {};
    return BITRATES.slice().sort((a, b) => (m[b] === true) - (m[a] === true) || (a < b ? -1 : 1));
    // known-good first, then cheapest (64 < 128) for the unknown ones
  }

  async function fetchAyah(rec, num, opts) {
    let lastErr = null;
    for (const br of bitrateOrder(rec)) {
      if (opts && opts.skip === br) { bitrateMemo[rec] = bitrateMemo[rec] || {}; bitrateMemo[rec][br] = false; continue; }
      const url = AUDIO_BASE + br + '/' + rec + '/' + num + '.mp3';
      try {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const tmo = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT) : null;
        const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'default' });
        if (tmo) clearTimeout(tmo);
        if (r.ok) {
          bitrateMemo[rec] = bitrateMemo[rec] || {};
          bitrateMemo[rec][br] = true;
          return { ab: await r.arrayBuffer(), bitrate: br };
        }
        bitrateMemo[rec] = bitrateMemo[rec] || {};
        bitrateMemo[rec][br] = false;
        lastErr = mkErr('HTTP_' + r.status, 'cdn ' + r.status + ' @' + br + 'k');
      } catch (e) {
        lastErr = mkErr('NET', String((e && e.message) || e));
      }
    }
    stSet('audioBitrateMemo', bitrateMemo);
    if (lastErr && (lastErr.code === 'NET')) {
      throw mkErr('E_OFFLINE', 'no network: ' + lastErr.message);
    }
    throw lastErr || mkErr('HTTP', 'cdn fetch failed');
  }

  // ==================================================================
  // cache orchestration
  // ==================================================================
  function has(rec, num) { return sizesByKey.has(rec + '|' + num); }
  function bytesOf(rec, num) { return sizesByKey.get(rec + '|' + num) || 0; }

  function reciterBytes(prefix) {
    let n = 0, total = 0;
    for (const [k, s] of sizesByKey) {
      if (k.indexOf(prefix) === 0) { n++; total += s || 0; }
    }
    return { count: n, bytes: total };
  }

  function surahCounts(rec, ayahNumbers) {
    let c = 0;
    for (const n of ayahNumbers) if (has(rec, n)) c++;
    return { have: c, total: ayahNumbers.length };
  }

  function gatherReciters() {
    const set = new Set();
    for (const k of sizesByKey.keys()) set.add(String(k).split('|')[0]);
    return Array.from(set);
  }

  async function storeRecord(rec, num, rec0) {
    const blob = rec0.blob || rec0.b;
    if (!blob || !blob.size) throw mkErr('STORE', 'empty blob for ' + rec + '|' + num);
    // stored shape: { b: Blob, m: mime, c: codec, s: bytes, t: savedAt }
    const val = { b: blob, m: rec0.m || blob.type || 'audio', c: rec0.c || '', s: blob.size, t: Date.now() };
    await idbPutRaw(rec, num, val);
    sizesByKey.set(rec + '|' + num, val.s);
    rememberUrl(rec, num, URL.createObjectURL(val.b), val.s);
    emitStats();
  }

  // resolves { url, cached, mime } — downloads (and stores) when needed.
  async function ensure(rec, num, opts) {
    // bundled APK voice first — same-origin asset, no fetch cost at all
    const bu = bundledUrl(rec, num);
    if (bu) return { url: bu, cached: true, mime: (BUNDLED[rec] && BUNDLED[rec].mime) || 'audio/ogg', bundled: true };
    const k = rec + '|' + num;
    if (sizesByKey.has(k)) {
      const m = memUrls.get(k);
      if (m) return { url: m.url, cached: true, mime: 'audio' };
      const v = await idbGetRaw(rec, num);
      if (v && v.b) {
        rememberUrl(rec, num, URL.createObjectURL(v.b), v.s);
        const u = memUrls.get(k);
        return { url: u.url, cached: true, mime: v.m || 'audio' };
      }
    }
    // not stored — fetch from CDN
    let persist = opts && opts.persist != null ? opts.persist : autoSave();
    const f = await fetchAyah(rec, num, opts);
    const rawBlob = new Blob([f.ab], { type: 'audio/mpeg' });
    let res = { url: URL.createObjectURL(rawBlob), cached: false, mime: 'audio/mpeg' };
    if (f.ab) { rememberUrl(rec, num, res.url, f.ab.byteLength); }
    if (persist) {
      try {
        const q = codecSetting();
        let rec0 = null;
        if (q === 'opus32' || q === 'opus24') {
          try { rec0 = await transcodeToOpus(f.ab, q === 'opus24' ? 24 : 32); }
          catch (e) { dbg('transcode unavailable (' + (e && e.message) + ') → keeping mp3'); rec0 = null; }
        }
        if (!rec0) rec0 = { blob: rawBlob, m: 'audio/mpeg', c: 'mp3' + f.bitrate };
        else rec0.m = 'audio/ogg';
        await storeRecord(rec, num, rec0);
        res = { url: memUrls.get(rec + '|' + num).url, cached: true, fetched: true, mime: rec0.m };
      } catch (e) {
        dbg('cache put failed, playing raw anyway: ' + (e && e.message));
      }
    }
    return res;
  }

  // light prefetch — persist only if autoSave is on
  // raw bytes for the native background player (Android AudioBridge): bundled
  // asset → cached blob → CDN fetch (CapacitorHttp, no CORS on native).
  async function getBytes(rec, num, opts) {
    const bu = bundledUrl(rec, num);
    if (bu) {
      const r = await fetch(bu);
      if (!r.ok) throw mkErr('BUNDLED', 'bundled asset missing: ' + bu);
      return await r.arrayBuffer();
    }
    const k = rec + '|' + num;
    if (sizesByKey.has(k)) {
      const v = await idbGetRaw(rec, num);
      if (v && v.b) return await v.b.arrayBuffer();
    }
    const f = await fetchAyah(rec, num, opts || {});
    return f.ab;
  }

  async function prefetch(rec, num) {
    try { await ensure(rec, num, { persist: autoSave() }); } catch (e) { /* streaming path still fine */ }
  }

  // ==================================================================
  // download queue (surahs / whole quran), resumable across restarts
  // ==================================================================
  const queueListeners = [];
  const statsListeners = [];
  function emitQueue() {
    const snap = queueState();
    for (const cb of queueListeners) { try { cb(snap); } catch (e) {} }
    externalPaint();
  }
  function emitStats() {
    for (const cb of statsListeners) { try { cb(stats()); } catch (e) {} }
    emitQueue();
  }

  const jobs = [];                 // [{ rec, title, nums, done, failed }]
  let running = false;
  let paused = false;
  let cancelled = false;

  function queueState() {
    const j = jobs[0];
    if (!j) {
      return { running, paused, count: jobs.length, rec: null, title: '', done: 0, total: 0, failed: 0, bytesDone: 0, bytesTotal: 0, rate: 0, etaSec: null };
    }
    // live progress math — the rate is the raw CDN bytes/sec your connection
    // actually delivers, and the ETA is the measured time per remaining ayah
    // (stays correct across pauses and restarts)
    const leftFetch = Math.max(0, (j.left0 || 0) - (j.obsCount || 0));
    const rateSec = j.activeMs > 0 ? (j.obsRaw || 0) / (j.activeMs / 1000) : 0;
    const msPerAyah = (j.obsCount > 0 && j.activeMs > 0) ? j.activeMs / j.obsCount : 0;
    const etaSec = (j.obsCount > 3 && msPerAyah > 0 && !paused) ? Math.max(1, Math.round(leftFetch * msPerAyah / 1000)) : null;
    const avgRaw = (j.obsCount ? Math.max(1, Math.round((j.obsRaw || 0) / j.obsCount)) : 65000);
    const bytesTotal = Math.max(0, j.left0 || 0) * avgRaw;
    return {
      running, paused,
      count: jobs.length,
      rec: j.rec,
      title: j.title,
      done: j.done,
      total: j.nums.length,
      failed: j.failed,
      bytesDone: j.bytesDone || 0,
      bytesTotal,
      rate: Math.round(rateSec),
      etaSec,
    };
  }

  function fmtEta(sec) {
    if (sec == null || !Number.isFinite(sec)) return '…';
    if (sec < 5) return 'moments';
    if (sec < 90) return '~' + Math.round(sec / 5) * 5 + ' s left';
    if (sec < 5400) return '~' + Math.max(1, Math.round(sec / 60)) + ' min left';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return '~' + h + ' hr' + (m ? ' ' + m + ' min' : '') + ' left';
  }
  function fmtRate(bps) {
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    if (bps >= 1024) return Math.max(1, Math.round(bps / 1024)) + ' KB/s';
    return Math.max(1, Math.round(bps)) + ' B/s';
  }

  function persistJobs() {
    try {
      stSet('audioQueue', runningJobsSnapshot());
    } catch (e) {}
  }
  function runningJobsSnapshot() {
    return jobs.slice(0, 3).map((j) => ({ r: j.rec, t: j.title, nums: j.nums }));
  }
  function resumePersistedJobs() {
    const saved = st('audioQueue', null);
    stSet('audioQueue', null);
    if (saved && saved.length) {
      for (const j of saved) {
        if (j && j.r && Array.isArray(j.nums) && j.nums.length) {
          jobs.push({ rec: String(j.r), title: String(j.t || ''), nums: j.nums.slice(0, 7000), done: 0, failed: 0 });
        }
      }
      if (jobs.length) { dbg('resuming saved downloads'); pump(); }
    }
  }

  async function pump() {
    if (running) return;
    running = true; paused = false; cancelled = false;
    emitQueue();
    while (jobs.length) {
      const job = jobs[0];
      // size estimate: seeded from the codec choice, refined by observed sizes
      if (job.avgBytes == null) {
        const q = codecSetting();
        job.avgBytes = q === 'opus24' ? 24000 : q === 'mp3' ? 152000 : 31000;
      }
      // bytesFetched counts only what this run actually downloads — ayahs that
      // were already cached (or stored before a restart) are free and must not
      // inflate the measured rate
      job.obsCount = 0; job.obsBytes = 0; job.bytesDone = 0; job.obsRaw = 0;
      job.left0 = 0;
      for (const n of job.nums) if (!sizesByKey.has(job.rec + '|' + n)) job.left0++;
      if (job.t0 == null) job.t0 = Date.now();
      job.activeMs = job.activeMs || 0;
      let lastWall = Date.now();
      let lastEmit = 0;
      const tick = () => {
        const now = Date.now();
        if (!paused && now > lastWall) { job.activeMs += now - lastWall; lastWall = now; }
        if (now - lastEmit > 300) { lastEmit = now; emitQueue(); }
      };
      const list = job.nums;
      let idx = 0;
      const worker = async () => {
        while (true) {
          if (cancelled) return;
          if (paused) { await new Promise((r) => setTimeout(r, 300)); continue; }
          const i = idx++;
          if (i >= list.length) return;
          const num = list[i];
          const key = job.rec + '|' + num;
          if (sizesByKey.has(key)) { job.done++; tick(); continue; }
          try {
            const r0 = await storePlane(job.rec, num);
            job.done++;
            job.bytesDone += r0.stored;
            job.obsCount++; job.obsBytes += r0.stored;
            job.obsRaw = (job.obsRaw || 0) + r0.raw;
            job.avgBytes = Math.max(1000, Math.round(job.obsBytes / job.obsCount));
            tick();
          } catch (err) {
            // one silent retry, then count as failed (pauses/cancels are excluded)
            const e1 = err && err.code === 'ABORT' ? null : err;
            if (e1) {
              try {
                await new Promise((r) => setTimeout(r, 400));
                if (cancelled || paused) throw mkErr('ABORT', 'cancelled');
                const r0 = await storePlane(job.rec, num);
                job.done++;
                job.bytesDone += r0.stored;
                job.obsCount++; job.obsBytes += r0.stored;
                job.obsRaw = (job.obsRaw || 0) + r0.raw;
                job.avgBytes = Math.max(1000, Math.round(job.obsBytes / job.obsCount));
              } catch (e2) {
                if (!(e2 && e2.code === 'ABORT')) { job.failed++; dbg('download failed ' + job.rec + '|' + num + ': ' + (e2 && e2.message)); }
              }
            }
          }
          tick();
        }
      };
      // 14 parallel fetches: ayah files are small, so aggregate speed is
      // governed by the number of concurrent HTTP streams (tested: the CDN
      // happily serves 20+ streams at once)
      await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(() => worker()));
      persistJobs();
      emitQueue();
      jobs.shift();
      persistJobs();
      if (cancelled) { cancelled = false; while (jobs.length) jobs.shift(); persistJobs(); break; }
    }
    running = false; paused = false;
    stSet('audioQueue', null);
    emitQueue();
    emitStats();
  }

  // one unit of queue work: fetch + transcode + store, never throws without cancel
  async function storePlane(rec, num) {
    if (cancelled || paused) throw mkErr('ABORT', 'cancelled');
    const f = await fetchAyah(rec, num, {});
    const q = codecSetting();
    let rec0 = null;
    if (q === 'opus32' || q === 'opus24') {
      try { rec0 = await transcodeToOpus(f.ab, q === 'opus24' ? 24 : 32); }
      catch (e) { dbg('transcode fallback (' + (e && e.message) + ')'); rec0 = null; }
    }
    if (!rec0) rec0 = { blob: new Blob([f.ab], { type: 'audio/mpeg' }), m: 'audio/mpeg', c: 'mp3' + f.bitrate };
    else rec0.m = 'audio/ogg';
    await storeRecord(rec, num, rec0);
    return { stored: rec0.blob.size, raw: f.ab.byteLength };
  }

  // nums ← array of global ayah numbers
  function enqueueJob(rec, title, nums) {
    if (!Array.isArray(nums) || !nums.length) return;
    // bundled (APK) ayahs are always available — never enqueue them
    if (BUNDLED && BUNDLED[rec]) {
      const b = BUNDLED[rec].nums;
      nums = nums.filter((n) => !b.has(Number(n)));
      if (!nums.length) { dbg('enqueue skipped — all already bundled: ' + rec); emitQueue(); return; }
    }
    jobs.push({ rec, title, nums: nums.slice(), done: 0, failed: 0 });
    persistJobs();
    emitQueue();
    pump();
  }

  // juz 'amma = surahs 78..114 (Al-Naba' → An-Nas)
  const JUZ_AMMA_FROM = 78;
  function surahNums(surahNumber) {
    const surahs = window.QURAN_AR && window.QURAN_AR.data && window.QURAN_AR.data.surahs;
    if (!surahs) return null;
    const s = surahs[surahNumber - 1];
    if (!s) return null;
    return s.ayahs.map((a) => a.number);
  }
  function wholeQuranNums(rec) {
    const surahs = window.QURAN_AR && window.QURAN_AR.data && window.QURAN_AR.data.surahs;
    if (!surahs) return [];
    const out = [];
    for (const s of surahs) for (const a of s.ayahs) out.push(a.number);
    return out;
  }
  function enqueueSurah(surahNumber, rec) {
    const nums = surahNums(surahNumber);
    if (!nums) { dbg('surah data missing, cannot enqueue ' + surahNumber); return; }
    if (!rec) rec = currentReciter();
    const surahs = window.QURAN_AR.data.surahs;
    enqueueJob(rec, 'Surah ' + surahNumber + ' — ' + (surahs[surahNumber - 1].englishName || ''), nums);
  }
  function enqueueJuzAmma(rec) {
    if (!rec) rec = currentReciter();
    const surahs = window.QURAN_AR && window.QURAN_AR.data && window.QURAN_AR.data.surahs;
    if (!surahs) return;
    const nums = [];
    for (let s = JUZ_AMMA_FROM - 1; s < surahs.length; s++) {
      for (const a of surahs[s].ayahs) nums.push(a.number);
    }
    enqueueJob(rec, 'Juz ʿAmma (78–114)', nums);
  }
  function enqueueWholeQuran(rec) {
    if (!rec) rec = currentReciter();
    enqueueJob(rec, 'Whole Quran (114 surahs)', wholeQuranNums(rec));
  }
  function currentReciter() {
    try { return window.Quran && Quran.RECITERS ? (window.Store.get('reciter', 'ar.alafasy')) : st('reciter', 'ar.alafasy'); }
    catch (e) { return st('reciter', 'ar.alafasy'); }
  }

  function pauseQueue() { paused = true; emitQueue(); }
  function resumeQueue() { paused = false; emitQueue(); }
  function cancelQueue() {
    cancelled = true;
    jobs.splice(1); // drop pending jobs
    emitQueue();
  }
  // delete cache for a reciter (or all)
  async function deleteReciter(rec) {
    memUrls.clear();
    if (!indexReady) return 0;
    if (rec && rec.length) {
      const n = await idbDeletePrefix(rec + '|');
      for (const k of Array.from(sizesByKey.keys())) if (String(k).indexOf(rec + '|') === 0) sizesByKey.delete(k);
      reseedBundled(rec); // bundled voices live in the APK — never deletable
      emitStats();
      dbg('deleted ' + n + ' ayahs for ' + rec);
      return n;
    }
    const n = await idbDeleteKeys(Array.from(sizesByKey.keys()));
    sizesByKey.clear();
    reseedBundled(null);
    emitStats();
    return n;
  }

  // ==================================================================
  // settings UI (self-rendering card — mounted from app.js)
  // ==================================================================
  function fmtBytes(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return Math.round(b / 1048576) + ' MB';
    if (b >= 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    return b + ' B';
  }

  function mountSettings(el) {
    if (!el) return;
    const reciters = (window.Quran && Quran.RECITERS) || [];
    const codec = codecSetting();
    const codecLabel = codec === 'opus24' ? 'Opus 24 kbps' : codec === 'mp3' ? 'MP3 64 kbps' : 'Opus 32 kbps';
    const estText = codec === 'opus24' ? '≈ 340 MB' : codec === 'mp3' ? '≈ 906 MB' : '≈ 450 MB';

    el.textContent = '';
    const note = document.createElement('div');
    note.className = 'off-note';
    note.textContent = 'Recitation downloads are stored on this device (~' + estText + ' for the whole Quran in ' + codecLabel + ') and play with no internet afterwards.';
    el.appendChild(note);

    const rows = [];
    for (const r of reciters) {
      const row = document.createElement('div');
      row.className = 'off-rec';
      row.dataset.rec = r.id;

      const head = document.createElement('div');
      head.className = 'off-head';
      const name = document.createElement('span');
      name.className = 'off-name';
      name.textContent = r.name;
      const info = document.createElement('span');
      info.className = 'off-info';
      head.appendChild(name);
      head.appendChild(info);
      row.appendChild(head);

      const btns = document.createElement('div');
      btns.className = 'off-btns';
      const bSurah = document.createElement('button');
      bSurah.className = 'btn';
      bSurah.title = 'Download Juz ʿAmma (surahs 78–114) for offline playback';
      bSurah.innerHTML = "Juz ʿAmma";
      const bAll = document.createElement('button');
      bAll.className = 'btn btn-primary';
      bAll.title = 'Download the whole Quran for this reciter (~' + estText + ')';
      bAll.innerHTML = "Whole Quran";
      const bDel = document.createElement('button');
      bDel.className = 'btn';
      bDel.title = 'Delete downloaded recitation for this reciter to free space';
      bDel.innerHTML = "Delete";
      btns.appendChild(bSurah);
      btns.appendChild(bAll);
      btns.appendChild(bDel);
      row.appendChild(btns);

      const status = document.createElement('div');
      status.className = 'off-status';
      row.appendChild(status);

      bSurah.addEventListener('click', () => { enqueueJuzAmma(r.id); });
      bAll.addEventListener('click', () => { enqueueWholeQuran(r.id); });
      bDel.addEventListener('click', async () => {
        bDel.disabled = true;
        await deleteReciter(r.id);
        paint();
      });

      rows.push({ r, row, info, status, bSurah, bAll, bDel });
      el.appendChild(row);
    }

    function paint() {
      const msg = queueState();
      for (const p of rows) {
        const { count, bytes } = reciterBytes(p.r.id + '|');
        let info = (count ? count + ' ayahs · ' + fmtBytes(bytes) : 'nothing downloaded') + ' · ' + codecLabel;
        p.info.textContent = info;
        p.bDel.disabled = count === 0 && !msg.running;
        const stEl = p.status;
        stEl.textContent = '';
        stEl.className = 'off-status';
        if (msg.running && msg.rec === p.r.id) {
          const pct = msg.total ? Math.round((100 * msg.done) / msg.total) : 0;
          const bar = document.createElement('div');
          bar.className = 'off-bar';
          const fill = document.createElement('i');
          fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
          bar.appendChild(fill);
          stEl.appendChild(bar);
          const line = document.createElement('div');
          line.className = 'off-status-line';
          const head = msg.paused ? 'paused ' : '⤓ ';
          let txt = head + msg.done + '/' + msg.total + ' ayahs · ' + pct + '%';
          if (!msg.paused && msg.rate) txt += ' · ' + fmtRate(msg.rate) + ' · ' + fmtEta(msg.etaSec);
          if (msg.paused) txt += ' — tap Resume to continue · ' + fmtEta(msg.etaSec);
          if (msg.failed) txt += ' · ' + msg.failed + ' failed';
          line.textContent = txt;
          stEl.appendChild(line);
          p.bAll.textContent = msg.paused ? 'Resume' : 'Pause';
          p.bAll.disabled = false;
        } else {
          const bun = bundledAyahs(p.r.id);
          const allBundled = bun > 0 && count >= bun;
          if (count > 0) {
            const ok = document.createElement('span');
            ok.textContent = allBundled
              ? 'installed ✓ (built-in voice' + (count > bun ? ' + ' + (count - bun) + ' extra' : '') + ')'
              : 'offline-ready ✓';
            stEl.appendChild(ok);
          } else if (bun > 0) {
            const ok = document.createElement('span');
            ok.textContent = 'installed ✓ (built-in voice)';
            stEl.appendChild(ok);
          }
          p.bAll.textContent = 'Whole Quran';
          if (allBundled) {
            p.bAll.title = 'Already installed with the app — this whole voice is built in';
            p.bAll.disabled = true;
          } else {
            p.bAll.title = 'Download the whole Quran for this reciter (~' + estText + ')';
            p.bAll.disabled = false;
          }
        }
      }
    }
    paint();
    offHandlers.paint = paint;
  }
  const offHandlers = { paint: null, mountEl: null };
  function externalPaint() { if (offHandlers.paint) { try { offHandlers.paint(); } catch (e) {} } }

  // ==================================================================
  // self test  (?#autotest&audiotest=1)
  // ==================================================================
  const dbgStage = { stage: 'not-started' };
  async function selfTest() {
    const res = { tried: [] };
    try {
      const t0 = Date.now();
      // 1) raw fetch + transcode round trip
      dbgStage.stage = 'fetch';
      const fetched = await fetchAyah('ar.alafasy', 1, {});
      dbgStage.stage = 'raw-decode';
      const dec = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(fetched.ab.slice(0));
      const rawSec = dec.length / 48000;
      dbgStage.stage = 'encode';
      const enc = await transcodeToOpus(fetched.ab, 32);
      dbgStage.stage = 'ogg-decode';
      const dec2 = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await enc.blob.arrayBuffer());
      const opusSec = dec2.length / 48000;
      dbgStage.stage = 'metrics';
      let rms = 0;
      const ch = dec2.getChannelData(0);
      for (let i = 0; i < ch.length; i += 97) rms += ch[i] * ch[i];
      rms = Math.sqrt(rms / Math.max(1, Math.floor(ch.length / 97)));
      res.roundtrip = {
        rawKB: Math.round(fetched.ab.byteLength / 1024),
        opusKB: Math.round(enc.blob.size / 1024),
        rawSec: +rawSec.toFixed(2),
        opusSec: +opusSec.toFixed(2),
        durDeltaMs: Math.abs(rawSec - opusSec) * 1000,
        rms: +rms.toFixed(4),
        packets: enc.packetCount || 0,
        codec: enc.codec,
        ms: Date.now() - t0,
      };
    } catch (e) {
      res.roundtrip = { error: String((e && e.message) || e), at: dbgStage.stage };
      dbg('roundtrip failed at ' + dbgStage.stage + ': ' + String((e && e.message) || e));
    }
    try {
      // 2) ensure() path for a 64-only reciter and a 128-only reciter
      for (const [rec, br] of [['ar.abdulbasitmurattal', '64-only'], ['ar.minshawi', '128-only']]) {
        const t1 = Date.now();
        const out = await ensure(rec, 1, { persist: false });
        res.tried.push({ rec, expect: br, ok: !!(out && out.url), ms: Date.now() - t1 });
      }
    } catch (e) {
      res.tried.push({ error: String((e && e.message) || e) });
    }
    try {
      // 3) persistence round trip (store + read + delete)
      const f2 = await fetchAyah('ar.alafasy', 2, {});
      await storeRecord('ar.alafasy', 2, { blob: new Blob([f2.ab], { type: 'audio/mpeg' }), m: 'audio/mpeg', c: 'mp3' });
      const got = await idbGetRaw('ar.alafasy', 2);
      await idbDeleteKeys(['ar.alafasy|2']);
      sizesByKey.delete('ar.alafasy|2');
      res.persist = { stored: !!got && got.b && got.b.size > 0 };
    } catch (e) { res.persist = { error: String((e && e.message) || e) }; }
    try { console.log('AUDIOTEST-RESULT ' + JSON.stringify(res)); } catch (e) {}
    return res;
  }

  // ==================================================================
  // wiring for events & misc
  // ==================================================================
  function stats() {
    const perRec = {};
    for (const k of sizesByKey.keys()) {
      const rec = String(k).split('|')[0];
      const s = sizesByKey.get(k) || 0;
      (perRec[rec] = perRec[rec] || { count: 0, bytes: 0 });
      perRec[rec].count++;
      perRec[rec].bytes += s;
    }
    return { ready: indexReady, perRec, totalBytes: Object.values(perRec).reduce((a, b) => a + b.bytes, 0) };
  }
  function onQueue(cb) { if (typeof cb === 'function') queueListeners.push(cb); }
  function onStats(cb) { if (typeof cb === 'function') statsListeners.push(cb); }

  if (typeof location !== 'undefined' && location.hash.indexOf('audiotest') !== -1) {
    dbg('audiotest branch armed');
    window.addEventListener('unhandledrejection', function (ev) {
      try { console.log('AUDIOTEST-UNHANDLED ' + ((ev && ev.reason && ev.reason.message) || String(ev))); } catch (e) {}
    });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        dbg('audiotest: DOMContentLoaded');
        boot().then(
          function () { dbg('audiotest: boot resolved, running self-test'); setTimeout(function () { selfTest(); }, 300); },
          function (err) { dbg('audiotest: boot rejected ' + (err && err.message)); }
        );
      });
    } else {
      boot().then(
        function () { dbg('audiotest: boot resolved, running self-test'); setTimeout(function () { selfTest(); }, 300); },
        function (err) { dbg('audiotest: boot rejected ' + (err && err.message)); }
      );
    }
  }

  // ==================================================================
  // public API
  // ==================================================================
  window.AudioOffline = {
    boot,
    // playback path (quran.js)
    ensure,
    prefetch,
    wrapper: null,
    // queue
    enqueueSurah,
    enqueueJuzAmma,
    enqueueWholeQuran,
    pauseQueue,
    resumeQueue,
    cancelQueue,
    queueState,
    // info + management
    has,
    bytesOf,
    getBytes,
    isBundled,
    bundledAyahs,
    surahCounts,
    reciterBytes,
    stats,
    deleteReciter,
    setCodec(c) { if (c === 'opus32' || c === 'opus24' || c === 'mp3') stSet('audioCodec', c); },
    codec: codecSetting,
    mountSettings,
    isIndexed() { return indexReady; },
    ready: () => boot().then(() => true),
    onQueue,
    onStats,
    fmtBytes,
    fmtEta,
    fmtRate,
    // test hooks
    _muxOggOpus: muxOggOpus,
    _transcode: transcodeToOpus,
    _selfTest: selfTest,
  };
})();
