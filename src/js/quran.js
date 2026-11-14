// Sakinah — Quran reader, audio player, recitation
// Depends on: window.QURAN_AR / window.QURAN_EN (full-quran JSON, alquran.cloud),
//             window.Store (storage.js)

(function () {
  'use strict';

  const AR = (window.QURAN_AR && window.QURAN_AR.data && window.QURAN_AR.data.surahs) || null;
  const EN = (window.QURAN_EN && window.QURAN_EN.data && window.QURAN_EN.data.surahs) || null;

  if (!AR) {
    console.error('[sakinah] Quran data (Arabic) failed to load.');
    // placeholder shoe-in so UI still boots
    window.QURAN_AR = { data: { surahs: [] } };
  }

  const RECITERS = [
    { id: 'ar.alafasy', name: 'Mishary Al-Afasy' },
    { id: 'ar.abdulbasitmurattal', name: 'Abdul Basit (Murattal)' },
    { id: 'ar.abdurrahmaansudais', name: 'Abdurrahman As-Sudais' },
    { id: 'ar.shaatree', name: 'Abu Bakr Ash-Shaatri' },
    { id: 'ar.husary', name: 'Mahmoud Al-Husary' },
    { id: 'ar.minshawi', name: 'Al-Minshawi' },
  ];

  const AUDIO_BASE = 'https://cdn.islamic.network/quran/audio/128/';
  const CDN_FALLBACK = 'https://cdn.islamic.network/quran/audio/64/';

  // ---------- state ----------
  // reader state
  let curSurah = null;           // surah currently OPEN in the reader
  let curIdx = 0;                // index into surah list
  let showTrans = (window.Store && Store.get('showTranslation', true));
  let reciter = (window.Store && Store.get('reciter')) || 'ar.alafasy';
  let autoContinue = (window.Store && Store.get('autoContinue', true));
  let curPage = 0;               // current flip-page within the open surah

  // player state — intentionally separate from the reader, so opening another
  // surah while listening never derails the recitation
  let playCtx = null;            // surah whose recitation is playing
  let curPlayIdx = -1;           // index playing within playCtx
  let playGlobal = -1;           // global ayah number currently playing
  let playOnce = false;          // single-ayah mode (Ayah of the Day) — never continue
  let highlightFn = null;        // per-render highlight / follow-scroll routine
  let barEls = null;             // { root, ar, count } of the floating bar
  const stateListeners = [];     // external subscribers (e.g. app.js)

  // Arabic-Indic digits for the ayah marks
  const AR_DIGITS = { 0: '٠', 1: '١', 2: '٢', 3: '٣', 4: '٤', 5: '٥', 6: '٦', 7: '٧', 8: '٨', 9: '٩' };
  function toArNum(n) {
    return String(n).split('').map((c) => AR_DIGITS[c] || c).join('');
  }

  function markFor(globalAyahNumber, surahNumber) {
    // subhead-style numeral like ۝ but with the count inside — classic mushaf mark
    return '﴿' + toArNum(globalAyahNumber - surahStartOffset(surahNumber)) + '﴾';
  }

  // global ayah number of first ayah of a surah (1-based)
  function surahStartOffset(surahNumber) {
    let total = 0;
    for (const s of AR) {
      if (s.number === surahNumber) return total + 1;
      total += s.ayahs.length;
    }
    return 1;
  }

  // ---------- audio player ----------
  const audio = new Audio();
  audio.preload = 'auto';

  // Offline-first pipeline (audio-offline.js): resolve the ayah from the
  // persistent IndexedDB cache when possible; when not cached, fetch from the
  // CDN (per-reciter bitrate: Abdul Basit & As-Sudais are 64-only, Al-Minshawi
  // is 128-only — handled internally) and store it for later offline use.
  let playOfflineMsg = false;     // floating bar shows an offline notice
  let tryIdx = 0;
  function dbg(m) {
    try { console.log('[sakinah][dbg] ' + m); } catch (e) {}
  }

  function prefetchAhead(surahObj, ayahIdx) {
    if (!window.AudioOffline) return;
    for (let j = ayahIdx + 1; j <= ayahIdx + 2 && j < surahObj.ayahs.length; j++) {
      AudioOffline.prefetch(reciter, surahObj.ayahs[j].number);
    }
  }

  async function playAyah(surahObj, ayahIdx, once) {
    try {
      const a = surahObj.ayahs[ayahIdx];
      if (!a) return stop();
      playCtx = surahObj;
      playOnce = !!once;
      curPlayIdx = ayahIdx;
      playGlobal = a.number;
      playOfflineMsg = false;
      tryIdx = 0;
      notifyChange();

      // Android: hand playback to the native foreground service (screen-off
      // survival + lock-screen / Bluetooth controls). Throws E_OFFLINE the
      // same way as the web path when the ayah is neither cached nor bundled
      // and there is no network — the shared catch below handles it.
      if (window.AudioNative && AudioNative.available()) {
        dbg('route=native → AudioNative.start num=' + a.number);
        await AudioNative.start({
          reciter,
          reciterName: reciterName(),
          surahObj,
          idx: ayahIdx,
          once: !!once,
        });
        return;
      }

      let src = null;
      if (window.AudioOffline) {
        try { await AudioOffline.boot(); } catch (e) {}
        const res = await AudioOffline.ensure(reciter, a.number, {});
        // the reader may have moved on while we were resolving — don't disturb it
        if (playCtx !== surahObj || curPlayIdx !== ayahIdx) return;
        src = res && res.url;
        dbg('resolved num=' + a.number + ' ' + (!res || res.fetched ? 'CDN→now-cached' : 'CACHE HIT') + ' mime=' + (res && res.mime));
        if (src) prefetchAhead(surahObj, ayahIdx);
      }
      if (!src) src = AUDIO_BASE + reciter + '/' + a.number + '.mp3'; // last resort (module absent)
      audio.src = src;
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
      notifyChange();
    } catch (err) {
      if (err && err.code === 'E_OFFLINE') {
        // no cache, no network → keep the bar visible with a calm notice
        dbg('offline & not cached: ' + reciter + String((playCtx && playCtx.ayahs[curPlayIdx] || {}).number));
        playOfflineMsg = true;
        curPlayIdx = -1;
        playGlobal = -1;
        notifyChange();
        return;
      }
      console.error('[sakinah] audio error', err);
      stop();
    }
  }

  audio.addEventListener('ended', () => {
    if (playOnce) { stop(); return; }               // Ayah of the Day: just this ayah
    if (playOfflineMsg) { stop(); return; }
    if (autoContinue && playCtx && curPlayIdx + 1 < playCtx.ayahs.length) {
      prefetchAhead(playCtx, curPlayIdx + 1);
      playAyah(playCtx, curPlayIdx + 1);            // next ayah is (pre)loaded → no gap
    } else {
      stop();
    }
  });

  audio.addEventListener('error', async () => {
    // resilient: ask the resolver once more (e.g. other bitrate / re-fetch)
    const a = playCtx && playCtx.ayahs[curPlayIdx];
    if (a && tryIdx === 0 && window.AudioOffline) {
      tryIdx = 1;
      try {
        const res = await AudioOffline.ensure(reciter, a.number, { persist: false });
        if (playCtx && playCtx.ayahs[curPlayIdx] === a && res && res.url) {
          audio.src = res.url;
          const p = audio.play();
          if (p && p.catch) p.catch(() => stop());
          return;
        }
      } catch (e) {}
    }
    stop();
  });

  function stop() {
    if (window.AudioNative && AudioNative.available() && AudioNative.isActive()) {
      AudioNative.stop();          // native session → service stops → 'stopped' event → internalStop()
      return;
    }
    internalStop();
  }

  function internalStop() {
    playOfflineMsg = false;
    try { audio.pause(); } catch {}
    try { audio.removeAttribute('src'); audio.load(); } catch {}
    curPlayIdx = -1;
    playGlobal = -1;
    playCtx = null;
    notifyChange();
  }

  // ---- native (Android) state mirroring + dry-wake ----
  function nativeDry() {
    if (!window.AudioNative || !AudioNative.available()) return;
    // prefer the native queue's live position — our mirror may have missed
    // "playing" events while the WebView was suspended in the background
    const i = AudioNative.isActive() ? AudioNative.currentIndex() : curPlayIdx;
    const s = playCtx;
    if (!s || i < 0) { AudioNative.stop(); return; }
    if (i + 1 < s.ayahs.length) {
      AudioNative.ensureNext().catch(() => {}); // fetch + append; the service continues itself
    } else {
      AudioNative.stop(); // surah finished — release the service + notification
    }
  }
  if (window.AudioNative && AudioNative.available()) {
    AudioNative.setHandlers({
      state(st, num, idx) {
        if (st === 'playing') {
          if (playCtx && idx >= 0 && idx < playCtx.ayahs.length) {
            curPlayIdx = idx;
            playGlobal = playCtx.ayahs[idx].number;
          }
          playOfflineMsg = false;
          notifyChange();
        } else if (st === 'paused') {
          notifyChange();
        } else {
          internalStop();
        }
      },
      dry: nativeDry,
    });
  }

  // A native session can outlive this WebView: Android may destroy the
  // activity while the app is backgrounded and the service keeps reciting.
  // On the next launch, rebuild the player state (floating bar, highlight,
  // stop button) from the service's live queue so sound is controllable again.
  async function adoptNativeSession() {
    if (!(window.AudioNative && AudioNative.available())) return;
    try {
      const q = await AudioNative.sync();
      if (!q || !q.count || !q.num) return;
      const num = Number(q.num);
      for (const s of AR) {
        const i = s.ayahs.findIndex((a) => a.number === num);
        if (i < 0) continue;
        playCtx = s;
        playOnce = false;
        playOfflineMsg = false;
        curPlayIdx = i;
        playGlobal = num;
        AudioNative.adopt({
          surahObj: s,
          idx: i,
          pos: q.pos,
          count: q.count,
          playing: q.playing,
          reciter: q.reciter || reciter,
          reciterName: reciterName(q.reciter || reciter),
        });
        notifyChange();
        return;
      }
    } catch (e) {}
  }

  function notifyChange() {
    if (highlightFn) { try { highlightFn(); } catch {} }
    updateBar();
    for (const cb of stateListeners) { try { cb(); } catch {} }
  }

  // ---------- floating player bar (lives on the window — always reachable) ----------
  function ensureBar() {
    if (barEls) return;
    const root = document.createElement('div');
    root.className = 'player-bar hidden';
    const pbLabel = document.createElement('div');
    pbLabel.className = 'pb-label';
    const ar = document.createElement('span');
    ar.className = 'pb-ar';
    const count = document.createElement('span');
    count.className = 'pb-count';
    pbLabel.appendChild(ar);
    pbLabel.appendChild(count);
    const btn = document.createElement('button');
    btn.className = 'pb-btn';
    btn.title = 'Stop recitation';
    btn.innerHTML = '<svg><use href="#i-stop"/></svg>';
    btn.addEventListener('click', () => stop());
    root.appendChild(pbLabel);
    root.appendChild(btn);
    document.body.appendChild(root);
    barEls = { root, ar, count, btn };
  }

  function updateBar() {
    if (!barEls) return;
    if (playCtx && playOfflineMsg) {
      barEls.root.classList.remove('hidden');
      barEls.ar.textContent = '⤓ Offline';
      barEls.count.textContent = ' — “' + (playCtx.englishName || playCtx.name) + '” isn’t downloaded yet. Connect once and tap ⤓ in the reader.';
      return;
    }
    if (playCtx && curPlayIdx >= 0) {
      barEls.root.classList.remove('hidden');
      barEls.ar.textContent = playCtx.name;
      barEls.count.textContent = '  ·  ' + (playCtx.englishName || '') + ' ' + (curPlayIdx + 1) + '/' + playCtx.ayahs.length;
    } else {
      barEls.root.classList.add('hidden');
    }
  }

  // ---------- offline download affordances (toolbar ⤓ + list badges) ----------
  const dlRefs = { btn: null, lbl: null, fill: null, line: null, surah: null };
  let wholeRefs = null;               // { btn, label, st } — Whole-Quran quick action
  let dlDebounce = null;

  function surahDlState(s) {
    if (!window.AudioOffline || !AudioOffline.isIndexed()) return null;
    try {
      const cnt = AudioOffline.surahCounts(reciter, s.ayahs.map((a) => a.number));
      const q = AudioOffline.queueState();
      const busy = q.running && q.rec === reciter
        && String(q.title).indexOf('Surah ' + s.number + ' ') === 0;
      return { cnt, q, busy };
    } catch (e) { return null; }
  }

  function etaSuffix(q) {
    if (!window.AudioOffline || q.etaSec == null) return '';
    return ' · ' + AudioOffline.fmtEta(q.etaSec);
  }

  function paintDl() {
    const b = dlRefs.btn, s = dlRefs.surah;
    if (!b || !s) return;
    const row = b.parentNode; // .s-dl-row
    if (!window.AudioOffline) { row.hidden = true; return; }
    row.hidden = false;
    const lbl = dlRefs.lbl, fill = dlRefs.fill, line = dlRefs.line;
    row.classList.remove('busy');
    fill.style.width = '0';
    line.textContent = '';
    b.classList.remove('dl-busy', 'dl-done');
    const st = surahDlState(s);
    if (!st) {
      lbl.textContent = 'Download the surah';
      b.title = 'Download this surah so it keeps playing with no internet';
      paintWhole();
      return;
    }
    if (st.cnt.total > 0 && st.cnt.have >= st.cnt.total) {
      b.classList.add('dl-done');
      lbl.textContent = 'Offline ✓';
      fill.style.width = '100%';
      b.title = 'This surah is downloaded — it plays with no internet';
      line.textContent = 'downloaded · plays with no internet';
    } else if (st.busy) {
      row.classList.add('busy');
      b.classList.add('dl-busy');
      lbl.textContent = st.q.paused ? 'Resume' : 'Pause';
      const pct = st.cnt.total ? Math.round((100 * st.cnt.have) / st.cnt.total) : 0;
      fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
      let txt = (st.q.paused ? 'paused ' : '⤓ downloading ') + st.cnt.have + '/' + st.cnt.total + ' ayahs · ' + pct + '%';
      if (st.q.rate) txt += ' · ' + AudioOffline.fmtRate(st.q.rate);
      if (st.q.etaSec != null) txt += ' · ' + AudioOffline.fmtEta(st.q.etaSec);
      if (st.q.failed) txt += ' · ' + st.q.failed + ' failed';
      line.textContent = txt;
      b.title = st.q.paused ? 'Resume the download' : 'Pause the download';
    } else {
      lbl.textContent = 'Download the surah';
      if (st.cnt.have > 0) {
        fill.style.width = Math.max(2, Math.round((100 * st.cnt.have) / Math.max(1, st.cnt.total))) + '%';
        line.textContent = st.cnt.have + '/' + st.cnt.total + ' ayahs already cached — tap to download the rest';
      }
      b.title = 'Download this surah so it keeps playing with no internet';
    }
    paintWhole();
  }

  function paintWhole() {
    if (!wholeRefs || !window.AudioOffline) return;
    const q = AudioOffline.queueState();
    const b = wholeRefs.btn, label = wholeRefs.label, stEl = wholeRefs.st;
    const mine = q.running && q.rec === reciter && String(q.title).indexOf('Whole Quran') === 0;
    b.classList.toggle('busy', mine);
    stEl.textContent = '';
    if (mine) {
      const pct = q.total ? Math.round((100 * q.done) / q.total) : 0;
      b.disabled = false;
      label.textContent = '⤓ Whole Quran · ' + pct + '%';
      let txt = q.paused ? 'paused ' : 'downloading ';
      txt += q.done + '/' + q.total + ' ayahs';
      if (!q.paused && q.rate) txt += ' · ' + AudioOffline.fmtRate(q.rate) + etaSuffix(q);
      if (q.paused) txt += ' — tap again to resume';
      if (q.failed) txt += ' · ' + q.failed + ' failed';
      stEl.textContent = txt;
      b.title = q.paused ? 'Resume the whole-Quran download' : 'Pause the whole-Quran download';
    } else if (q.running) {
      b.disabled = false;
      label.textContent = 'Whole Quran';
      stEl.textContent = 'downloading ' + (q.rec !== reciter ? 'for another reciter: ' : '') + (q.title || '') + ' — ' + q.done + '/' + q.total + etaSuffix(q);
      b.title = 'Add the whole Quran for ' + reciterName() + ' — queued behind the running job';
    } else {
      label.textContent = 'Whole Quran';
      const { count, bytes } = AudioOffline.reciterBytes(reciter + '|');
      const bun = AudioOffline.bundledAyahs ? AudioOffline.bundledAyahs(reciter) : 0;
      const allBundled = bun > 0 && count >= bun;
      if (count > 0) {
        stEl.textContent = allBundled
          ? count + ' ayahs · installed ✓ (built-in' + (count > bun ? ' + ' + (count - bun) + ' downloaded' : '') + ')'
          : count + ' ayahs cached · ' + AudioOffline.fmtBytes(bytes) + (count < 6236 ? '' : ' — complete ✓');
      } else {
        stEl.textContent = '';
      }
      b.disabled = allBundled;
      b.title = allBundled
        ? 'Already installed with the app — this whole voice is built in'
        : 'Download the full recitation (114 surahs) for offline use';
    }
  }

  function reciterName(forId) {
    const id = forId || reciter;
    for (const r of RECITERS) if (r.id === id) return r.name;
    return id;
  }

  function onQueuePaint() {
    paintDl();
    if (dlDebounce) clearTimeout(dlDebounce);
    dlDebounce = setTimeout(() => { try { renderList(); } catch (e) {} }, 900);
  }

  // ---------- rendering ----------
  let els = null; // { list, search, content }
  let searchQ = '';

  function init(containerEls) {
    els = containerEls;
    ensureBar();

    // adopt recitation that survived an activity reload (service kept playing)
    if (window.AudioNative && AudioNative.available()) {
      adoptNativeSession();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !playCtx && AudioNative.isActive()) {
          adoptNativeSession();
        }
      });
    }

    // offline recitation cache — kick off index load + subscribe for UI updates
    if (window.AudioOffline) {
      try { AudioOffline.boot(); } catch (e) {}
      try { AudioOffline.onQueue(onQueuePaint); } catch (e) {}
    }

    // Whole-Quran quick action (one tap from the list; per-reciter controls live in Settings)
    try {
      const searchWrap = els.search && els.search.closest ? els.search.closest('.search-wrap') : null;
      const pane = els.list && els.list.parentNode;
      const anchor = searchWrap || pane;
      if (anchor && !anchor._wholeBtn) {
        anchor._wholeBtn = true;
        const row = document.createElement('div');
        row.className = 'whole-row';
        const b = document.createElement('button');
        b.className = 'btn whole-btn';
        b.innerHTML = '<svg><use href="#i-download"/></svg><span class="wb-label">Whole Quran</span>';
        b.addEventListener('click', () => {
          if (!window.AudioOffline) return;
          const q = AudioOffline.queueState();
          if (q.running && q.rec === reciter && String(q.title).indexOf('Whole Quran') === 0) {
            // same job is running — the button toggles pause / resume
            if (q.paused) AudioOffline.resumeQueue(); else AudioOffline.pauseQueue();
            return;
          }
          AudioOffline.enqueueWholeQuran(reciter);
        });
        const st = document.createElement('div');
        st.className = 'whole-status';
        row.appendChild(b);
        row.appendChild(st);
        anchor.insertAdjacentElement('afterend', row);
        wholeRefs = { btn: b, label: b.querySelector('.wb-label'), st: st };
      }
    } catch (e) {}

    // phone: back button in the reader returns to the surah list
    const back = document.getElementById('reader-back');
    if (back && !back._wired) {
      back._wired = true;
      back.addEventListener('click', () => {
        const section = document.getElementById('view-quran');
        if (section) section.classList.remove('reader-mode');
      });
    }

    if (els.search) {
      els.search.addEventListener('input', () => {
        searchQ = (els.search.value || '').trim().toLowerCase();
        renderList();
      });
    }

    renderList();

    // restore last position (surah + flip page)
    const last = (window.Store && Store.get('lastSurah')) || 1;
    const lastPage = (window.Store && Store.get('lastPage', 0)) || 0;
    open(Number(last) || 1, Number(lastPage) || 0);

    // keyboard page flipping while the Quran tab is open
    document.addEventListener('keydown', (e) => {
      if (!document.querySelector('#view-quran.active')) return;
      const bg = document.getElementById('settings-backdrop');
      if (bg && !bg.classList.contains('hidden')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { flipPage(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { flipPage(-1); e.preventDefault(); }
    });
  }

  function renderList() {
    if (!els.list) return;
    const frag = document.createDocumentFragment();
    for (const s of AR) {
      const meta = EN && EN[s.number - 1];
      const enSub = meta ? meta.englishNameTranslation : '';
      const hay = (s.englishName + ' ' + enSub + ' ' + s.number).toLowerCase();
      if (searchQ && !hay.includes(searchQ)) continue;

      const btn = document.createElement('button');
      btn.className = 'surah-item' + (curSurah && curSurah.number === s.number ? ' active' : '');
      btn.dataset.num = s.number;

      const num = document.createElement('div');
      num.className = 'surah-num';
      num.textContent = String(s.number).padStart(2, '0');

      const metaBox = document.createElement('div');
      metaBox.className = 'surah-meta';

      const nameRow = document.createElement('div');
      nameRow.className = 'surah-name';
      const en = document.createElement('span');
      en.className = 'n-en';
      en.textContent = s.englishName;
      const ar = document.createElement('span');
      ar.className = 'n-ar';
      ar.setAttribute('lang', 'ar');
      ar.textContent = s.name;
      nameRow.appendChild(en);
      nameRow.appendChild(ar);

      const sub = document.createElement('div');
      sub.className = 'surah-sub';
      sub.textContent = `${enSub} · ${s.revelationType} · ${s.numberOfAyahs || s.ayahs.length} ayahs`;

      metaBox.appendChild(nameRow);
      metaBox.appendChild(sub);

      btn.appendChild(num);
      btn.appendChild(metaBox);

      // offline affordance on the list row: ✓ fully cached · ⤓/percent when not
      if (window.AudioOffline && AudioOffline.isIndexed && AudioOffline.isIndexed()) {
        try {
          const cnt = AudioOffline.surahCounts(reciter, s.ayahs.map((a) => a.number));
          if (cnt.total > 0) {
            const dlb = document.createElement('div');
            if (cnt.have >= cnt.total) {
              dlb.className = 'surah-dl';
              dlb.title = 'Available offline ✓ (current reciter)';
              dlb.innerHTML = '<svg><use href="#i-download"/></svg>';
            } else {
              const q = AudioOffline.queueState();
              const busyThis = q.running && q.rec === reciter
                && String(q.title).indexOf('Surah ' + s.number + ' ') === 0;
              if (busyThis) {
                dlb.className = 'surah-dl busy';
                dlb.textContent = Math.round((100 * cnt.have) / cnt.total) + '%';
                dlb.title = 'Downloading ' + cnt.have + '/' + cnt.total
                  + (q.etaSec != null ? ' · ' + AudioOffline.fmtEta(q.etaSec) : '');
              } else {
                dlb.className = 'surah-dl clickable';
                if (cnt.have > 0) {
                  dlb.textContent = '◦';
                  dlb.title = cnt.have + '/' + cnt.total + ' cached — tap to download the rest';
                } else {
                  dlb.innerHTML = '<svg><use href="#i-download"/></svg>';
                  dlb.title = 'Download this surah for offline listening';
                }
                const idxNum = s.number;
                dlb.addEventListener('click', (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  if (window.AudioOffline) AudioOffline.enqueueSurah(idxNum, reciter);
                });
              }
            }
            btn.appendChild(dlb);
          }
        } catch (e) {}
      }

      btn.addEventListener('click', () => open(s.number));
      frag.appendChild(btn);
    }
    if (!frag.childNodes.length) {
      const d = document.createElement('div');
      d.className = 'surah-sub';
      d.style.padding = '14px';
      d.textContent = 'No surah matches “' + searchQ + '”.';
      frag.appendChild(d);
    }
    els.list.textContent = '';
    els.list.appendChild(frag);
  }

  // ---------- flip-page pagination ----------
  const perPage = () => (showTrans ? 8 : 20);
  function pageCount(s) {
    return Math.max(1, Math.ceil((s ? s.ayahs.length : 0) / perPage()));
  }
  function setPage(p) {
    if (location.hash.indexOf('autotest') !== -1) console.log('[sakinah] setPage -> ' + p);
    if (!curSurah) return;
    curPage = Math.max(0, Math.min(pageCount(curSurah) - 1, p));
    renderReader();
  }
  function flipPage(dir) {
    if (location.hash.indexOf('autotest') !== -1) console.log('[sakinah] flip dir=' + dir + ' cur=' + curPage);
    if (!curSurah) return;
    const np = curPage + dir;
    if (np >= 0 && np < pageCount(curSurah)) { setPage(np); return; }
    // flipping past the edges carries into the neighbouring surah, mushaf-style
    if (dir > 0 && curIdx < AR.length - 1) { open(AR[curIdx + 1].number, 0); return; }
    if (dir < 0 && curIdx > 0) { open(AR[curIdx - 1].number, -1); }
  }

  function open(surahNumber, pageAt) {
    if (location.hash.indexOf('autotest') !== -1) console.log('[sakinah] open su=' + surahNumber + ' pageAt=' + pageAt);
    const idx = AR.findIndex((s) => s.number === surahNumber);
    if (idx < 0) return;
    // on phones, tapping a surah in the list flips to the reader view
    // (pageAt === null/undefined only for taps, not restores or arrows)
    const section = document.getElementById('view-quran');
    if (section && pageAt == null && window.matchMedia('(max-width: 720px)').matches) {
      section.classList.add('reader-mode');
    }
    curIdx = idx;
    curSurah = AR[idx];
    curPage = pageAt === -1
      ? pageCount(curSurah) - 1
      : (Number.isFinite(pageAt) && pageAt > 0 ? Math.min(pageAt, pageCount(curSurah) - 1) : 0);
    if (window.Store) {
      Store.set('lastSurah', surahNumber);
      Store.set('lastPage', curPage);
    }

    renderReader();
    renderList();
    if (els && els.content) {
      const sc = els.content.querySelector('.reader-scroll');
      if (sc) sc.scrollTop = 0;
    }
    notifyChange();
  }

  function renderReader() {
    if (!els.content) return;
    const s = curSurah;
    const sEn = EN && EN[curIdx];
    const content = els.content;
    content.textContent = '';

    const scroll = document.createElement('div');
    scroll.className = 'reader-scroll';

    // ---- toolbar ----
    const bar = document.createElement('div');
    bar.className = 'reader-toolbar';

    const left = document.createElement('div');
    left.className = 'rs-btns';

    const prev = mkToolbarBtn('i-left', 'Previous surah');
    prev.addEventListener('click', () => { if (curIdx > 0) open(AR[curIdx - 1].number, -1); });
    if (curIdx === 0) prev.disabled = true;

    const next = mkToolbarBtn('i-right', 'Next surah');
    next.addEventListener('click', () => { if (curIdx < AR.length - 1) open(AR[curIdx + 1].number); });
    if (curIdx === AR.length - 1) next.disabled = true;

    left.appendChild(prev);
    left.appendChild(next);

    const right = document.createElement('div');
    right.className = 'rs-btns';

    const transBtn = mkToolbarBtn('i-copy', 'Translation ' + (showTrans ? 'on' : 'off'));
    transBtn.classList.toggle('on', showTrans);
    transBtn.textContent = showTrans ? 'Translation' : 'Arabic only';
    transBtn.addEventListener('click', () => {
      showTrans = !showTrans;
      if (window.Store) Store.set('showTranslation', showTrans);
      // re-render: the flip-page size depends on whether translations are shown
      renderReader();
    });

    const recSel = document.createElement('select');
    recSel.className = 'rs-select';
    for (const r of RECITERS) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name;
      if (r.id === reciter) o.selected = true;
      recSel.appendChild(o);
    }
    recSel.addEventListener('change', () => {
      reciter = recSel.value;
      if (window.Store) Store.set('reciter', reciter);
      paintDl();
    });

    right.appendChild(transBtn);
    right.appendChild(recSel);

    bar.appendChild(left);
    bar.appendChild(right);

    // ---- header ----
    const header = document.createElement('div');
    header.className = 'surah-header';
    const hKick = document.createElement('h2');
    hKick.textContent = 'Surah ' + s.number;
    const hAr = document.createElement('div');
    hAr.className = 'h-ar';
    hAr.setAttribute('lang', 'ar');
    hAr.textContent = s.name;
    const hEn = document.createElement('div');
    hEn.className = 'h-en';
    hEn.textContent = s.englishName;
    const hMeta = document.createElement('div');
    hMeta.className = 'h-meta';
    hMeta.textContent = `${sEn ? sEn.englishNameTranslation : ''} · ${s.revelationType} · ${s.ayahs.length} ayahs`;
    header.appendChild(hKick);
    header.appendChild(hAr);
    header.appendChild(hEn);
    header.appendChild(hMeta);

    // ---- "Download the surah" row: at the top of the surah, above the ayahs ----
    const dlRow = document.createElement('div');
    dlRow.className = 's-dl-row';
    dlRow.hidden = !window.AudioOffline;
    const dlMain = document.createElement('button');
    dlMain.type = 'button';
    dlMain.className = 'btn s-dl-btn';
    const dlLbl = document.createElement('span');
    dlLbl.className = 's-dl-lbl';
    dlLbl.textContent = 'Download the surah';
    dlMain.appendChild(dlLbl);
    const dlSide = document.createElement('div');
    dlSide.className = 's-dl-side';
    const dlBar = document.createElement('div');
    dlBar.className = 's-dl-bar';
    const dlFill = document.createElement('i');
    dlBar.appendChild(dlFill);
    const dlLine = document.createElement('div');
    dlLine.className = 's-dl-line';
    dlSide.appendChild(dlBar);
    dlSide.appendChild(dlLine);
    dlRow.appendChild(dlMain);
    dlRow.appendChild(dlSide);
    header.appendChild(dlRow);

    dlMain.addEventListener('click', () => {
      if (!s || !window.AudioOffline) return;
      try {
        const q = AudioOffline.queueState();
        const busyThis = q.running && q.rec === reciter
          && String(q.title).indexOf('Surah ' + s.number + ' ') === 0;
        if (busyThis) {
          if (q.paused) AudioOffline.resumeQueue(); else AudioOffline.pauseQueue();
          paintDl();
          return;
        }
        AudioOffline.enqueueSurah(s.number, reciter);
      } catch (e) {}
      paintDl();
    });
    dlRefs.btn = dlMain;
    dlRefs.lbl = dlLbl;
    dlRefs.fill = dlFill;
    dlRefs.line = dlLine;
    dlRefs.surah = s;
    paintDl();

    // ---- body ----
    const body = document.createElement('div');
    body.className = 'reader-body' + (showTrans ? '' : ' no-trans');

    // bismillah banner (not for Al-Fatihah, which has it as ayah 1; not for At-Tawbah)
    if (s.number !== 1 && s.number !== 9) {
      const bis = document.createElement('div');
      bis.className = 'bismillah ar';
      bis.setAttribute('lang', 'ar');
      bis.textContent = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
      body.appendChild(bis);
    }

    // only the ayahs of the current flip-page are rendered
    const pp = perPage();
    const start = curPage * pp;
    const end = Math.min(start + pp, s.ayahs.length);
    if (location.hash.indexOf('autotest') !== -1) console.log('[sakinah] render su=' + s.number + ' page=' + curPage + ' ayahs=' + (start + 1) + '-' + end);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const block = buildAyah(s, i, sEn && sEn.ayahs[i]);
      frag.appendChild(block);
    }
    body.appendChild(frag);

    // ---- footer nav: surah switch + page flip ----
    const nav = document.createElement('div');
    nav.className = 'reader-nav';
    const prevBig = document.createElement('button');
    prevBig.className = 'btn';
    prevBig.textContent = curIdx > 0 ? '←  ' + AR[curIdx - 1].englishName : 'First surah';
    prevBig.addEventListener('click', () => { if (curIdx > 0) open(AR[curIdx - 1].number, -1); });
    prevBig.disabled = curIdx === 0;
    const nextBig = document.createElement('button');
    nextBig.className = 'btn';
    nextBig.textContent = curIdx < AR.length - 1 ? AR[curIdx + 1].englishName + '  →' : 'Last surah';
    nextBig.addEventListener('click', () => { if (curIdx < AR.length - 1) open(AR[curIdx + 1].number, 0); });
    nextBig.disabled = curIdx === AR.length - 1;

    const mid = document.createElement('div');
    mid.className = 'nav-mid';
    const pgPrev = document.createElement('button');
    pgPrev.className = 'btn';
    pgPrev.title = 'Previous page (← key)';
    pgPrev.textContent = '‹ Page';
    pgPrev.addEventListener('click', () => flipPage(-1));
    pgPrev.disabled = curPage === 0 && curIdx === 0;
    const pgInd = document.createElement('div');
    pgInd.className = 'page-ind';
    pgInd.textContent = 'Page ' + (curPage + 1) + ' of ' + pageCount(s);
    const pgNext = document.createElement('button');
    pgNext.className = 'btn';
    pgNext.title = 'Next page (→ key) — flips into the next surah at the end';
    pgNext.textContent = 'Page ›';
    pgNext.addEventListener('click', () => flipPage(1));
    pgNext.disabled = curPage === pageCount(s) - 1 && curIdx === AR.length - 1;
    mid.appendChild(pgPrev);
    mid.appendChild(pgInd);
    mid.appendChild(pgNext);

    nav.appendChild(prevBig);
    nav.appendChild(mid);
    nav.appendChild(nextBig);

    scroll.appendChild(bar);
    scroll.appendChild(header);
    scroll.appendChild(body);
    scroll.appendChild(nav);

    content.appendChild(scroll);

    // highlight the ayah being recited: follow it inside the page, and flip
    // pages automatically when the recitation moves past this page
    highlightFn = () => {
      const all = body.querySelectorAll('.ayah');
      all.forEach((el) => el.classList.remove('playing'));
      if (playCtx === s && curPlayIdx >= 0) {
        if (curPlayIdx < start || curPlayIdx >= end) {
          if (playCtx === s) setPage(Math.floor(curPlayIdx / pp));
          return;
        }
        const active = body.querySelector('.ayah[data-i="' + curPlayIdx + '"]');
        if (active) {
          active.classList.add('playing');
          const r = active.getBoundingClientRect();
          if (r.bottom < 96 || r.top > innerHeight - 176) {
            const top = active.offsetTop - (scroll.clientHeight / 2) + (active.offsetHeight / 2);
            scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          }
        }
      }
    };
    highlightFn();
    paintDl();
  }

  function mkToolbarBtn(use, title) {
    const b = document.createElement('button');
    b.className = 'rs-btn';
    b.title = title;
    b.innerHTML = '<svg><use href="#' + use + '"/></svg>';
    return b;
  }

  // alquran.cloud's uthmani text prefixes the basmala onto ayah 1 of every
  // surah (except Al-Fatihah & At-Tawbah). The reader shows a decorative
  // bismillah banner instead, so strip the prefix to avoid doubling it.
  const BASMALA_RE = /^بِسْمِ\s*ٱللَّهِ\s*ٱلرَّحْمَٰنِ\s*ٱلرَّحِيمِ\s*/;

  function buildAyah(s, i, aEn) {
    const a = s.ayahs[i];
    const t = aEn && aEn.text ? aEn.text : '';
    let arText = a.text;
    if (i === 0 && s.number !== 1 && s.number !== 9) {
      arText = arText.replace(BASMALA_RE, '');
    }

    const div = document.createElement('div');
    div.className = 'ayah';
    div.dataset.i = i;

    const ar = document.createElement('div');
    ar.className = 'ayah-ar';
    ar.setAttribute('lang', 'ar');
    const txt = document.createElement('span');
    txt.textContent = arText;
    const mark = document.createElement('span');
    mark.className = 'ayah-mark';
    mark.textContent = ' ﴿' + toArNum(a.numberInSurah) + '﴾';
    ar.appendChild(txt);
    ar.appendChild(mark);

    const trans = document.createElement('div');
    trans.className = 'ayah-trans';
    trans.textContent = t;

    const acts = document.createElement('div');
    acts.className = 'ayah-acts';
    const playB = document.createElement('button');
    playB.className = 'a-btn';
    playB.title = 'Play this ayah';
    playB.innerHTML = '<svg><use href="#i-play"/></svg>';
    playB.addEventListener('click', () => playAyah(s, i));
    const copyB = document.createElement('button');
    copyB.className = 'a-btn';
    copyB.title = 'Copy ayah';
    copyB.innerHTML = '<svg><use href="#i-copy"/></svg>';
    copyB.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(a.text + '\n\n' + (t || '') + '\n\n— ' + s.englishName + ' ' + s.number + ':' + a.numberInSurah);
      } catch {}
    });
    acts.appendChild(playB);
    acts.appendChild(copyB);

    div.appendChild(ar);
    div.appendChild(trans);
    div.appendChild(acts);
    return div;
  }

  // ---------- public API ----------
  window.Quran = {
    RECITERS,
    init,
    open,
    setReciter(id) {
      if (!id) return;
      reciter = id;
      paintDl();
      paintWhole();
    },
    offline: {
      downloadSurah(n, rec) { if (window.AudioOffline) AudioOffline.enqueueSurah(n, rec || reciter); },
      downloadJuzAmma(rec) { if (window.AudioOffline) AudioOffline.enqueueJuzAmma(rec || reciter); },
      downloadWholeQuran(rec) { if (window.AudioOffline) AudioOffline.enqueueWholeQuran(rec || reciter); },
      state(s) { const r = s || curSurah; return r ? surahDlState(r) : null; },
    },
    get surah() { return curSurah; },
    flip: {
      next() { flipPage(1); },
      prev() { flipPage(-1); },
      state() { return { page: curPage, of: curSurah ? pageCount(curSurah) : 1 }; },
    },
    player: {
      playAyah(globalNumber) {
        // find surah + index by global ayah number (used by Ayah-of-the-Day)
        if (!AR) return;
        for (const s of AR) {
          for (let i = 0; i < s.ayahs.length; i += 1) {
            if (s.ayahs[i].number === globalNumber) {
              playAyah(s, i);
              return;
            }
          }
        }
      },
      stop() { stop(); },
      playAyahOnce(globalNumber) {
        // Ayah of the Day: find and play ONLY this ayah, then stop
        if (!AR) return;
        for (const s of AR) {
          for (let i = 0; i < s.ayahs.length; i += 1) {
            if (s.ayahs[i].number === globalNumber) {
              playAyah(s, i, true);
              return;
            }
          }
        }
      },
      setAutoContinue(v) { autoContinue = !!v; },
      isPlaying() {
        if (window.AudioNative && AudioNative.available() && AudioNative.isActive()) return AudioNative.isPlaying();
        return !audio.paused;
      },
      isOnce() { return playOnce; },
      currentGlobal() { return playGlobal; },
      onStateChange(cb) { if (typeof cb === 'function') stateListeners.push(cb); },
    },
  };
})();
