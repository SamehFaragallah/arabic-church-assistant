/* Arabic Church Assistant — operator console (desktop app or browser) */
(function () {
  'use strict';
  const VE = window.VerseEngine;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const desktop = window.vfDesktop || null;          // the desktop app's extras (electron/preload.js)

  // ================================================================ server API
  const api = {
    async get(p) {
      const r = await fetch(p, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || 'HTTP ' + r.status);
      return j;
    },
    async post(p, body) {
      const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.message || j.error || 'HTTP ' + r.status); e.data = j; throw e; }
      return j;
    },
  };
  const lost = () => banner('Lost the connection to Arabic Church Assistant\'s server. If this keeps happening, close Arabic Church Assistant and open it again.', 'error', 'conn');

  // ================================================================ banner / status
  let bannerKey = null, bannerTimer = null;
  function banner(html, kind, key, ms) {
    const b = $('#banner');
    b.className = 'banner' + (kind === 'info' ? ' info' : '');
    b.innerHTML = html;
    b.hidden = false;
    bannerKey = key || null;
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(() => clearBanner(key), ms);
  }
  function clearBanner(key) {
    if (key && bannerKey !== key) return;
    $('#banner').hidden = true;
    bannerKey = null;
  }
  let statusText = '';
  function setStatus(s) { if (s !== statusText) { statusText = s; $('#status').textContent = s; } }

  // ================================================================ settings (kept by the server in settings.json)
  const DEFAULTS = { listenLang: 'auto', autoShow: false, catchQuotes: true, autoShowQuotes: false, quoteLive: true, navFollow: true, readAlong: true, readEnd: true, readLead: 1,
    cardOnly: [], tashkeel: true, videoDetect: true, videoAutoPlay: true, videoPlayOnce: true, englishVersion: 'kjv', englishForEnglish: true, showEnglish: false,
    apiBibleAbbr: '', inputKind: 'mic', micName: '', speakerName: '' };
  let settings = Object.assign({}, DEFAULTS);
  async function saveSettings(partial) {
    Object.assign(settings, partial);
    try { await api.post('/api/settings', partial); } catch (e) { banner('Could not save the setting: ' + esc(e.message), 'error', 'save'); }
  }
  function onServerSettings(s) {
    const ver0 = settings.englishVersion + '|' + settings.apiBibleId;
    settings = Object.assign({}, settings, s);
    toPreview({ vfSettings: settings });
    if (detector) detector.opts.quotes = settings.catchQuotes;
    syncControls();
    refreshInputs();
    if (ver0 !== settings.englishVersion + '|' + settings.apiBibleId) loadDisplayEnglish();
    updateStatusLine();
  }

  // ================================================================ Bible
  let bible = null, bibleEn = null, detector = null, director = null, bibleEdition = '', fuzzyIdx = null;
  let hold = false;       // Hold: detections still make cards, but nothing changes the screens by itself (kept by the server, for every console)
  async function loadBibles() {
    setStatus('Loading the Bible…');
    const r = await fetch('/api/bible/ar', { cache: 'no-store' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Could not load the Arabic Bible'); }
    bibleEdition = r.headers.get('X-Bible-Edition') || '';
    bible = new VE.Bible(await r.json());
    detector = new VE.Detector(bible, { quotes: settings.catchQuotes });
    // What goes on screen by itself is decided by the Director (public/engine.js): this page draws the cards and sends the screen.
    director = new VE.Director(bible, detector, { settings: () => settings, card: (c, info) => addCard(c, info), show: putOnScreen, english: () => enBibles,
      sighted: r => warmEnglish(r, r.lang === 'en') });      // a quote is being said: its English text is fetched before it is needed
    director.hold = hold;
    if (lastScreenState) director.onScreen(lastScreenState.type, lastScreenState.ref);
    loadPhrases();
    const qi = new VE.QuoteIndex();
    qi.build(bible).then(() => {
      detector.setQuoteIndex(qi);
      updateStatusLine();
      const fi = new VE.FuzzyQuoteIndex();
      fi.build(bible).then(() => { fuzzyIdx = fi; detector.setFuzzyQuoteIndex(fi); updateStatusLine(); loadEnglish(); });
    });
    loadDisplayEnglish();
  }
  // Set prayers and formulas (Settings -> Set prayers): their words are not quotations
  async function loadPhrases(list) {
    try { if (!list) list = (await api.get('/api/phrases')).phrases; } catch { return; }
    if (detector && Array.isArray(list)) detector.setPhrases(list);
  }
  // English quotes: every built-in translation on this PC (KJV, BSB, WEB, ASV) goes into one index so a
  // quote in any wording (even NIV/ESV-style) is recognized.
  const BUILT_IN_EN = ['kjv', 'bsb', 'web', 'asv'];
  let bibleEnVersion = '', enIndexReady = false;
  let enBibles = [];      // the same translations, kept for following a reading in English (the Director lines the words up with them)
  async function fetchEnglish(v) {
    const r = await fetch('/api/bible/en?v=' + v, { cache: 'no-store' });
    return r.ok ? new VE.Bible(await r.json()) : null;
  }
  async function loadEnglish() {
    let have = {};
    try { have = (await api.get('/api/status')).english || {}; } catch { /* use what we can get */ }
    const versions = BUILT_IN_EN.filter(v => have[v] || v === 'kjv');
    const qe = new VE.QuoteIndex({ tokenize: VE.enTokens }), kept = [];
    for (const v of versions) {
      try { const b = await fetchEnglish(v); if (b) { await qe.addBible(b); kept.push(b); } } catch { /* skip that one */ }
    }
    qe.finalize(); qe.ready = true;
    detector.setEnglishQuoteIndex(qe);
    enBibles = kept;
    enIndexReady = true;
    updateStatusLine();
    if (versions.length < BUILT_IN_EN.length && !loadEnglish.retried) { loadEnglish.retried = true; setTimeout(loadEnglish, 120000); }
  }
  async function loadDisplayEnglish() {
    const v = BUILT_IN_EN.includes(settings.englishVersion) ? settings.englishVersion : 'bsb';
    if (bibleEn && bibleEnVersion === v) return;
    let b = null;
    try { b = await fetchEnglish(v); } catch { /* fall back below */ }
    if (!b && v !== 'kjv') { try { b = await fetchEnglish('kjv'); } catch { /* none */ } bibleEnVersion = 'kjv'; } else bibleEnVersion = v;
    if (b) bibleEn = b;
  }
  const isOnlineEnglish = () => settings.englishVersion === 'esv' || settings.englishVersion === 'apibible';
  const onlineName = () => settings.englishVersion === 'esv' ? 'ESV' : (settings.apiBibleAbbr || 'API.Bible');
  function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('took too long')), ms))]); }
  const enCache = new Map();
  async function englishFor(r, quiet) {
    const e = r.verseEnd || r.verse;
    if (isOnlineEnglish()) {
      const key = `${settings.englishVersion}|${settings.apiBibleId}|${r.book}.${r.chapter}.${r.verse}-${e}`;
      try {
        let j = enCache.get(key);
        if (!j) { j = await withTimeout(api.get(`/api/verse-en?b=${r.book}&c=${r.chapter}&v=${r.verse}&e=${e}`), 4000); enCache.set(key, j); if (enCache.size > 200) enCache.delete(enCache.keys().next().value); }
        if (j && j.verses && j.verses.length) { clearBanner('english'); return { verses: j.verses, version: j.version, fumsId: j.fumsId || null }; }
      } catch (err) {
        if (quiet) return null;
        banner(`Couldn't get the ${esc(onlineName())} text (${esc(err.message)}), so the ${esc(bibleEnVersion.toUpperCase())} is shown instead. Check Settings → English on screen.`, 'info', 'english', 12000);
      }
    }
    if (!bibleEn) return null;
    return { verses: rangeText(r, bibleEn), version: bibleEnVersion.toUpperCase() };
  }

  // An online translation takes a fifth to half a second to answer, and a verse waits for it before it goes up. So the
  // text is asked for as soon as it is likely to be wanted: when a quote is first heard, and for the verse after the
  // one on the screen (a reading goes there next).
  function warmEnglish(r, english) {
    if (!r || r.verse == null || !isOnlineEnglish() || !(settings.showEnglish || (english && settings.englishForEnglish !== false))) return;
    englishFor({ book: r.book, chapter: r.chapter, verse: r.verse }, true).catch(() => {});
  }

  // ================================================================ transcript
  const tEl = $('#transcript');
  let interimEl = null;
  function stickBottom(fn) {
    const atBottom = tEl.scrollHeight - tEl.scrollTop - tEl.clientHeight < 60;
    fn();
    if (atBottom) tEl.scrollTop = tEl.scrollHeight;
  }
  function addFinal(text, found, vids, lang) {
    stickBottom(() => {
      const empty = tEl.querySelector('.empty'); if (empty) empty.remove();
      const p = document.createElement('p');
      p.className = 'seg' + (lang === 'en' ? ' en' : '');
      p.dir = 'auto';
      p.textContent = text;
      for (const c of found) {
        const s = document.createElement('span');
        s.className = 'hit'; s.textContent = c.label; s.title = 'Show ' + c.labelEn;
        s.onclick = () => (c.verse != null ? show(c, 'transcript') : null);
        p.appendChild(s);
      }
      for (const m of vids || []) {
        const s = document.createElement('span');
        s.className = 'hit video'; s.textContent = '▶ ' + m.video.title; s.title = 'Play this video on screen';
        s.onclick = () => playVideo(m.video);
        p.appendChild(s);
      }
      tEl.insertBefore(p, interimEl && interimEl.parentNode ? interimEl : null);
      while (tEl.children.length > 400) tEl.removeChild(tEl.firstChild);
    });
  }
  function setInterim(text) {
    stickBottom(() => {
      if (!interimEl) { interimEl = document.createElement('p'); interimEl.className = 'seg interim'; interimEl.dir = 'auto'; }
      interimEl.textContent = text;
      if (text && !interimEl.parentNode) tEl.appendChild(interimEl);
      if (!text && interimEl.parentNode) interimEl.remove();
    });
  }
  // late: the sentence was heard a while ago (the speech model was loading): for the transcript and the cards, not the screen
  // seg: the engine's number for the sentence (the words still being said carry the same one)
  function handleFinal(text, lang, late, seg) {
    text = (text || '').trim();
    if (!text || !director) return;
    setInterim('');
    const { found } = director.final(text, late, seg);    // cards and screen changes come back through addCard / putOnScreen
    const vids = handleVideos(text);
    addFinal(text, found, vids, lang || (VE.isEnglish(text) ? 'en' : 'ar'));
  }
  function handleInterim(text, seg) {
    setInterim(text);
    if (director && text) director.interim(text, seg);
  }
  // (a screen that moved on at the end of a verse goes back when nothing follows: the rules look once a second)
  setInterval(() => { if (director) director.tick(); }, 1000);

  // ================================================================ cards
  const cardsEl = $('#cards');
  const cards = [];
  const SOURCE_LABEL = { reference: 'Mentioned', context: 'Same chapter', quote: 'Quoted', manual: 'Search', next: 'Next verse', prev: 'Previous verse', read: 'Read on', plan: 'Plan', phrase: 'Set prayer' };
  const isLong = r => r.verseEnd != null && r.verseEnd - r.verse + 1 > 3;   // more than 3 verses: one at a time
  const plain = s => VE.stripTashkeel(s || '');
  const timeStr = t => new Date(t || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // info: from the Director for what it found ({ partial, auto }); absent for cards made by a search, the picker or the phone
  function addCard(c, info) {
    if (director) director.noteCard(c);
    const empty = cardsEl.querySelector('.empty'); if (empty) empty.remove();
    const el = $('#cardTpl').content.firstElementChild.cloneNode(true);
    c.el = el;
    const badge = el.querySelector('.badge');
    badge.textContent = (SOURCE_LABEL[c.source] || c.source) + (c.probable ? ' · not sure' : '') + (c.lang === 'en' ? ' · English' : '') + (inPlan(c) ? ' · 📋 in plan' : '');
    badge.classList.add(c.source);
    el.querySelector('.time').textContent = timeStr(c.time);
    el.querySelector('.card-label').textContent = c.label;
    el.querySelector('.card-label-en').textContent = c.labelEn;
    const textEl = el.querySelector('.card-text');
    const note = el.querySelector('.card-note');
    const showBtn = el.querySelector('.btn-show');
    if (c.verse != null && isLong(c)) {
      textEl.textContent = plain(bible.verse(c.book, c.chapter, c.verse)) + ' …';
      note.textContent = `${c.verseEnd - c.verse + 1} verses: shown one at a time, press Next (→) to move along`;
      showBtn.textContent = 'Show verse ' + c.verse;
      showBtn.onclick = () => show({ book: c.book, chapter: c.chapter, verse: c.verse, verseEnd: c.verseEnd, lang: c.lang }, 'card');
    } else if (c.verse != null) {
      textEl.textContent = rangeText(c).map(v => plain(v.text)).join(' ');
      showBtn.onclick = () => show(c, 'card');
    } else {
      textEl.textContent = 'اختر العدد · pick the verse';
      const grid = el.querySelector('.verse-grid');
      grid.hidden = false;
      const n = bible.verseCount(c.book, c.chapter);
      for (let v = 1; v <= n; v++) {
        const b = document.createElement('button');
        b.textContent = v;
        b.onclick = () => show({ book: c.book, chapter: c.chapter, verse: v }, 'card');
        grid.appendChild(b);
      }
      showBtn.textContent = 'Show verse 1';
      showBtn.onclick = () => show({ book: c.book, chapter: c.chapter, verse: 1 }, 'card');
    }
    if (c.source === 'quote' && c.match && c.match.fuzzy) note.textContent = 'Heard with a few words different: check it is the right verse.';
    if (c.probable) note.textContent = 'The book or chapter was not heard clearly: check it is the right place. It never goes on screen by itself.';
    if (c.source === 'phrase') note.textContent = 'A set prayer (Settings → Set prayers)' + (c.cardOnly ? ': it never goes on screen by itself.' : '.');
    // "Card only": quoted words never put this verse on screen by themselves (a line said every week)
    const never = el.querySelector('.btn-never');
    if (never && c.source === 'quote' && c.verse != null) {
      const key = `${c.book}:${c.chapter}:${c.verse}`;
      const paint = () => { const on = (settings.cardOnly || []).includes(key); never.textContent = on ? '✓ Card only' : 'Card only'; never.classList.toggle('on', on); };
      never.hidden = false;
      paint();
      never.onclick = () => {
        const list = (settings.cardOnly || []).filter(k => k !== key);
        if (list.length === (settings.cardOnly || []).length) list.push(key);
        saveSettings({ cardOnly: list }).then(paint);
      };
    }
    el.querySelector('.card-label').onclick = () => showBtn.click();
    el.querySelector('.btn-plan').onclick = () => { addPlanItems([planItemFor(c)]); el.querySelector('.btn-plan').textContent = '✓ In plan'; };
    if (c.verse != null && (c.lang === 'en' || settings.showEnglish)) {
      const enEl = document.createElement('div');
      enEl.className = 'card-en';
      enEl.dir = 'ltr';
      const r0 = isLong(c) ? { book: c.book, chapter: c.chapter, verse: c.verse } : c;
      if (bibleEn) enEl.textContent = rangeText(r0, bibleEn).map(v => v.text).join(' ') + '  · ' + bibleEnVersion.toUpperCase();
      textEl.after(enEl);
      if (isOnlineEnglish()) englishFor(r0).then(x => { if (x && x.verses.length) enEl.textContent = x.verses.map(v => v.text).join(' ') + '  · ' + x.version; });
      if (!c.lang || c.lang === 'ar') enEl.classList.add('dim');
    }
    if (c.alsoIn && c.alsoIn.length) {
      const also = el.querySelector('.card-also');
      also.append(c.match && c.match.fuzzy ? 'Or perhaps:' : 'Same words also in:');
      for (const r of c.alsoIn) {
        const b = document.createElement('button');
        b.textContent = r.label || VE.refLabel(r); b.title = r.labelEn || VE.refLabel(r, { lang: 'en' });
        b.onclick = () => show(r, 'card');
        also.appendChild(b);
      }
    }
    el.querySelector('.x').onclick = () => { el.remove(); const i = cards.indexOf(c); if (i >= 0) cards.splice(i, 1); };
    cardsEl.prepend(el);
    cards.unshift(c);
    el.classList.add('fresh');
    setTimeout(() => el.classList.remove('fresh'), 6000);
    while (cards.length > 80) { const old = cards.pop(); old.el.remove(); }
    // the record of the service (data\history): what was found, and whether it went up by itself
    if (info && 'auto' in info) {
      api.post('/api/card', { label: c.label, labelEn: c.labelEn, ref: { book: c.book, chapter: c.chapter, verse: c.verse, verseEnd: c.verseEnd || null }, source: c.source,
        auto: !!info.auto, partial: !!info.partial, probable: !!c.probable, match: c.match ? { hits: c.match.hits, fuzzy: !!c.match.fuzzy, fresh: c.match.fresh } : undefined }).catch(() => {});
    }
  }

  // ================================================================ YouTube videos
  let videoLib = { playlists: [] }, videoMatcher = null, videosById = new Map(), playingId = null;
  const mentioned = new Map();
  // when each video was last started or stopped: a hymn announced again plays again, but not one that is playing, and
  // not within 20 s of its start or stop (the same announcement heard twice, or the hymn's own first line)
  const lastPlayed = new Map();
  const mayAutoPlay = id => id !== playingId && Date.now() - (lastPlayed.get(id) || 0) > 20000;
  // the hymns that have played by themselves since the app was opened (Settings: each plays by itself once)
  const autoPlayed = new Set();
  const ytThumb = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
  document.addEventListener('error', e => { if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
  function setLibrary(lib) {
    videoLib = lib && Array.isArray(lib.playlists) ? lib : { playlists: [] };
    videosById = new Map();
    for (const p of videoLib.playlists) for (const v of p.videos || []) if (!videosById.has(v.id)) videosById.set(v.id, Object.assign({ playlist: p.title }, v));
    const all = [...videosById.values()];
    videoMatcher = all.length ? new VE.VideoMatcher(all) : null;
    $('#videoCount').textContent = all.length ? `(${all.length})` : '';
    renderPlaylists();
    renderVideoList();
  }
  function handleVideos(text) {
    if (settings.videoDetect === false) return [];
    const found = videoMatcher ? videoMatcher.process(text) : [];
    // A hymn announced or named that is not in these playlists: what the song database has by that name, as a card to
    // pick from (it never plays by itself). Nothing in the database either, and it was clearly announced: the card
    // offers to look on YouTube.
    const said = songIndex ? songIndex.process(text) : null;
    if (said && !found.some(m => m.cued) && (said.close ? said.kind === 'invite' : said.matches.length || said.named)) {
      addSongsCard(said);
      api.post('/api/hymn', { heard: said.heard, how: said.kind === 'invite' ? 'announced' : 'named', found: said.matches.length, title: said.matches.length ? said.matches[0].video.title : '',
        songs: said.matches.slice(0, 6).map(m => ({ id: m.video.id, title: m.video.title })) }).catch(() => {});   // (the phone lists them too)
    }
    for (const m of found) {
      mentioned.set(m.video.id, Date.now());
      const old = m.repeat && cardsEl.querySelector(`.video-card[data-vid="${CSS.escape(m.video.id)}"]`);
      if (old) {
        cardsEl.prepend(old);
        old.classList.remove('fresh'); void old.offsetWidth; old.classList.add('fresh');
        clearTimeout(old._fresh); old._fresh = setTimeout(() => old.classList.remove('fresh'), 6000);
      } else addVideoCard(m);
      // (mentioned before is no reason not to play: it may not have been clear enough to play then. Played by itself
      //  before is one, unless that is turned off in Settings: the card is there, and its Play button)
      let played = false;
      if (settings.videoAutoPlay && m.sure && mayAutoPlay(m.video.id)) {
        if (settings.videoPlayOnce !== false && autoPlayed.has(m.video.id)) {
          const note = (old || cardsEl.querySelector(`.video-card[data-vid="${CSS.escape(m.video.id)}"]`) || document).querySelector('.card-note');
          if (note && !/already played/.test(note.textContent)) note.textContent += ' (mentioned again: it already played by itself once, so it was not played again)';
        } else { autoPlayed.add(m.video.id); playVideo(m.video, 'auto-video'); played = true; }
      }
      // the log: what was heard, how it was said, and whether it started by itself
      api.post('/api/hymn', { id: m.video.id, title: m.video.title, heard: m.phrase, how: m.invited ? 'announced' : m.cued ? 'named' : 'said', played, mine: true }).catch(() => {});
    }
    if (found.length) renderVideoList();
    return found;
  }
  // ---- the song database (data\songs.json): every title of whole playlists and channels
  let songIndex = null, songSources = [];
  async function loadSongs() {
    try {
      const r = await api.get('/api/songs');
      songSources = r.sources || [];
      const vids = (r.videos || []).map(([id, title, si]) => ({ id, title, playlist: (songSources[si] || {}).title || '' }));
      songIndex = vids.length ? new VE.SongIndex(vids) : null;
    } catch { /* the lists stay as they were */ }
    renderSongSources();
    renderVideoList();
  }
  function renderSongSources() {
    const box = $('#songSources'), wrap = $('#songDb');
    wrap.hidden = !songSources.length;
    if (!songSources.length) return;
    const n = songIndex ? songIndex.size : 0;
    wrap.querySelector('summary').textContent = `Song database: ${n.toLocaleString()} hymns from ${songSources.length} ${songSources.length === 1 ? 'list' : 'lists'}. Searched when an announced hymn is not in your playlists, and by the box below.`;
    box.innerHTML = '';
    for (const p of songSources) {
      const row = document.createElement('div');
      row.className = 'playlist-row';
      row.innerHTML = '<b dir="auto"></b><span class="n"></span><span class="err"></span><button title="Read the list again from YouTube">↻</button><button title="Take this list out of the song database">✕</button>';
      row.querySelector('b').textContent = p.title;
      row.querySelector('.n').textContent = `${p.count} videos` + (p.kind === 'channel' ? ' (a channel)' : '');
      row.querySelector('.err').textContent = p.error ? '⚠ ' + p.error : '';
      const [re, rm] = row.querySelectorAll('button');
      re.onclick = async () => { re.textContent = '…'; try { await api.post('/api/songs/refresh', { id: p.id }); } catch (e) { banner(esc(e.message), 'error', 'videos'); } re.textContent = '↻'; };
      rm.onclick = () => { if (confirm(`Take “${p.title}” out of the song database?`)) api.post('/api/songs/remove', { id: p.id }).catch(() => {}); };
      box.appendChild(row);
    }
  }
  // a row for a video that is not in the user's playlists: with "＋ My videos" (then it is listened for, and plays when announced)
  function outsideRow(v) {
    const row = videoRow(v);
    const add = document.createElement('button');
    add.className = 'btn btn-small btn-ghost';
    add.textContent = videosById.has(v.id) ? '✓ In my videos' : '＋ My videos';
    add.title = 'Add it to your videos, so it is listened for and plays when it is announced';
    add.onclick = async () => {
      add.textContent = '…';
      try { await api.post('/api/videos/add', { url: 'https://www.youtube.com/watch?v=' + v.id }); add.textContent = '✓ In my videos'; }
      catch (e) { add.textContent = '＋ My videos'; banner(esc(e.message), 'error', 'videos', 6000); }
    };
    row.insertBefore(add, row.querySelector('.btn-primary'));
    return row;
  }
  function addSongsCard(a) {
    const key = a.matches.length ? a.matches[0].video.id : a.heard;
    const old = a.repeat && [...cardsEl.querySelectorAll('.songs-card')].find(x => x.dataset.key === key);
    if (old) {
      cardsEl.prepend(old);
      old.classList.remove('fresh'); void old.offsetWidth; old.classList.add('fresh');
      clearTimeout(old._fresh); old._fresh = setTimeout(() => old.classList.remove('fresh'), 6000);
      return;
    }
    const empty = cardsEl.querySelector('.empty'); if (empty) empty.remove();
    const el = $('#songsCardTpl').content.firstElementChild.cloneNode(true);
    el.dataset.key = key;
    el.querySelector('.time').textContent = timeStr();
    el.querySelector('.badge').textContent = a.kind === 'invite' ? 'Hymn announced' : 'Hymn mentioned';
    const n = a.matches.length;
    el.querySelector('.card-note').textContent = `Heard: “${a.heard}”. It is not in your playlists. ` +
      (!n ? 'The song database has nothing that begins like that.'
        : a.close ? 'Nothing in the song database begins exactly like that. The nearest: press Play if it is the one.'
        : (n === 1 ? 'The song database has it' : `The song database has ${n} that begin like that`) + ': press Play on the one you want.');
    const list = el.querySelector('.sc-list');
    for (const m of a.matches) {
      const row = outsideRow(m.video);
      row.querySelector('.btn-primary').addEventListener('click', () => el.classList.add('shown'));
      list.appendChild(row);
    }
    el.querySelector('.sc-yt').onclick = () => { selectTab('videos'); $('#ytInput').value = a.heard; youtubeSearch(a.heard); };
    el.querySelector('.x').onclick = () => el.remove();
    cardsEl.prepend(el);
    el.classList.add('fresh');
    el._fresh = setTimeout(() => el.classList.remove('fresh'), 6000);
  }
  function addVideoCard(m) {
    const empty = cardsEl.querySelector('.empty'); if (empty) empty.remove();
    const el = $('#videoCardTpl').content.firstElementChild.cloneNode(true);
    el.dataset.vid = m.video.id;
    el.querySelector('.time').textContent = timeStr();
    el.querySelector('.vc-thumb').src = ytThumb(m.video.id);
    el.querySelector('.vc-title').textContent = m.video.title;
    el.querySelector('.card-note').textContent = `Heard: “${m.phrase}”` +
      (settings.videoAutoPlay && !m.sure ? (m.invited ? ' (not heard clearly enough to play by itself)' : ' (said, but not announced as a hymn we are about to sing, so it did not play by itself: press Play)') : '');
    const yt = 'https://www.youtube.com/watch?v=' + encodeURIComponent(m.video.id);
    const open = el.querySelector('.vc-open');
    open.href = yt;
    if (desktop) open.onclick = e => { e.preventDefault(); desktop.openExternal(yt); };
    el.querySelector('.btn-play').onclick = () => { playVideo(m.video); el.classList.add('shown'); };
    el.querySelector('.vc-thumb').onclick = () => el.querySelector('.btn-play').click();
    el.querySelector('.x').onclick = () => el.remove();
    cardsEl.prepend(el);
    el.classList.add('fresh');
    setTimeout(() => el.classList.remove('fresh'), 6000);
  }
  // why: 'auto-video' when its title was said and it started by itself (the log and the history say so)
  function playVideo(v, why) {
    lastPlayed.set(v.id, Date.now());
    api.post('/api/video', Object.assign({ action: 'play', id: v.id, title: v.title }, why ? { why } : {})).catch(lost);
    if (desktop && !displayOpen) desktop.openDisplay();
  }
  function renderPlaylists() {
    const box = $('#playlists');
    box.innerHTML = '';
    for (const p of videoLib.playlists) {
      const row = document.createElement('div');
      row.className = 'playlist-row';
      row.innerHTML = '<b dir="auto"></b><span class="n"></span><span class="err"></span><button title="Read the list again from YouTube">↻</button><button title="Remove this playlist">✕</button>';
      row.querySelector('b').textContent = p.title;
      row.querySelector('.n').textContent = `${(p.videos || []).length} videos` + (p.partial ? ' (YouTube gave the newest 15 only)' : '');
      row.querySelector('.err').textContent = p.error ? '⚠ ' + p.error : '';
      const [re, rm] = row.querySelectorAll('button');
      re.onclick = async () => { re.textContent = '…'; try { await api.post('/api/videos/refresh'); } catch (e) { banner(esc(e.message), 'error', 'videos'); } };
      rm.onclick = () => { if (confirm(`Remove the playlist “${p.title}”?`)) api.post('/api/videos/remove', { id: p.id }).catch(() => {}); };
      box.appendChild(row);
    }
  }
  function renderVideoList() {
    const box = $('#videoList');
    const all = [...videosById.values()];
    const f = VE.normalize($('#videoFilter').value || '');
    // what the song database has for the words typed (not what is in the playlists already)
    const more = f && songIndex ? songIndex.search($('#videoFilter').value, 80).filter(v => !videosById.has(v.id)) : [];
    if (!all.length && !more.length) {
      $('#videoMentioned').hidden = true;
      box.innerHTML = f ? '<p class="empty">No title matches that search.</p>'
        : '<p class="empty">Paste a YouTube playlist link above. Its titles are saved on this PC, and when the speaker says one of them it shows up highlighted under Detected.</p>';
      return;
    }
    const recent = id => Date.now() - (mentioned.get(id) || 0) < 10 * 60 * 1000;
    const list = f ? all.filter(v => VE.normalize(v.title).includes(f)) : all.slice();
    // "Just mentioned" has its own section, so the list below never jumps while someone is scrolling it
    // (the newest first; the box is two rows high and scrolls, so the playlist under it keeps its place)
    const ment = all.filter(v => recent(v.id)).sort((a, b) => mentioned.get(b.id) - mentioned.get(a.id)).slice(0, 12);
    $('#videoMentioned').hidden = !ment.length;
    const mbox = $('#videoMentionedList');
    mbox.innerHTML = '';
    for (const v of ment) mbox.appendChild(videoRow(v, recent));
    // two rows high whatever the width of the window makes a row (the style sheet has a height for a usual window)
    fitMentioned.ro = fitMentioned.ro || new ResizeObserver(fitMentioned);
    fitMentioned.ro.disconnect();
    if (mbox.children[0]) fitMentioned.ro.observe(mbox.children[0]);
    fitMentioned();
    const keep = box.scrollTop;
    box.innerHTML = '';
    if (!list.length && !more.length) { box.innerHTML = '<p class="empty">No title matches that search.</p>'; return; }
    for (const v of list.slice(0, 500)) box.appendChild(videoRow(v, recent));
    if (more.length) {
      const h = document.createElement('h3');
      h.className = 'picker-group';
      h.textContent = `From the song database (${more.length}${more.length === 80 ? '+' : ''})`;
      box.appendChild(h);
      for (const v of more) box.appendChild(outsideRow(v));
    }
    box.scrollTop = f ? 0 : keep;
  }
  function fitMentioned() {
    const box = $('#videoMentionedList'), row = box.children[0];
    if (row && row.offsetHeight) box.style.maxHeight = (row.offsetHeight * 2 + 2) + 'px';
  }
  function videoRow(v, recent) {
    const row = document.createElement('div');
    row.className = 'video-row' + (recent && recent(v.id) ? ' mentioned' : '') + (v.id === playingId ? ' playing' : '');
    row.innerHTML = '<img loading="lazy" alt=""><div><div class="t" dir="auto"></div><div class="d"></div></div><button class="btn btn-small btn-ghost" title="Add to the service plan">＋</button><button class="btn btn-small btn-primary">▶ Play</button>';
    row.querySelector('img').src = ytThumb(v.id);
    row.querySelector('.t').textContent = v.title;
    row.querySelector('.d').textContent = [recent && recent(v.id) ? 'mentioned just now' : '', v.duration, v.channel || v.playlist].filter(Boolean).join(' · ');
    const [planB, playB] = row.querySelectorAll('button');
    planB.onclick = () => { addPlanItems([{ kind: 'video', id: v.id, title: v.title }]); planB.textContent = '✓'; };
    playB.onclick = () => playVideo(v);
    return row;
  }

  // ================================================================ YouTube search: play now, add to the plan, add to my videos
  async function youtubeSearch(q) {
    const box = $('#ytResults');
    box.hidden = false;
    box.innerHTML = '<p class="empty">Searching YouTube…</p>';
    try {
      const r = await api.get('/api/youtube/search?q=' + encodeURIComponent(q));
      box.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'sr-head';
      head.innerHTML = `<span>${r.videos.length} results for “${esc(q)}”</span><button class="btn btn-small btn-ghost">Close</button>`;
      head.querySelector('button').onclick = () => { box.hidden = true; };
      box.appendChild(head);
      for (const v of r.videos) {
        const row = videoRow(v);
        const add = document.createElement('button');
        add.className = 'btn btn-small btn-ghost';
        add.textContent = videosById.has(v.id) ? '✓ In my videos' : '＋ My videos';
        add.title = 'Add it to your videos (Videos tab), so it is also noticed when its title is said';
        add.onclick = async () => {
          add.textContent = '…';
          try { await api.post('/api/videos/add', { url: 'https://www.youtube.com/watch?v=' + v.id }); add.textContent = '✓ In my videos'; }
          catch (e) { add.textContent = '＋ My videos'; banner(esc(e.message), 'error', 'videos', 6000); }
        };
        row.insertBefore(add, row.querySelector('.btn-primary'));
        box.appendChild(row);
      }
      if (!r.videos.length) box.insertAdjacentHTML('beforeend', '<p class="empty">Nothing found.</p>');
    } catch (e) { box.innerHTML = `<p class="empty">YouTube search didn't work: ${esc(e.message)}</p>`; }
  }
  function setPauseButton(paused) {
    const b = $('#vidPause');
    b.dataset.paused = paused ? '1' : '0';
    b.textContent = paused ? '▶ Resume' : '⏸ Pause';
  }
  let vidDragging = false, volDragging = false, volTimer = null, vidMuted = false;
  function onVideoStatus(d) {
    if (!d || d.id !== playingId) return;
    const pr = $('#videoProgress');
    if (d.state === 'playing' || d.state === 'paused') {
      pr.hidden = false;
      const dur = Math.max(0, Math.floor(d.duration || 0));
      $('#vidPos').max = dur;
      if (!vidDragging) { $('#vidPos').value = Math.floor(d.time || 0); $('#vidTime').textContent = fmt(d.time); }
      $('#vidDur').textContent = fmt(dur);
      $('#vidState').textContent = d.state === 'paused' ? '⏸ Paused' : '▶ Playing';
      if (typeof d.volume === 'number' && !volDragging) setVolumeUi(d.volume, !!d.muted);
      clearBanner('video');
    } else if (d.state === 'error') banner(esc(d.message || 'The video could not be played.'), 'error', 'video');
    else if (d.state === 'blocked') banner(esc(d.message), 'info', 'video');
    else if (d.state === 'ended') pr.hidden = true;
  }
  function setVolumeUi(v, muted) {
    vidMuted = muted;
    $('#vidVol').value = v;
    $('#vidVolN').textContent = muted ? 'muted' : v + '%';
    $('#vidMute').textContent = muted || v === 0 ? '🔇' : v < 50 ? '🔉' : '🔊';
    $('#vidMute').classList.toggle('on', muted);
  }
  function wireVideoControls() {
    const send = b => api.post('/api/video', b).catch(lost);
    const pos = $('#vidPos');
    pos.oninput = () => { vidDragging = true; $('#vidTime').textContent = fmt(+pos.value); };
    pos.onchange = () => { send({ action: 'seek', t: +pos.value }); setTimeout(() => { vidDragging = false; }, 1200); pos.blur(); };
    $('#vidBack').onclick = () => send({ action: 'skip', by: -10 });
    $('#vidFwd').onclick = () => send({ action: 'skip', by: 10 });
    $('#vidMute').onclick = () => { setVolumeUi(+$('#vidVol').value, !vidMuted); send({ action: 'mute', muted: vidMuted }); };
    const vol = $('#vidVol');
    vol.oninput = () => {
      volDragging = true;
      setVolumeUi(+vol.value, false);
      clearTimeout(volTimer);
      volTimer = setTimeout(() => send({ action: 'volume', volume: +vol.value }), 120);
    };
    vol.onchange = () => { clearTimeout(volTimer); send({ action: 'volume', volume: +vol.value }); setTimeout(() => { volDragging = false; }, 1200); vol.blur(); };
    $('#vidPause').onclick = () => {
      const paused = $('#vidPause').dataset.paused === '1';
      send({ action: paused ? 'resume' : 'pause' });
      setPauseButton(!paused);
    };
    $('#vidRestart').onclick = () => send({ action: 'restart' });
    $('#vidStop').onclick = () => send({ action: 'stop' });
  }

  // ================================================================ showing
  let current = null;
  function rangeText(ref, b) {
    b = b || bible;
    const out = [];
    const end = Math.min(ref.verseEnd || ref.verse, ref.verse + 7);
    for (let v = ref.verse; v <= end; v++) {
      const t = b.verse(ref.book, ref.chapter, v);
      if (t != null) out.push({ n: v, text: t });
    }
    return out;
  }
  // Everything shown goes through the Director, so its rules know what is up; it calls putOnScreen to send it out.
  // why: who or what put it up ('card', 'picker', 'search', 'plan', 'phone', 'arrows' …, or the Director's own reason)
  function show(ref, why) {
    if (!bible || !director || !ref || ref.verse == null) return;
    director.show(ref, why || 'operator');
  }
  async function putOnScreen(r, why) {
    const forceEnglish = r.lang === 'en' && settings.englishForEnglish !== false;
    current = r;
    for (const c of cards) if (c.verse != null && c.book === r.book && c.chapter === r.chapter && c.verse >= r.verse && c.verse <= (r.verseEnd || r.verse)) c.el.classList.add('shown');
    const wantEnglish = settings.showEnglish || forceEnglish;
    const en = wantEnglish ? await englishFor(r) : (bibleEn ? { verses: rangeText(r, bibleEn), version: bibleEnVersion.toUpperCase() } : null);
    if (current !== r) return;   // something else was shown while the English text was loading
    const payload = {
      ref: r, label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }),
      verses: rangeText(r), en: en ? en.verses : null, enVersion: en ? en.version : '', fumsId: en && en.fumsId || null,
      forceEnglish, why,
    };
    try { await api.post('/api/show', payload); } catch { lost(); }
    markPlan();
    const after = bible.next(r.book, r.chapter, r.verseEnd || r.verse);
    if (after && after.book === r.book && after.chapter === r.chapter) warmEnglish(after, r.lang === 'en');
  }
  function clearScreen() { api.post('/api/clear').catch(() => {}); }
  // Back: what was on the screen before (a verse, a message, or nothing), and the reading carries on from there
  async function goBack() {
    try { const r = await api.post('/api/back'); if (!r.ok) banner('Nothing to go back to.', 'info', 'back', 3000); } catch { lost(); }
  }
  function setHold(on) { api.post('/api/hold', { on: !!on }).catch(lost); }
  function onHold(on) {
    hold = !!on;
    if (director) director.hold = hold;
    $('#holdToggle').checked = hold;
    document.body.classList.toggle('holding', hold);
    if (hold) banner('<b>Hold is on.</b> Verses are still found and listed, but nothing goes on screen by itself. <button class="btn btn-small" id="holdOff">Turn Hold off</button>', 'info', 'hold');
    else clearBanner('hold');
    const b = document.getElementById('holdOff');
    if (b) b.onclick = () => setHold(false);
  }
  function step(dir, by) {
    if (!current || !bible) return;
    const base = dir > 0 ? (current.verseEnd || current.verse) : current.verse;
    const n = dir > 0 ? bible.next(current.book, current.chapter, base) : bible.prev(current.book, current.chapter, base);
    if (n) show(Object.assign(n, { lang: current.lang }), by || 'arrows');
  }
  function showNewest(by) { const c = cards.find(x => x.verse != null); if (c) show(c, by || 'newest'); }

  // ================================================================ search: a reference, or words from a verse
  let plainVerses = null;
  function findByWords(q) {
    if (!bible) return [];
    const english = /[a-z]/i.test(q) && !/[؀-ۿ]/.test(q);
    const words = english ? q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1)
      : VE.normalize(q).split(' ').filter(w => w.length > 1);
    if (!words.length) return [];
    if (english) {
      const out = [];
      if (!bibleEn) return out;
      bibleEn.books.forEach((chs, bi) => chs.forEach((vs, ci) => vs.forEach((t, vi) => {
        if (out.length < 40) { const l = t.toLowerCase(); if (words.every(w => l.includes(w))) out.push({ book: bi + 1, chapter: ci + 1, verse: vi + 1, lang: 'en' }); }
      })));
      return out;
    }
    if (!plainVerses) {
      plainVerses = [];
      bible.books.forEach((chs, bi) => chs.forEach((vs, ci) => vs.forEach((t, vi) => plainVerses.push([bi + 1, ci + 1, vi + 1, ' ' + VE.normalize(t) + ' ']))));
    }
    const out = [];
    for (const [b, c, v, t] of plainVerses) {
      if (words.every(w => t.includes(w))) { out.push({ book: b, chapter: c, verse: v, lang: 'ar' }); if (out.length >= 40) break; }
    }
    if (!out.length && fuzzyIdx) {                     // nothing word for word: the closest verse
      const q2 = fuzzyIdx.query(VE.qtokens(q));
      if (q2) out.push({ book: q2.book, chapter: q2.chapter, verse: q2.verse, lang: 'ar', fuzzy: true });
    }
    return out;
  }
  function renderSearchResults(list, q) {
    const box = $('#searchResults');
    box.innerHTML = '';
    box.hidden = false;
    const head = document.createElement('div');
    head.className = 'sr-head';
    head.innerHTML = `<span>${list.length ? `${list.length >= 40 ? '40+' : list.length} verse${list.length === 1 ? '' : 's'} with “${esc(q)}”` : `No verse has all of “${esc(q)}”.`}</span><button class="btn btn-small btn-ghost">Close</button>`;
    head.querySelector('button').onclick = () => { box.hidden = true; };
    box.appendChild(head);
    for (const r of list) {
      const row = document.createElement('button');
      row.className = 'sr-row';
      const txt = r.lang === 'en' && bibleEn ? bibleEn.verse(r.book, r.chapter, r.verse) : plain(bible.verse(r.book, r.chapter, r.verse));
      row.innerHTML = '<b></b><span></span>';
      row.querySelector('b').textContent = (r.lang === 'en' ? VE.refLabel(r, { lang: 'en' }) : VE.refLabel(r)) + (r.fuzzy ? ' ≈' : '');
      row.querySelector('span').textContent = txt || '';
      row.querySelector('span').dir = r.lang === 'en' ? 'ltr' : 'rtl';
      row.onclick = () => {
        const c = Object.assign({}, r, { verseEnd: null, source: 'manual', time: Date.now(), label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }) });
        addCard(c);
        show(c, 'search');
      };
      box.appendChild(row);
    }
  }

  // ================================================================ Bible picker: book → chapter → verse
  const picker = { book: null, chapter: null, anchor: null };
  function pickerShow(book, chapter, verse, verseEnd) {
    const r = { book, chapter, verse, verseEnd: verseEnd && verseEnd > verse ? verseEnd : null };
    const c = Object.assign({}, r, { source: 'manual', lang: 'ar', time: Date.now(), label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }) });
    addCard(c);
    show(c, 'picker');
    markPicker();
  }
  function markPicker() {
    document.querySelectorAll('#pickerBody .pick-verse').forEach(row => {
      const v = +row.dataset.v;
      row.classList.toggle('on', !!(current && current.book === picker.book && current.chapter === picker.chapter && v >= current.verse && v <= (current.verseEnd || current.verse)));
      row.classList.toggle('anchor', picker.anchor === v);
    });
    const note = $('#pickerBody .picker-note');
    if (note) note.textContent = picker.anchor ? `Shift+click another verse to show ${picker.anchor} to it.` : 'Click a verse to show it. Shift+click a second verse for a passage.';
  }
  function pickerGo(book, chapter) {
    picker.book = book;
    picker.chapter = chapter || (book && bible.chapterCount(book) === 1 ? 1 : null);
    picker.anchor = null;
    renderPicker();
    $('#pickerBody').scrollTop = 0;
  }
  function renderPicker() {
    const body = $('#pickerBody'), crumbs = $('#pickerCrumbs');
    if (!bible) { body.innerHTML = '<p class="empty">The Bible is still loading…</p>'; return; }
    const B = VE.BOOKS;
    crumbs.innerHTML = '';
    const crumb = (label, fn) => {
      const b = document.createElement('button'); b.textContent = label;
      if (fn) b.onclick = fn; else b.className = 'here';
      crumbs.appendChild(b);
    };
    crumb('📖 الكتاب المقدس', picker.book ? () => pickerGo(null) : null);
    if (picker.book) crumb(`${B[picker.book - 1].ar} · ${B[picker.book - 1].en}`, picker.chapter && bible.chapterCount(picker.book) > 1 ? () => pickerGo(picker.book) : null);
    if (picker.chapter && bible.chapterCount(picker.book) > 1) crumb((picker.book === 19 ? 'مزمور ' : 'أصحاح ') + VE.toArabicDigits(picker.chapter), null);
    $('#pickerFilter').hidden = !!picker.book;
    body.innerHTML = '';
    if (!picker.book) {
      const f = VE.normalize($('#pickerFilter').value || '');
      let shown = 0, only = null;
      for (const [title, from, to] of [['العهد القديم · Old Testament', 1, 39], ['العهد الجديد · New Testament', 40, 66]]) {
        const list = B.slice(from - 1, to).filter(b => !f || VE.normalize(b.ar).includes(f) || VE.normalize(b.en).includes(f));
        if (!list.length) continue;
        const h = document.createElement('h3'); h.className = 'picker-group'; h.textContent = title; body.appendChild(h);
        const grid = document.createElement('div'); grid.className = 'picker-books';
        for (const b of list) {
          const btn = document.createElement('button');
          btn.className = 'pick-book' + (current && current.book === b.num ? ' on' : '');
          btn.innerHTML = '<b dir="rtl"></b><small></small>';
          btn.querySelector('b').textContent = b.ar;
          btn.querySelector('small').textContent = b.en;
          btn.onclick = () => pickerGo(b.num);
          grid.appendChild(btn);
          shown++; only = b.num;
        }
        body.appendChild(grid);
      }
      if (!shown) body.innerHTML = '<p class="empty">No book by that name.</p>';
      $('#pickerFilter').onkeydown = e => { if (e.key === 'Enter' && shown === 1) pickerGo(only); };
      return;
    }
    if (!picker.chapter) {
      const grid = document.createElement('div'); grid.className = 'picker-nums';
      for (let c = 1; c <= bible.chapterCount(picker.book); c++) {
        const btn = document.createElement('button');
        btn.textContent = c;
        if (current && current.book === picker.book && current.chapter === c) btn.className = 'on';
        btn.onclick = () => pickerGo(picker.book, c);
        grid.appendChild(btn);
      }
      body.appendChild(grid);
      return;
    }
    const note = document.createElement('p'); note.className = 'picker-note';
    body.appendChild(note);
    const n = bible.verseCount(picker.book, picker.chapter);
    for (let v = 1; v <= n; v++) {
      const row = document.createElement('button');
      row.className = 'pick-verse';
      row.dataset.v = v;
      row.innerHTML = '<span class="n"></span><span class="t" dir="rtl" lang="ar"></span>';
      row.querySelector('.n').textContent = VE.toArabicDigits(v);
      row.querySelector('.t').textContent = VE.stripTashkeel(bible.verse(picker.book, picker.chapter, v) || '');
      row.onclick = e => {
        if (e.shiftKey && picker.anchor && picker.anchor !== v) {
          const a = Math.min(picker.anchor, v), z = Math.max(picker.anchor, v);
          picker.anchor = null;
          pickerShow(picker.book, picker.chapter, a, z);
        } else {
          picker.anchor = v;
          pickerShow(picker.book, picker.chapter, v);
        }
      };
      body.appendChild(row);
    }
    markPicker();
    const nav = document.createElement('div'); nav.className = 'picker-chapnav';
    const total = bible.chapterCount(picker.book);
    if (picker.chapter > 1) { const b = document.createElement('button'); b.className = 'btn btn-small'; b.textContent = '◀ Chapter ' + (picker.chapter - 1); b.onclick = () => pickerGo(picker.book, picker.chapter - 1); nav.appendChild(b); }
    if (picker.chapter < total) { const b = document.createElement('button'); b.className = 'btn btn-small'; b.textContent = 'Chapter ' + (picker.chapter + 1) + ' ▶'; b.onclick = () => pickerGo(picker.book, picker.chapter + 1); nav.appendChild(b); }
    body.appendChild(nav);
  }

  // ================================================================ service plan
  let plan = { items: [] }, planPos = -1;
  const planKey = it => it.kind === 'video' ? 'v:' + it.id : `${it.book}:${it.chapter}:${it.verse || 0}-${it.verseEnd || 0}`;
  function planItemFor(c) {
    return { kind: 'verse', book: c.book, chapter: c.chapter, verse: c.verse, verseEnd: c.verseEnd || null, label: c.label, labelEn: c.labelEn };
  }
  function inPlan(c) { return plan.items.some(it => it.kind !== 'video' && it.book === c.book && it.chapter === c.chapter && (it.verse == null || c.verse == null || (c.verse >= it.verse && c.verse <= (it.verseEnd || it.verse)))); }
  async function savePlan(items) {
    try { plan = await api.post('/api/plan', { items }); renderPlan(); } catch (e) { banner('Could not save the plan: ' + esc(e.message), 'error', 'plan'); }
  }
  function addPlanItems(items) {
    const keys = new Set(plan.items.map(planKey));
    savePlan(plan.items.concat(items.filter(it => !keys.has(planKey(it)))));
  }
  function parsePlanLines(text) {
    const items = [], bad = [];
    for (const line of String(text || '').split(/\r?\n|[؛;]/)) {
      const l = line.trim();
      if (!l) continue;
      const r = bible && VE.parseQuery(l, bible);
      if (r) {
        if (r.verse != null && !bible.valid(r.book, r.chapter, r.verse)) { r.verse = null; r.verseEnd = null; }
        items.push({ kind: 'verse', book: r.book, chapter: r.chapter, verse: r.verse, verseEnd: r.verseEnd || null, label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }) });
        continue;
      }
      const n = VE.normalize(l);
      const v = n.length >= 4 && [...videosById.values()].find(x => VE.normalize(x.title).includes(n));
      if (v) { items.push({ kind: 'video', id: v.id, title: v.title }); continue; }
      bad.push(l);
    }
    return { items, bad };
  }
  function renderPlan() {
    const box = $('#planList');
    $('#planCount').textContent = plan.items.length ? `(${plan.items.length})` : '';
    box.innerHTML = '';
    if (!plan.items.length) { box.innerHTML = '<p class="empty">No plan yet. Type or paste references above, or press <b>＋ Plan</b> on any card.</p>'; return; }
    plan.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'plan-row' + (i === planPos ? ' on' : '');
      row.innerHTML = '<span class="pn"></span><div class="pt"><b dir="auto"></b><small dir="auto"></small></div><button class="btn btn-small" title="Move up">▲</button><button class="btn btn-small" title="Move down">▼</button><button class="btn btn-small btn-ghost" title="Remove">✕</button><button class="btn btn-small btn-primary"></button>';
      row.querySelector('.pn').textContent = i + 1;
      if (it.kind === 'video') {
        row.querySelector('b').textContent = '🎵 ' + it.title;
        row.querySelector('small').textContent = 'Hymn / video';
      } else {
        row.querySelector('b').textContent = it.label;
        const t = bible && it.verse != null ? plain(bible.verse(it.book, it.chapter, it.verse)) : '';
        row.querySelector('small').textContent = it.labelEn + (t ? ' — ' + t.slice(0, 80) + (t.length > 80 ? '…' : '') : '');
      }
      const [up, down, rm, go] = row.querySelectorAll('button');
      go.textContent = it.kind === 'video' ? '▶ Play' : 'Show';
      go.onclick = () => runPlanItem(i);
      up.disabled = i === 0; down.disabled = i === plan.items.length - 1;
      const move = d => { const a = plan.items.slice(); const [x] = a.splice(i, 1); a.splice(i + d, 0, x); savePlan(a); };
      up.onclick = () => move(-1); down.onclick = () => move(1);
      rm.onclick = () => savePlan(plan.items.filter((_, k) => k !== i));
      box.appendChild(row);
    });
  }
  function runPlanItem(i) {
    const it = plan.items[i];
    if (!it) return;
    planPos = i;
    if (it.kind === 'video') { const v = videosById.get(it.id) || { id: it.id, title: it.title }; playVideo(v); renderPlan(); return; }
    if (it.verse == null) { pickerGo(it.book, it.chapter); selectTab('bible'); renderPlan(); return; }
    show({ book: it.book, chapter: it.chapter, verse: it.verse, verseEnd: it.verseEnd }, 'plan');
    renderPlan();
  }
  function markPlan() {
    if (!current) return;
    const i = plan.items.findIndex(it => it.kind !== 'video' && it.book === current.book && it.chapter === current.chapter && it.verse != null &&
      current.verse >= it.verse && current.verse <= (it.verseEnd || it.verse));
    if (i >= 0 && i !== planPos) { planPos = i; renderPlan(); }
  }

  // ================================================================ history
  // why something went on the screen (the server keeps it with each row)
  const WHY = { 'auto-reference': 'by itself: reference heard', 'auto-context': 'by itself: verse number heard', 'auto-quote': 'by itself: quote heard',
    'auto-quote+': 'by itself: quote heard (with the verses before it)', 'auto-phrase': 'by itself: set prayer', 'auto-next': 'by itself: “next verse” said',
    'auto-prev': 'by itself: “previous verse” said', 'spoken-next': 'by itself: “next verse” said', 'spoken-prev': 'by itself: “previous verse” said',
    'read-along': 'by itself: followed the reading', 'read-on': 'by itself: followed the reading', 'end-of-verse': 'by itself: followed the reading (verse ended)',
    'reading-stopped': 'by itself: the reading stopped, back one verse', 'chapter-opening': 'by itself: chapter announced, opening words heard',
    card: 'operator: a card', picker: 'operator: Bible tab', search: 'operator: search', plan: 'operator: plan', phone: 'phone remote', arrows: 'operator: next / previous',
    newest: 'operator: Enter', transcript: 'operator: transcript', history: 'operator: history', operator: 'operator', back: 'Back', 'video-ended': 'the video ended', console: 'operator', 'auto-video': 'by itself: its title was said' };
  async function loadHistory(day) {
    const sel = $('#historyDay'), body = $('#historyBody');
    try {
      const h = await api.get('/api/history');
      const days = h.days.length ? h.days : [{ day: h.today, shown: 0, heard: 0 }];
      if (!h.days.some(d => d.day === h.today)) days.unshift({ day: h.today, shown: 0, heard: 0 });
      const want = day || sel.value || h.today;
      sel.innerHTML = '';
      for (const d of days) {
        const o = document.createElement('option');
        o.value = d.day;
        o.textContent = `${new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })} · ${d.shown} shown`;
        sel.appendChild(o);
      }
      sel.value = days.some(d => d.day === want) ? want : days[0].day;
      const r = await api.get('/api/history/day?d=' + encodeURIComponent(sel.value));
      body.innerHTML = '';
      const rows = r.rows || [];
      const shown = rows.filter(x => x.type === 'shown' || x.type === 'video' || x.type === 'message' || x.type === 'clear');
      const h3 = document.createElement('h3'); h3.className = 'picker-group'; h3.textContent = `On screen (${shown.length})`; body.appendChild(h3);
      if (!shown.length) body.insertAdjacentHTML('beforeend', '<p class="empty">Nothing was put on screen yet.</p>');
      for (const x of shown) {
        const b = document.createElement('button');
        b.className = 'hist-row';
        b.innerHTML = '<span class="ht"></span><b dir="auto"></b><small dir="auto"></small>';
        b.querySelector('.ht').textContent = new Date(x.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        if (x.type === 'shown') {
          b.querySelector('b').textContent = x.label || '';
          b.querySelector('small').textContent = (x.labelEn || '') + (WHY[x.why] ? ' · ' + WHY[x.why] : '');
          b.title = 'Show it again';
          b.onclick = () => x.ref && show(x.ref, 'history');
        } else if (x.type === 'clear') {
          b.querySelector('b').textContent = '— screen cleared';
          b.querySelector('small').textContent = WHY[x.why] || '';
          b.disabled = true;
        } else if (x.type === 'video') {
          b.querySelector('b').textContent = '🎵 ' + (x.title || '');
          b.querySelector('small').textContent = WHY[x.why] || '';          // (by itself: its title was said / operator)
          b.onclick = () => playVideo({ id: x.id, title: x.title });
        } else {
          b.querySelector('b').textContent = '✎ ' + (x.title || '');
          b.querySelector('small').textContent = (x.text || '').slice(0, 80);
          b.onclick = () => api.post('/api/message', { title: x.title, text: x.text }).catch(lost);
        }
        body.appendChild(b);
      }
      const heard = rows.filter(x => x.type === 'heard');
      const h4 = document.createElement('h3'); h4.className = 'picker-group'; h4.textContent = `Transcript (${heard.length} sentences)`; body.appendChild(h4);
      const pre = document.createElement('div');
      pre.className = 'hist-transcript';
      pre.dir = 'auto';
      for (const x of heard.slice(-600)) {
        const p = document.createElement('p');
        p.dir = 'auto';
        p.textContent = x.text;
        // (when it was heard, and where it is in the sound recording of the service)
        p.title = new Date(x.t).toLocaleTimeString() + (x.rec ? ` · ${x.rec} at ${Math.floor(x.at / 60)}:${String(Math.floor(x.at % 60)).padStart(2, '0')}` : '');
        pre.appendChild(p);
      }
      body.appendChild(pre);
    } catch (e) { body.innerHTML = `<p class="empty">Could not read the history: ${esc(e.message)}</p>`; }
  }

  // ================================================================ preview / what is on screen
  let lastScreenState = null;
  function toPreview(msg) {
    const f = $('#preview');
    try { if (f && f.contentWindow) f.contentWindow.postMessage(msg, location.origin); } catch { /* not loaded yet */ }
  }
  function onScreenState(s) {
    lastScreenState = s;
    toPreview({ vfScreen: s });
    if (director) director.onScreen(s.type, s.ref, !!s.back);
    const pill = $('#livePill');
    const isVideo = s.type === 'video' && s.video;
    pill.classList.toggle('video', !!isVideo);
    $('#videoControls').hidden = !isVideo;
    if (!isVideo) { $('#videoProgress').hidden = true; clearBanner('video'); }
    const was = playingId;
    playingId = isVideo ? s.video.id : null;
    if (was && was !== playingId) lastPlayed.set(was, Date.now());
    if (isVideo) {
      pill.textContent = 'VIDEO · ' + (s.video.title || '');
      pill.classList.add('on');
      setPauseButton(!!s.paused);
      if (was !== playingId) {
        $('#videoProgress').hidden = false;
        $('#vidPos').value = 0; $('#vidPos').max = 0; $('#vidTime').textContent = '0:00'; $('#vidDur').textContent = '0:00';
        $('#vidState').textContent = 'Starting…';
      }
      if (typeof s.volume === 'number') setVolumeUi(s.volume, !!s.muted);
    } else if (s.type === 'show') {
      pill.textContent = 'LIVE · ' + (s.labelEn || '');
      pill.classList.add('on');
      if (s.ref) current = s.ref;
      if (!$('#paneBible').hidden) markPicker();
      markPlan();
    } else if (s.type === 'message') {
      pill.textContent = 'MESSAGE · ' + (s.title || (s.text || '').slice(0, 30));
      pill.classList.add('on');
    } else {
      pill.textContent = 'Nothing showing';
      pill.classList.remove('on');
    }
    if (was !== playingId) renderVideoList();
  }

  // ================================================================ speech engine (on this PC)
  let speech = { state: 'starting' }, devices = { mics: [], speakers: [] }, listening = false, lastLatency = null;
  function onSpeech(st) {
    speech = st || {};
    listening = !!speech.listening;
    setButton(listening ? 'on' : 'off');
    const s = speech.state;
    if (s === 'not-installed') banner('The speech engine isn\'t installed yet. Close Arabic Church Assistant and double-click <b>Setup.bat</b> in its folder (one time, about 10 minutes).', 'error', 'speech');
    else if (s === 'no-model' || s === 'error') banner('Speech engine: ' + esc(speech.message || 'a problem') + ' <button class="btn btn-small" id="engineRestart">Restart it</button> <a href="/settings#engine" target="vf-settings">Show the log</a>', 'error', 'speech');
    else if ((s === 'loading' || s === 'starting') && listening) banner(esc(speech.message || 'Starting the speech engine…') + ' You can start listening now; it begins as soon as the model is ready.', 'info', 'speech');
    else clearBanner('speech');
    // the sound desk's feed is muted or unplugged: said for as long as it lasts
    const inp = speech.inputState;
    if (listening && inp && inp.silent && s !== 'error' && s !== 'no-model') banner('<b>No sound is coming from “' + esc(inp.name || 'the microphone') + '”.</b> Is the sound desk’s feed to this PC muted or unplugged? Listening carries on by itself when the sound is back.', 'error', 'silent');
    else clearBanner('silent');
    const rb = document.getElementById('engineRestart');
    if (rb) rb.onclick = () => api.post('/api/speech/restart').catch(lost);
    if (speech.file && (speech.file.state === 'playing' || speech.file.state === 'paused' || speech.file.state === 'starting')) onFile(speech.file);
    refreshInputs();
    updateStatusLine();
  }
  function setButton(state) {
    const b = $('#listenBtn');
    b.classList.toggle('on', state === 'on');
    b.classList.toggle('wait', state === 'wait');
    $('#listenLabel').textContent = state === 'on' ? 'Stop listening' : state === 'wait' ? 'Starting…' : 'Start listening';
  }
  async function setListening(on) {
    setButton(on ? 'wait' : 'off');
    try { await api.post('/api/listening', { on }); } catch { lost(); setButton(listening ? 'on' : 'off'); }
  }
  function updateStatusLine() {
    if (!bible) return;
    const st = speech || {};
    const where = st.device === 'cuda' ? 'graphics card' : st.device === 'cpu' ? 'processor' : st.device === 'cloud' ? (st.where || 'online') : '';
    const word = { 'not-installed': 'not installed', stopped: 'stopped', starting: 'starting…', loading: st.device === 'cloud' ? 'connecting…' : 'loading the model…', ready: 'ready', listening: 'listening', error: 'problem', 'no-model': 'no speech model' }[st.state] || st.state || '';
    const lang = { auto: 'Arabic + English', ar: 'Arabic', en: 'English' }[settings.listenLang] || 'Arabic + English';
    let s = `Speech: ${lang}${where ? ' · ' + where : ''} · ${listening && st.state === 'ready' ? 'listening' : word}`;
    const inp = st.inputState;
    if (inp && inp.name) s += ' · ' + (inp.kind === 'file' ? '📁 ' : inp.kind === 'loopback' ? '🔊 ' : '🎤 ') + inp.name + (inp.silent && listening ? ' — NO SOUND' : '');
    if (st.recording) s += ' · ⏺ recording';
    s += ' · ' + (/vandyke/.test(bibleEdition) ? 'Van Dyke (with tashkeel)' : 'Van Dyke');
    if (detector && !detector.quoteIndex) s += ' · preparing quote search…';
    else if (detector && !enIndexReady) s += ' · preparing English quotes…';
    setStatus(s);
    const chip = $('#engineChip');
    chip.textContent = st.state === 'listening' || (listening && st.state === 'ready') ? `● ${where || 'on'}${lastLatency != null ? ' · ' + (lastLatency / 1000).toFixed(1) + ' s' : ''}` : '';
    chip.title = lastLatency != null ? (st.device === 'cloud' ? 'How long after the last pause its sentence arrived' : 'How long the speech model took for the last sentence') : '';
  }

  // input level (from the engine, 10 times a second)
  let level = { db: -100, speech: 0 }, shownLevel = 0;
  function meterLoop() {
    requestAnimationFrame(meterLoop);
    const pct = Math.max(0, Math.min(1, (level.db + 60) / 54));
    shownLevel = pct > shownLevel ? pct : shownLevel * 0.9 + pct * 0.1;
    const f = $('#meterFill');
    f.style.width = (shownLevel * 100).toFixed(1) + '%';
    f.classList.toggle('hot', shownLevel > 0.95);
    f.classList.toggle('voice', level.speech > 0.5 && listening);
  }

  // the list under "Listen to"
  function refreshInputs() {
    const sel = $('#inputSel');
    const opts = [];
    const add = (v, t, disabled) => opts.push({ v, t, disabled });
    const defMic = (devices.mics || []).find(m => m.default);
    add('mic:', 'Windows default microphone' + (defMic ? ` (${defMic.name})` : ''));
    for (const m of devices.mics || []) add('mic:' + m.name, '🎤 ' + m.name);
    if (settings.micName && !(devices.mics || []).some(m => m.name === settings.micName)) add('mic:' + settings.micName, '🎤 ' + settings.micName + ' (not connected)');
    add('-', '──────────', true);
    const defSpk = (devices.speakers || []).find(s => s.default);
    add('loop:', '🔊 This PC\'s sound (a video, YouTube, Zoom…)' + (defSpk ? ` — ${defSpk.name}` : ''));
    for (const s of devices.speakers || []) if (!s.default) add('loop:' + s.name, '🔊 ' + s.name);
    add('file', '📁 Test with a recording or video…');
    let value;
    const f = speech.input && speech.input.kind === 'file' ? speech.file : null;
    if (f && f.name) { add('cur', '▶ ' + f.name); value = 'cur'; }
    else if (settings.inputKind === 'loopback') value = 'loop:' + (settings.speakerName || '');
    else value = 'mic:' + (settings.micName || '');
    if (sel.dataset.sig !== JSON.stringify(opts)) {
      sel.innerHTML = '';
      for (const o of opts) { const el = document.createElement('option'); el.value = o.v; el.textContent = o.t; el.disabled = !!o.disabled; sel.appendChild(el); }
      sel.dataset.sig = JSON.stringify(opts);
    }
    if (document.activeElement !== sel) { sel.value = value; if (sel.value !== value) sel.value = opts[0].v; }
  }
  async function onInputChange(e) {
    const v = e.target.value;
    if (v === 'file') { await pickTestFile(); refreshInputs(); return; }
    if (v === 'cur' || v === '-') return;
    const kind = v.startsWith('loop:') ? 'loopback' : 'mic';
    const name = v.slice(v.indexOf(':') + 1);
    try { await api.post('/api/speech/input', { kind, name }); } catch (err) { banner(esc(err.message), 'error', 'input'); }
  }
  async function pickTestFile() {
    if (desktop) {
      const p = await desktop.pickFile();
      if (p) startFile(p);
    } else $('#fileInput').click();
  }
  async function startFile(path) {
    try {
      await api.post('/api/speech/input', { kind: 'file', path });
      banner('Testing with the recording: it plays on this PC\'s speakers and is listened to like the pastor.', 'info', 'test', 6000);
    } catch (e) { banner('Could not play that file: ' + esc(e.message), 'error', 'test'); }
  }
  async function uploadFile(file) {
    banner(`Preparing “${esc(file.name)}”…`, 'info', 'test');
    try {
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'upload failed');
      startFile(j.path);
    } catch (e) { banner('Could not use that file: ' + esc(e.message), 'error', 'test'); }
  }

  // the test-recording bar
  function fmt(s) { return isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00'; }
  let seeking = false;
  function onFile(f) {
    const bar = $('#testBar');
    if (!f || f.state === 'ended' || f.state === 'stopped' || f.state === 'error') {
      bar.hidden = true;
      if (f && f.state === 'ended') banner('Finished the recording.', 'info', 'test', 5000);
      if (f && f.state === 'error') banner('The recording could not be played: ' + esc(f.message || ''), 'error', 'test');
      refreshInputs();
      return;
    }
    bar.hidden = false;
    $('#testName').textContent = f.name || '';
    $('#testTime').textContent = `${fmt(f.t)} / ${fmt(f.dur)}`;
    if (!seeking && f.dur) $('#testSeek').value = (100 * f.t / f.dur).toFixed(1);
    $('#testPause').textContent = f.state === 'paused' ? 'Play' : 'Pause';
    $('#testPause').dataset.paused = f.state === 'paused' ? '1' : '0';
    bar.dataset.dur = f.dur || 0;
  }

  // ================================================================ display window
  let displayOpen = false;
  function onDisplayState(st) {
    displayOpen = !!(st && st.open);
    $('#displayBtn').textContent = displayOpen ? 'Close display' : 'Open display ↗';
  }
  async function toggleDisplay() {
    if (desktop) {
      if (displayOpen) await desktop.closeDisplay(); else await desktop.openDisplay();
      onDisplayState(await desktop.displayState());
      return;
    }
    let features = 'popup,width=1280,height=720';
    if ('getScreenDetails' in window) {
      try {
        const sd = await window.getScreenDetails();
        const other = sd.screens.find(s => s !== sd.currentScreen && !s.isPrimary) || sd.screens.find(s => s !== sd.currentScreen);
        if (other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
      } catch { /* permission declined */ }
    }
    const w = window.open('/display?video=1', 'verse-display', features);
    if (!w) banner('The display window was blocked. Click <b>Open display</b> again.', 'info', 'popup', 6000);
    else banner('Display opened. Double-click it (or press F11) for full screen.', 'info', 'popup', 6000);
  }

  // ================================================================ wiring
  function syncControls() {
    $('#langSel').value = settings.listenLang || 'auto';
    $('#autoShow').checked = !!settings.autoShow;
    $('#quoteToggle').checked = !!settings.catchQuotes;
    $('#readAlong').checked = settings.readAlong !== false;
    $('#holdToggle').checked = hold;
    $('#videoDetect').checked = settings.videoDetect !== false;
    $('#videoAutoPlay').checked = !!settings.videoAutoPlay;
  }
  function selectTab(name) {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
    for (const [tab, pane] of [['detected', '#paneDetected'], ['bible', '#paneBible'], ['plan', '#panePlan'], ['videos', '#paneVideos'], ['history', '#paneHistory']]) $(pane).hidden = tab !== name;
    if (name === 'bible') renderPicker();
    if (name === 'plan') renderPlan();
    if (name === 'history') loadHistory();
  }
  function wire() {
    $('#listenBtn').onclick = () => setListening(!listening);
    $('#inputSel').onchange = onInputChange;
    $('#langSel').onchange = e => saveSettings({ listenLang: e.target.value }).then(updateStatusLine);
    $('#fileInput').onchange = () => { const f = $('#fileInput').files[0]; $('#fileInput').value = ''; if (f) uploadFile(f); };
    $('#autoShow').onchange = e => saveSettings({ autoShow: e.target.checked });
    $('#quoteToggle').onchange = e => { saveSettings({ catchQuotes: e.target.checked }); if (detector) detector.opts.quotes = e.target.checked; };
    $('#readAlong').onchange = e => saveSettings({ readAlong: e.target.checked });
    $('#holdToggle').onchange = e => setHold(e.target.checked);
    $('#backBtn').onclick = goBack;
    $('#displayBtn').onclick = toggleDisplay;

    $('#testPause').onclick = () => api.post('/api/speech/file', { action: $('#testPause').dataset.paused === '1' ? 'resume' : 'pause' }).catch(lost);
    $('#testStop').onclick = () => api.post('/api/speech/file', { action: 'stop' }).catch(lost);
    $('#testSeek').oninput = () => { seeking = true; };
    $('#testSeek').onchange = e => {
      const dur = +$('#testBar').dataset.dur || 0;
      if (dur) api.post('/api/speech/file', { action: 'seek', t: dur * e.target.value / 100 }).catch(lost);
      setTimeout(() => { seeking = false; }, 800);
    };

    document.querySelectorAll('.tab').forEach(t => { t.onclick = () => selectTab(t.dataset.tab); });
    $('#playlistForm').onsubmit = async e => {
      e.preventDefault();
      const url = $('#playlistInput').value.trim();
      if (!url) return;
      const btn = $('#playlistAdd');
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        const r = await api.post('/api/videos/add', { url });
        $('#playlistInput').value = '';
        banner(`Added “${esc(r.playlist.title)}”: ${r.playlist.count} videos.` + (r.playlist.partial ? ' (YouTube only gave the newest 15.)' : ''), 'info', 'videos', 7000);
      } catch (err) { banner(esc(err.message), 'error', 'videos'); }
      finally { btn.disabled = false; btn.textContent = 'Add'; }
    };
    $('#videoFilter').oninput = renderVideoList;
    $('#ytForm').onsubmit = e => { e.preventDefault(); const q = $('#ytInput').value.trim(); if (q) youtubeSearch(q); };
    $('#videoFilter').onkeydown = e => {
      const f = VE.normalize(e.target.value || '');
      if (e.key !== 'Enter' || !f) return;
      const v = [...videosById.values()].find(x => VE.normalize(x.title).includes(f)) || (songIndex && songIndex.search(e.target.value, 1)[0]);
      if (v) playVideo(v);
    };
    $('#songsAdd').onclick = async () => {
      const url = $('#playlistInput').value.trim();
      if (!url) { banner('Paste the link of a YouTube playlist or channel first.', 'info', 'videos', 5000); return; }
      const btn = $('#songsAdd');
      btn.disabled = true; btn.textContent = 'Reading the list…';
      try {
        const r = await api.post('/api/songs/add', { url });
        $('#playlistInput').value = '';
        banner(`Added “${esc(r.source.title)}” to the song database: ${r.source.count} videos.`, 'info', 'videos', 7000);
      } catch (err) { banner(esc(err.message), 'error', 'videos'); }
      finally { btn.disabled = false; btn.textContent = '＋ Song database'; }
    };
    $('#videoDetect').onchange = e => saveSettings({ videoDetect: e.target.checked });
    $('#videoAutoPlay').onchange = e => saveSettings({ videoAutoPlay: e.target.checked });

    // plan
    $('#planAdd').onclick = () => {
      const { items, bad } = parsePlanLines($('#planInput').value);
      if (items.length) addPlanItems(items);
      $('#planInput').value = bad.join('\n');
      if (bad.length) banner(`Couldn't understand: ${bad.map(esc).join(' · ')} — write a reference like “يوحنا ٣: ١٦” or “John 3:16”, or part of a video title.`, 'info', 'plan', 9000);
    };
    $('#planNext').onclick = () => runPlanItem(Math.min(plan.items.length - 1, planPos + 1));
    $('#planClear').onclick = () => { if (plan.items.length && confirm('Remove everything from the plan?')) { planPos = -1; savePlan([]); } };

    // history
    $('#historyDay').onchange = () => loadHistory($('#historyDay').value);
    $('#historyExport').onclick = () => { const d = $('#historyDay').value; if (d) location.href = '/api/history/export?d=' + encodeURIComponent(d); };
    $('#historyFolder').onclick = () => (desktop ? desktop.openFolder('history') : banner('The history is in the data\\history folder inside the Arabic Church Assistant folder.', 'info', 'hist', 6000));
    if (!desktop) $('#historyFolder').hidden = true;

    // message
    $('#msgShow').onclick = () => api.post('/api/message', { title: $('#msgTitle').value, text: $('#msgText').value }).catch(e => banner(esc(e.message), 'error', 'msg', 5000));

    $('#clearTranscript').onclick = () => { tEl.innerHTML = ''; interimEl = null; if (detector) detector.reset(); if (videoMatcher) videoMatcher.reset(); };
    $('#clearCards').onclick = () => { cards.length = 0; cardsEl.innerHTML = ''; $('#searchResults').hidden = true; api.post('/api/found/clear').catch(() => {}); };
    $('#prevBtn').onclick = () => step(-1);
    $('#nextBtn').onclick = () => step(1);
    $('#clearBtn').onclick = clearScreen;

    $('#simForm').onsubmit = e => { e.preventDefault(); const v = $('#simInput').value; $('#simInput').value = ''; handleFinal(v); };
    $('#searchForm').onsubmit = e => {
      e.preventDefault();
      if (!bible) return;
      const q = $('#searchInput').value.trim();
      if (!q) return;
      const r = VE.parseQuery(q, bible);
      if (!r) { renderSearchResults(findByWords(q), q); return; }
      $('#searchResults').hidden = true;
      if (r.verse != null && !bible.valid(r.book, r.chapter, r.verse)) { r.verse = null; r.verseEnd = null; }
      const c = Object.assign({}, r, { source: 'manual', lang: /[a-z]/i.test(q) && !/[؀-ۿ]/.test(q) ? 'en' : 'ar',
        time: Date.now(), label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }) });
      addCard(c);
      if (c.verse != null) show(c, 'search');
      $('#searchInput').value = '';
    };

    document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });
    document.addEventListener('change', e => { if (e.target.matches('select')) e.target.blur(); });
    document.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea') || e.ctrlKey || e.altKey || e.metaKey) {
        if (e.key === 'Escape' && e.target.matches('input, textarea')) e.target.blur();
        return;
      }
      const k = e.key;
      if (k === 'Escape') clearScreen();
      else if (k === 'Backspace') goBack();
      else if (k === 'h' || k === 'H') setHold(!hold);
      else if (k === 'ArrowRight') step(1);
      else if (k === 'ArrowLeft') step(-1);
      else if (k === 'Enter') showNewest();
      else if (k === 'l' || k === 'L') setListening(!listening);
      else if (k === 'n' || k === 'N') $('#planNext').click();
      else if (k === 'b' || k === 'B') selectTab('bible');
      else if (k === '/') { e.preventDefault(); selectTab('detected'); $('#searchInput').focus(); }
      else return;
      e.preventDefault();
    });

    const lb = () => {
      const p = new URLSearchParams();
      if ($('#lbLayout').value) p.set('layout', $('#lbLayout').value);
      if ($('#lbBg').value) p.set('bg', $('#lbBg').value);
      if ($('#lbEn').checked) p.set('en', '1');
      p.set('obs', '1');
      $('#lbUrl').value = location.origin + '/display?' + p.toString();
    };
    ['#lbLayout', '#lbBg', '#lbEn'].forEach(s => { $(s).onchange = lb; });
    $('#lbUrl').onclick = e => e.target.select();
    lb();

    const fit = () => { const w = $('.preview-wrap').clientWidth; $('#preview').style.transform = `scale(${w / 1920})`; };
    window.addEventListener('resize', fit); fit();
    $('#preview').addEventListener('load', () => {
      toPreview({ vfSettings: settings });
      if (lastScreenState) toPreview({ vfScreen: lastScreenState });
    });
    wireVideoControls();
    $('#pickerFilter').oninput = renderPicker;
    if (desktop) {
      desktop.onDisplayState(onDisplayState);
      desktop.displayState().then(onDisplayState).catch(() => {});
    }
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('settings', e => onServerSettings(JSON.parse(e.data)));
    es.addEventListener('screen', e => onScreenState(JSON.parse(e.data)));
    es.addEventListener('hold', e => onHold(JSON.parse(e.data).on));
    es.addEventListener('phrases', e => loadPhrases(JSON.parse(e.data)));
    es.addEventListener('videos', e => setLibrary(JSON.parse(e.data)));
    es.addEventListener('songs', () => loadSongs());
    loadSongs();
    es.addEventListener('video-status', e => onVideoStatus(JSON.parse(e.data)));
    es.addEventListener('plan', e => { plan = JSON.parse(e.data) || { items: [] }; renderPlan(); });
    es.addEventListener('speech', e => onSpeech(JSON.parse(e.data)));
    es.addEventListener('devices', e => { devices = JSON.parse(e.data) || devices; refreshInputs(); });
    es.addEventListener('level', e => { level = JSON.parse(e.data); });
    es.addEventListener('file', e => onFile(JSON.parse(e.data)));
    es.addEventListener('speech-warn', e => banner(esc(JSON.parse(e.data).message), 'info', 'warn', 10000));
    es.addEventListener('transcript', e => {
      const d = JSON.parse(e.data);
      if (d.final) { if (d.ms != null) lastLatency = d.ms; handleFinal(d.text, d.lang, !!d.late, d.seg); updateStatusLine(); } else handleInterim(d.text, d.seg);
    });
    es.addEventListener('voice-command', e => runVoiceCommand(JSON.parse(e.data)));
    es.addEventListener('remote', e => {
      const d = JSON.parse(e.data), a = d.action;
      if (a === 'next') step(1, 'phone'); else if (a === 'prev') step(-1, 'phone'); else if (a === 'show-latest') showNewest('phone'); else if (a === 'plan-next') $('#planNext').click();
      else if (a === 'plan-go') runPlanItem(d.index);                                       // tapped in the phone's plan list
      else if (a === 'show-ref' && bible && bible.valid(d.book, d.chapter, d.verse)) {   // picked in the phone's Bible tab
        const r = { book: d.book, chapter: d.chapter, verse: d.verse, verseEnd: d.verseEnd && bible.valid(d.book, d.chapter, d.verseEnd) ? d.verseEnd : null };
        const c = Object.assign({}, r, { source: 'manual', lang: 'ar', time: Date.now(), label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }) });
        addCard(c);
        show(c, 'phone');
      }
    });
    es.onopen = () => clearBanner('conn');
    es.onerror = () => lost();
  }

  // ================================================================ spoken commands from the phone remote
  // "next verse" -> the next one; «يوحنا ٣ ١٦» -> show it; a hymn from the playlists -> play it; a hymn from the song
  // database -> the phone lists the matches to choose from (it is not played by itself); words of a verse -> show it.
  function runVoiceCommand(cmd) {
    const text = (cmd.text || '').trim();
    let message = `Didn't understand “${text}”.`, songs = null, verse = null;
    banner('📱 Remote: “' + esc(text) + '”', 'info', 'voice', 6000);
    try {
      let done = false;
      const nav = VE.detectNavDetail(text);
      if (nav && current) {
        step(nav.dir === 'next' ? 1 : -1, 'phone');
        message = (nav.dir === 'next' ? 'Next: ' : 'Back one: ') + VE.refLabel(current, { lang: 'en' });
        done = true;
      }
      const r = !done && bible && VE.parseQuery(text, bible);
      if (r) {
        if (r.verse != null && !bible.valid(r.book, r.chapter, r.verse)) { r.verse = null; r.verseEnd = null; }
        const c = Object.assign({}, r, { source: 'manual', lang: VE.isEnglish(text) ? 'en' : 'ar', time: Date.now(), label: VE.refLabel(r), labelEn: VE.refLabel(r, { lang: 'en' }) });
        addCard(c);
        if (c.verse != null) { show(c, 'phone'); message = 'On screen: ' + c.labelEn; }
        else { pickerGo(c.book, c.chapter); selectTab('bible'); message = 'Opened ' + c.labelEn + ' in the Bible tab (say the verse too to show it).'; }
        done = true;
      }
      if (!done && videoMatcher) {
        const words = VE.normalize('ترنيمة ' + text).split(' ').filter(Boolean);
        const m = videoMatcher.match(words, 0)[0];
        if (m) { playVideo(m.video); addVideoCard(m); message = 'Playing: ' + m.video.title; done = true; }
      }
      // the words of a verse, and the song database (the titles of a thousand hymns)
      const q = !done && fuzzyIdx ? (detector && detector.quoteIndex && detector.quoteIndex.query(VE.qtokens(text)) || fuzzyIdx.query(VE.qtokens(text))) : null;
      const found = !done && songIndex ? findSongs(text) : [];
      if (found.length) {
        // a hymn by its title: the phone lists the matches and one is chosen there (as on a card here)
        addSongsCard({ kind: 'cue', heard: text, matches: found, close: false, named: true, repeat: false });
        songs = found.map(m => ({ id: m.video.id, title: m.video.title }));
        api.post('/api/hymn', { heard: text, how: 'phone', found: found.length, title: found[0].video.title, songs }).catch(() => {});
        message = found.length === 1 ? 'Found in the song database: press ▶ to play it.' : `Found ${found.length} in the song database: press ▶ on the one you want.`;
        if (q) verse = { book: q.book, chapter: q.chapter, verse: q.verse, label: VE.refLabel(q), labelEn: VE.refLabel(q, { lang: 'en' }) };   // (the words are a verse too)
        done = true;
      } else if (q) {
        const c = Object.assign({}, q, { verseEnd: null, source: 'quote', lang: 'ar', time: Date.now(), label: VE.refLabel(q), labelEn: VE.refLabel(q, { lang: 'en' }) });
        addCard(c); show(c, 'phone'); message = 'On screen: ' + c.labelEn; done = true;
      }
    } catch (e) { message = 'Problem: ' + e.message; }
    api.post('/api/remote/voice-result', { id: cmd.id, message, songs, verse }).catch(() => {});
  }
  // A hymn asked for by its title (from the phone): the song database's titles that begin with the words, or sound like
  // them, best first; failing that, the titles that hold all the words.
  function findSongs(text) {
    const words = VE.normalize(text).split(' ').filter(Boolean);
    if (words.length < 2) return [];
    const ids = new Set();
    let found = songIndex.lookup(words, 8);
    if (!found.length) found = songIndex.lookup(words, 6, true);
    found = found.concat(songIndex.near(words, 6)).filter(m => !ids.has(m.video.id) && ids.add(m.video.id)).sort((a, b) => b.score - a.score);
    if (!found.length) found = songIndex.search(text, 6).map(video => ({ video, score: 0 }));
    return found.slice(0, 6);
  }

  // ================================================================ start
  (async function boot() {
    wire();
    try { settings = Object.assign({}, settings, await api.get('/api/settings')); } catch { /* the event stream brings them */ }
    syncControls();
    connectEvents();
    refreshInputs();
    requestAnimationFrame(meterLoop);
    try {
      const st = await api.get('/api/status');
      if (st.addresses && st.addresses.length) $('#lanNote').textContent = 'From another PC on this network: ' + st.addresses[0] + '/display';
    } catch { /* not important */ }
    try {
      await loadBibles();
      $('#listenBtn').disabled = false;
      updateStatusLine();
      renderPlan();
    } catch (e) {
      banner(esc(e.message), 'error', 'bible');
      setStatus('Bible not loaded');
    }
  })();
})();
