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

  // seamless recitation: fetch ayah MP3s as blobs ahead of the playhead,
  // so switching ayahs swaps instantly instead of waiting for a CDN fetch
  const blobCache = new Map();      // "reciter:globalNum" -> object URL
  const prefetching = new Set();
  function cacheKey(globalNum) { return reciter + ':' + globalNum; }
  async function prefetchAyah(globalNum) {
    const k = cacheKey(globalNum);
    if (blobCache.has(k) || prefetching.has(k)) return;
    prefetching.add(k);
    try {
      const r = await fetch(cdlUrls(globalNum)[0]);
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      blobCache.set(k, URL.createObjectURL(blob));
      dbg('prefetch OK num=' + globalNum + ' bytes=' + blob.size + ' cache=' + blobCache.size);
      if (blobCache.size > 40) {
        for (const old of Array.from(blobCache.keys())) {
          URL.revokeObjectURL(blobCache.get(old));
          blobCache.delete(old);
          if (blobCache.size <= 30) break;
        }
      }
    } catch (e) {
      dbg('prefetch FAIL num=' + globalNum + ' err=' + String((e && e.message) || e));
      // leave uncached — the direct-URL streaming path still works
    }
    prefetching.delete(k);
  }
  function prefetchAhead(surahObj, ayahIdx) {
    for (let j = ayahIdx + 1; j <= ayahIdx + 2 && j < surahObj.ayahs.length; j++) {
      prefetchAyah(surahObj.ayahs[j].number);
    }
  }

  function cdlUrls(globalNum) {
    return [AUDIO_BASE + reciter + '/' + globalNum + '.mp3', CDN_FALLBACK + reciter + '/' + globalNum + '.mp3'];
  }

  let tryIdx = 0;
  function dbg(m) {
    try { console.log('[sakinah][dbg] ' + m); } catch (e) {}
  }
  function playAyah(surahObj, ayahIdx, once) {
    if (true) { const _ck = cacheKey(surahObj.ayahs[ayahIdx].number); dbg('play su=' + surahObj.number + ' idx=' + ayahIdx + ' cached=' + (blobCache.has(_ck) ? 'HIT' : 'MISS') + ' fetching=' + prefetching.has(_ck)); }
    try {
      const a = surahObj.ayahs[ayahIdx];
      if (!a) return stop();
      playCtx = surahObj;
      playOnce = !!once;
      curPlayIdx = ayahIdx;
      playGlobal = a.number;
      const cached = blobCache.get(cacheKey(a.number));
      audio.src = cached || cdlUrls(a.number)[0];
      tryIdx = 0;
      prefetchAhead(surahObj, ayahIdx);
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
      notifyChange();
    } catch (err) {
      console.error('[sakinah] audio error', err);
    }
  }

  audio.addEventListener('ended', () => {
    if (playOnce) { stop(); return; }               // Ayah of the Day: just this ayah
    if (autoContinue && playCtx && curPlayIdx + 1 < playCtx.ayahs.length) {
      prefetchAhead(playCtx, curPlayIdx + 1);
      playAyah(playCtx, curPlayIdx + 1);            // next ayah is (pre)loaded → no gap
    } else {
      stop();
    }
  });

  audio.addEventListener('error', () => {
    // resilient: fall back to the 64kbps mirror once
    const a = playCtx && playCtx.ayahs[curPlayIdx];
    if (a && tryIdx === 0) {
      tryIdx = 1;
      audio.src = cdlUrls(a.number)[1];
      const p = audio.play();
      if (p && p.catch) p.catch(() => stop());
    } else {
      stop();
    }
  });

  function stop() {
    try { audio.pause(); } catch {}
    try { audio.removeAttribute('src'); audio.load(); } catch {}
    curPlayIdx = -1;
    playGlobal = -1;
    playCtx = null;
    notifyChange();
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
    if (playCtx && curPlayIdx >= 0) {
      barEls.root.classList.remove('hidden');
      barEls.ar.textContent = playCtx.name;
      barEls.count.textContent = '  ·  ' + (playCtx.englishName || '') + ' ' + (curPlayIdx + 1) + '/' + playCtx.ayahs.length;
    } else {
      barEls.root.classList.add('hidden');
    }
  }

  // ---------- rendering ----------
  let els = null; // { list, search, content }
  let searchQ = '';

  function init(containerEls) {
    els = containerEls;
    ensureBar();

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
    setReciter(id) { if (id) reciter = id; },
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
      isPlaying() { return !audio.paused; },
      isOnce() { return playOnce; },
      currentGlobal() { return playGlobal; },
      onStateChange(cb) { if (typeof cb === 'function') stateListeners.push(cb); },
    },
  };
})();
