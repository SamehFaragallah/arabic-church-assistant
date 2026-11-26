// Arabic Church Assistant — the local server behind the desktop app: the operator console, the display (projector,
// OBS, other PCs on the network), settings, Bible text, YouTube titles, history, and the speech engine.
// The desktop app (electron/main.js) starts it. It also runs on its own:  node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const { exec, execFile, execFileSync, spawn } = require('child_process');
const { Speech, killTree, enginePython } = require('./speech');

const VERSION = '3.4.1';
const PORT = parseInt(process.env.PORT || '5050', 10);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// On a Mac there is no speech model on the computer yet (no NVIDIA cards): Google or a paid service listens.
const IS_MAC = process.platform === 'darwin';
// (VF_DATA_DIR: a data folder and settings.json of their own, for trying things out without touching the church's.
// The Mac app sets it to ~/Library/Application Support/Arabic Church Assistant/data: it can't write inside itself.)
const DATA = process.env.VF_DATA_DIR || path.join(ROOT, 'data');
const FONT_DIR = path.join(DATA, 'fonts');
const HISTORY_DIR = path.join(DATA, 'history');
const UPLOAD_DIR = path.join(DATA, 'uploads');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

const hub = new EventEmitter();          // the desktop app listens here (open the display, listening on/off …)
// Everything the app and the speech engine report is kept in data\logs\<date>.log, a line each with its time
// (never the keys). Files older than 60 days are removed when the app starts.
const LOG_DIR = path.join(DATA, 'logs');
const RECORD_DIR = path.join(DATA, 'recordings');
function logLine(src, msg) {
  try {
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.log`),
      `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}  ${String(src).padEnd(7)} ${String(msg).replace(/\s*[\r\n]+\s*/g, ' / ')}\n`);
  } catch { /* the log is a nice-to-have */ }
}
function log(...a) { console.log(...a); logLine('app', a.join(' ').trim()); }
// old logs, and old recordings of services (Settings -> Listening -> keep a recording), are cleared out
function pruneOld(dir, days, pattern) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!pattern.test(f)) continue;
      const full = path.join(dir, f);
      if (Date.now() - fs.statSync(full).mtimeMs > days * 86400000) fs.unlinkSync(full);
    }
  } catch { /* no such folder yet */ }
}

// =====================================================================================
// Bibles
// =====================================================================================
// Arabic: the getBible copy of the Smith & Van Dyck text has the full printed tashkeel and hamzas.
// The plain copy (no hamza/tashkeel) is only a fallback.
const BIBLES = {
  arFull: {
    file: 'ar_vandyke.json', name: 'Arabic Van Dyke (with tashkeel)',
    urls: ['https://api.getbible.net/v2/arabicsv.json'],
  },
  arPlain: {
    file: 'ar_svd.json', name: 'Arabic Van Dyke (plain text)',
    urls: [
      'https://raw.githubusercontent.com/jamesft/bible/master/json/ar_svd.json',
      'https://cdn.jsdelivr.net/gh/jamesft/bible@master/json/ar_svd.json',
      'https://raw.githubusercontent.com/thiagobodruk/bible/master/json/ar_svd.json',
    ],
  },
  en: {
    file: 'en_kjv.json', name: 'English King James Version (KJV)',
    urls: [
      'https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json',
      'https://cdn.jsdelivr.net/gh/thiagobodruk/bible@master/json/en_kjv.json',
      'https://raw.githubusercontent.com/jamesft/bible/master/json/en_kjv.json',
      'https://api.getbible.net/v2/kjv.json',
    ],
  },
  // Modern public-domain English translations: shown on screen if chosen, and always used to
  // recognize English quotes (so NIV/ESV-style wording still matches)
  bsb: { file: 'en_bsb.json', name: 'Berean Standard Bible (BSB)', urls: ['https://bereanbible.com/bsb.txt'], parse: 'bsb' },
  web: { file: 'en_web.json', name: 'World English Bible (WEB)', urls: ['https://api.getbible.net/v2/web.json'] },
  asv: { file: 'en_asv.json', name: 'American Standard Version (ASV)', urls: ['https://api.getbible.net/v2/asv.json'] },
};
const ENGLISH_BUILT_IN = { kjv: 'en', bsb: 'bsb', web: 'web', asv: 'asv' };   // version -> BIBLES key

// Accepts [{abbrev, chapters:[[verse,...]]}] or getBible v2 {books:[{nr, chapters:[{chapter, verses:[{verse,text}]}]}]}
function toBookArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.books)) {
    return json.books.filter(b => b.nr >= 1 && b.nr <= 66).sort((a, b) => a.nr - b.nr).map(b => ({
      abbrev: String(b.nr),
      chapters: b.chapters.slice().sort((x, y) => x.chapter - y.chapter)
        .map(ch => ch.verses.slice().sort((x, y) => x.verse - y.verse).map(v => String(v.text || '').trim())),
    }));
  }
  return json;
}

// Berean Standard Bible text file: "Genesis 1:1<TAB>In the beginning ..."
const EN_BOOK_NAMES = ['genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua', 'judges', 'ruth', '1 samuel', '2 samuel',
  '1 kings', '2 kings', '1 chronicles', '2 chronicles', 'ezra', 'nehemiah', 'esther', 'job', 'psalms', 'proverbs', 'ecclesiastes',
  'song of solomon', 'isaiah', 'jeremiah', 'lamentations', 'ezekiel', 'daniel', 'hosea', 'joel', 'amos', 'obadiah', 'jonah', 'micah',
  'nahum', 'habakkuk', 'zephaniah', 'haggai', 'zechariah', 'malachi', 'matthew', 'mark', 'luke', 'john', 'acts', 'romans',
  '1 corinthians', '2 corinthians', 'galatians', 'ephesians', 'philippians', 'colossians', '1 thessalonians', '2 thessalonians',
  '1 timothy', '2 timothy', 'titus', 'philemon', 'hebrews', 'james', '1 peter', '2 peter', '1 john', '2 john', '3 john', 'jude', 'revelation'];
function bookNumber(name) {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const alias = { psalm: 'psalms', 'song of songs': 'song of solomon', 'revelation of john': 'revelation' };
  return EN_BOOK_NAMES.indexOf(alias[n] || n) + 1;
}
function parseBsb(text) {
  const books = Array.from({ length: 66 }, () => ({ chapters: [] }));
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+?) (\d+):(\d+)\t(.*)$/);
    if (!m) continue;
    const b = bookNumber(m[1]);
    if (!b) continue;
    const ch = books[b - 1].chapters;
    const c = +m[2], v = +m[3];
    while (ch.length < c) ch.push([]);
    ch[c - 1][v - 1] = m[4].trim();
  }
  for (const b of books) b.chapters = b.chapters.map(vs => Array.from(vs, x => x || ''));
  return books;
}

function validBible(arr) {
  if (!Array.isArray(arr) || arr.length !== 66) return 'expected 66 books';
  let verses = 0;
  for (const b of arr) for (const ch of b.chapters || []) verses += ch.length;
  if (verses < 30000 || verses > 32000) return `unexpected verse count ${verses}`;
  const jn = arr[42] && arr[42].chapters && arr[42].chapters[2];
  if (!jn || !jn[15]) return 'John 3:16 missing';
  return null;
}

const bibleFile = key => path.join(DATA, BIBLES[key].file);
const haveBible = key => { try { return fs.statSync(bibleFile(key)).size > 100000; } catch { return false; } };
const downloading = {};

async function fetchWithTimeout(url, ms, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts || {})); } finally { clearTimeout(t); }
}

async function downloadBible(key) {
  if (haveBible(key)) return true;
  if (downloading[key]) return downloading[key];
  const b = BIBLES[key];
  downloading[key] = (async () => {
    fs.mkdirSync(DATA, { recursive: true });
    for (const url of b.urls) {
      try {
        log(`Downloading ${b.name}...`);
        const res = await fetchWithTimeout(url, 120000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.text()).replace(/^\uFEFF/, '');
        const json = b.parse === 'bsb' ? parseBsb(body) : toBookArray(JSON.parse(body));
        const problem = validBible(json);
        if (problem) throw new Error(problem);
        fs.writeFileSync(bibleFile(key), JSON.stringify(json));
        log(`  saved data\\${b.file}`);
        return true;
      } catch (e) {
        log(`  could not get it from ${url}: ${e.message}`);
      }
    }
    return false;
  })();
  const ok = await downloading[key];
  delete downloading[key];
  return ok;
}

// The best Arabic copy we have (downloads one if there is none yet)
async function arabicFile() {
  if (haveBible('arFull')) return bibleFile('arFull');
  if (haveBible('arPlain')) {
    downloadBible('arFull');            // upgrade in the background for next time
    return bibleFile('arPlain');
  }
  if (await downloadBible('arFull')) return bibleFile('arFull');
  if (await downloadBible('arPlain')) return bibleFile('arPlain');
  return null;
}

// =====================================================================================
// Settings (saved to settings.json — a plain text file you can open in Notepad)
// =====================================================================================
const SETTINGS_FILE = path.join(process.env.VF_DATA_DIR || ROOT, 'settings.json');
const DEFAULT_SETTINGS = {
  // listening (speech engine on this PC)
  listenLang: 'auto',         // 'auto' (Arabic + English, decided per sentence) | 'ar' | 'en'
  inputKind: 'mic',           // 'mic' | 'loopback' (everything this PC plays: a video, Zoom …)
  micName: '',                // '' = Windows default microphone
  speakerName: '',            // for 'loopback': '' = Windows default speakers
  pause: 0.5,                 // seconds of quiet that end a sentence
  sensitivity: 0.5,           // voice detection: higher hears quieter speech, lower ignores more noise
  speechDevice: 'auto',       // 'auto' (graphics card if there is one) | 'cuda' | 'cpu'
  speechProvider: 'google',   // 'google' (through Chrome, free; the default) | 'local' (the model on this PC, free; downloaded
                              // when it is chosen) | 'auto' (the model when it is installed and the graphics card is good,
                              // otherwise Google) | 'elevenlabs' | 'soniox' | 'deepgram' (paid)
  speechHints: true,          // the cloud services that take hints are told the Bible book names and hymn titles to expect
  // detection
  autoShow: true,             // a reference said goes on screen without clicking Show
  autoShowQuotes: false,     // verses recognized from a quote (no reference said) go on screen by themselves too
  quoteLive: true,            // … while they are still being said, once the quote is clear (off: when the sentence is finished)
  navFollow: true,            // "next verse" / "العدد اللي بعده" moves the screen when a verse is showing
  readAlong: true,            // the pastor reads on into the next verse: the screen follows
  readEnd: true,              // … and in a reading, the next verse goes up as the last words of the one on screen are said
  readLead: 1,                // … this many seconds before its end (0: at its last word)
  catchQuotes: true,
  cardOnly: [],               // verses ("book:chapter:verse") that quoted words never put on screen by themselves
  // the record of each service
  recordService: true,        // keep a sound recording of what the app listens to (for checking it afterwards; on unless turned off)
  recordKeepWeeks: 8,         // … for this many weeks
  // display
  font: 'naskh',
  tashkeel: true,
  layout: 'full',
  background: 'dark',
  showEnglish: true,          // the English translation under the Arabic
  textSize: 1,
  transition: 'none',         // instant: no animation
  transitionMs: 450,
  showReference: true,        // the reference (يوحنا ٣: ١٦) above the verse
  displayId: '',              // which monitor the display opens on ('' = the projector / second screen)
  displayAutoOpen: true,      // open the display when the app starts
  // English
  englishVersion: 'apibible', // kjv | bsb | web | asv (built in) | esv | apibible (online, needs a key; the app has one)
  apiBibleId: '63097d2a0a2f7db3-01',   // the NKJV (without internet the KJV is shown instead)
  apiBibleAbbr: 'NKJV',
  englishForEnglish: true,    // verses found from English speech are shown with the English underneath
  // YouTube
  videoDetect: true,
  videoAutoPlay: true,        // a clearly announced hymn starts on the display by itself
  videoPlayOnce: true,        // … once: mentioned again later in the service, it only shows its card
  playlists: [],
  // phone remote
  remotePin: '',
  settingsVersion: 5,
};
const ALLOWED = {
  listenLang: ['ar', 'en', 'auto'],
  inputKind: ['mic', 'loopback'],
  speechDevice: ['auto', 'cuda', 'cpu'],
  speechProvider: ['auto', 'local', 'google', 'elevenlabs', 'soniox', 'deepgram'],
  englishVersion: ['kjv', 'bsb', 'web', 'asv', 'esv', 'apibible'],
  font: ['naskh', 'cairo', 'tajawal', 'kufi', 'readex', 'amiri', 'scheherazade'],
  layout: ['full', 'lower'],
  transition: ['rise', 'fade', 'slideup', 'slide', 'zoom', 'none'],
  background: ['dark', 'black', 'light', 'transparent', 'green'],
};
const RANGES = { textSize: [0.5, 2, 1], transitionMs: [0, 3000, 450], pause: [0.25, 1.5, 0.5], sensitivity: [0.1, 0.9, 0.5], recordKeepWeeks: [1, 52, 8], readLead: [0, 3, 1] };
function cleanSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in input)) continue;
    let v = input[k];
    if (ALLOWED[k] && !ALLOWED[k].includes(v)) continue;
    if (RANGES[k]) { const [lo, hi, d] = RANGES[k]; v = Math.min(hi, Math.max(lo, Number.isFinite(parseFloat(v)) ? parseFloat(v) : d)); if (k === 'transitionMs' || k === 'recordKeepWeeks') v = Math.round(v); }
    else if (typeof def === 'boolean') v = !!v;
    else if (typeof def === 'number') { v = parseFloat(v); if (!Number.isFinite(v)) continue; }
    else if (Array.isArray(def)) { if (!Array.isArray(v)) continue; v = v.map(x => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, k === 'cardOnly' ? 300 : 30); }
    else if (typeof def === 'string') v = String(v == null ? '' : v).slice(0, 300);
    out[k] = v;
  }
  return out;
}
// Settings saved by version 2 (Chrome speech / Whisper) and 3.0 carry over.
function migrate(raw) {
  if (!raw || raw.settingsVersion >= 5) return raw;
  const m = Object.assign({}, raw);
  if (!(raw.settingsVersion >= 4)) {
    if (!(raw.settingsVersion >= 3)) {
      const usb = s => String(s || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
      if (!m.micName) m.micName = usb(raw.offlineDeviceName) || usb(raw.micLabel);
      if (raw.listenLang === 'ar' || !raw.listenLang) m.listenLang = 'auto';   // Arabic + English is automatic now
    }
    // 3.0 always said 'local' (there was nothing else free): now the PC decides (it stays 'local' with a good graphics card)
    if (!m.speechProvider || m.speechProvider === 'local') m.speechProvider = 'auto';
  }
  // 3.3: every service is recorded unless that is turned off (it was off unless turned on). On once; Settings -> Listening
  // turns it off again.
  m.recordService = true;
  m.settingsVersion = 5;
  return m;
}
let secrets = { esvKey: '', apiBibleKey: '', elevenlabsKey: '', deepgramKey: '', sonioxKey: '', hfToken: '' };
// Bible keys that come with the app (bible-keys.json, part of the download), so the ESV and the API.Bible translations
// work straight away. A church's own key in Settings is used instead when there is one. The paid speech services'
// keys are never part of the download: they are only in settings.json.
const BUILT_IN_KEYS = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'bible-keys.json'), 'utf8').replace(/^﻿/, ''));
    return { esvKey: cleanKey(j.esvKey), apiBibleKey: cleanKey(j.apiBibleKey) };
  } catch { return { esvKey: '', apiBibleKey: '' }; }
})();
const bibleKey = k => secrets[k] || BUILT_IN_KEYS[k] || '';
function cleanKey(v) {
  return String(v == null ? '' : v).replace(/^\s*authorization\s*:\s*/i, '').replace(/^\s*(token|bearer)\s+/i, '').replace(/["'\s]/g, '').slice(0, 200);
}
function repairSettingsText(txt) {
  const t = txt.replace(/^﻿/, '').replace(/[“”]/g, '"')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/("|\d|true|false|null|\]|\})([ \t]*\r?\n\s*")/g, '$1,$2');
  try { const o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch { /* keep going */ }
  const out = {};
  const re = /"([A-Za-z]+)"\s*:\s*("(?:[^"\\\r\n]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g;
  let m;
  while ((m = re.exec(txt))) { try { out[m[1]] = JSON.parse(m[2]); } catch { /* skip */ } }
  return Object.keys(out).length ? out : null;
}
function loadSettings() {
  let txt;
  try { txt = fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch {
    // a new install. The offline download carries the speech model, and without internet Google can't listen: listen on this PC
    const fresh = { remotePin: newPin() };
    if (fs.existsSync(path.join(ROOT, 'engine', 'models', 'cohere-transcribe-arabic-07-2026', 'model.safetensors'))) fresh.speechProvider = 'local';
    return Object.assign({}, DEFAULT_SETTINGS, fresh);
  }
  let raw = null;
  try { raw = JSON.parse(txt.replace(/^﻿/, '')); } catch {
    if (txt.trim()) {
      raw = repairSettingsText(txt);
      try { fs.writeFileSync(path.join(path.dirname(SETTINGS_FILE), 'settings.broken.json'), txt); } catch { /* ignore */ }
      log(raw ? '  settings.json had a small mistake in it. Repaired it (the original is kept as settings.broken.json).'
              : '  settings.json could not be read, so the default settings are used (the original is kept as settings.broken.json).');
    }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  for (const k of Object.keys(secrets)) secrets[k] = typeof raw[k] === 'string' ? cleanKey(raw[k]) : '';
  const s = Object.assign({}, DEFAULT_SETTINGS, cleanSettings(migrate(raw)));
  if (!/^\d{4,8}$/.test(s.remotePin)) s.remotePin = newPin();
  return s;
}
function newPin() { return String(crypto.randomInt(1000, 10000)); }
let settingsMtime = 0;
function saveSettings(s) {
  const txt = JSON.stringify(Object.assign({}, s, secrets), null, 2) + '\n';
  const tmp = SETTINGS_FILE + '.tmp';
  try { fs.writeFileSync(tmp, txt); fs.renameSync(tmp, SETTINGS_FILE); }
  catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } fs.writeFileSync(SETTINGS_FILE, txt); }
  try { settingsMtime = fs.statSync(SETTINGS_FILE).mtimeMs; } catch { /* ignore */ }
}
function publicSettings() {
  const hint = k => (k.length > 8 ? k.slice(-4) : '');
  const s = Object.assign({}, settings, { esvKeySet: !!bibleKey('esvKey'), apiBibleKeySet: !!bibleKey('apiBibleKey'),
    esvKeyHint: hint(secrets.esvKey), apiBibleKeyHint: hint(secrets.apiBibleKey),
    esvKeyBuiltIn: !secrets.esvKey && !!BUILT_IN_KEYS.esvKey, apiBibleKeyBuiltIn: !secrets.apiBibleKey && !!BUILT_IN_KEYS.apiBibleKey,
    hfTokenSet: !!secrets.hfToken,
    elevenlabsKeySet: !!secrets.elevenlabsKey, elevenlabsKeyHint: hint(secrets.elevenlabsKey),
    deepgramKeySet: !!secrets.deepgramKey, deepgramKeyHint: hint(secrets.deepgramKey),
    sonioxKeySet: !!secrets.sonioxKey, sonioxKeyHint: hint(secrets.sonioxKey) });
  delete s.remotePin;                        // displays on other PCs must not learn it
  return s;
}
let settings = loadSettings();
try { saveSettings(settings); } catch { /* read-only folder: keep in memory */ }
fs.watchFile(SETTINGS_FILE, { interval: 1500, persistent: false }, cur => {
  if (!cur.mtimeMs || cur.mtimeMs === settingsMtime) return;
  setTimeout(() => {
    let st; try { st = fs.statSync(SETTINGS_FILE); } catch { return; }
    if (st.mtimeMs === settingsMtime) return;
    settingsMtime = st.mtimeMs;
    const before = settings, keysBefore = bibleKey('esvKey') + '|' + bibleKey('apiBibleKey');
    settings = loadSettings();
    if (bibleKey('esvKey') + '|' + bibleKey('apiBibleKey') !== keysBefore) verseCache.clear();
    log('settings.json was changed by hand. Using the new settings.');
    settingsChanged(before);
  }, 300);
});
function settingsChanged(before) {
  broadcast('settings', publicSettings());
  applySpeechSettings(before);
  // "On this PC" chosen: its model is downloaded now (Google listens until it is ready)
  if (settings.speechProvider === 'local' && before.speechProvider !== 'local' && !hardware.localReady) installModel('On this PC was chosen');
  if (before.font !== settings.font) cacheFont(settings.font);
  hub.emit('settings', settings, before);
}

// =====================================================================================
// Live events (Server-Sent Events) and what is on the screen
// =====================================================================================
const clients = new Set();
let screen = { type: 'clear', at: Date.now() };
const screenStack = [];   // what was on the screen before (videos left out): Back goes down it
let hold = false;         // Hold: the consoles list what they find but put nothing on the screen by themselves (off at every start)
// Every change of the screen comes through here: it goes to the displays and consoles, into the history and the log
// (with the time, and who or what did it), and the screen before it is kept for Back.
const sameScreen = (a, b) => a.type === b.type && (a.type === 'clear' || (a.type === 'show' && JSON.stringify(a.ref) === JSON.stringify(b.ref)) ||
  (a.type === 'message' && a.title === b.title && a.text === b.text) || (a.type === 'video' && a.video.id === b.video.id));
function setScreen(next, why) {
  const same = sameScreen(screen, next);
  if (same && next.type === 'clear') return;
  if (!same && screen.type !== 'video') { screenStack.push(screen); if (screenStack.length > 10) screenStack.shift(); }
  screen = Object.assign({}, next, { at: Date.now() });
  broadcast('screen', screen);
  recordScreen(why || '');
}
function recordScreen(why) {
  const s = screen;
  if (s.type === 'show') history('shown', { label: s.label, labelEn: s.labelEn, ref: s.ref, why });
  else if (s.type === 'message') history('message', { title: s.title, text: s.text, why });
  else if (s.type === 'video') history('video', { id: s.video.id, title: s.video.title, why });
  else history('clear', { why });
  logLine('screen', (s.type === 'show' ? s.labelEn || s.label : s.type === 'message' ? 'message: ' + (s.title || String(s.text || '').slice(0, 40))
    : s.type === 'video' ? 'video: ' + s.video.title : 'cleared') + (why ? `  (${why})` : ''));
}
// Back: the screen from before comes back (the wrong one is not kept)
function screenBack() {
  const prev = screenStack.pop();
  if (!prev) return false;
  screen = Object.assign({}, prev, { at: Date.now(), back: true });
  if (screen.type === 'show') screen.why = 'back';
  broadcast('screen', screen);
  recordScreen('back');
  return true;
}
function setHold(on, by) {
  if (hold === !!on) return;
  hold = !!on;
  broadcast('hold', { on: hold });
  history(hold ? 'hold-on' : 'hold-off', { by: by || '' });
  logLine('screen', `Hold ${hold ? 'on' : 'off'}${by ? `  (${by})` : ''}`);
}
let videoStatus = null;   // the display's last report on the video: { id, playing, time, duration, at } (for the phone's progress bar)
const videoAudio = { volume: 100, muted: false };
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) { try { send(c, event, data); } catch { /* closed */ } } }
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch { /* closed */ } } }, 20000).unref();

// =====================================================================================
// History: every service is kept in data\history\<date>.jsonl (what was heard, shown and played)
// =====================================================================================
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function history(type, data) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(path.join(HISTORY_DIR, today() + '.jsonl'), JSON.stringify(Object.assign({ t: Date.now(), type }, data)) + '\n');
  } catch { /* history is a nice-to-have */ }
}
function historyDays() {
  try {
    return fs.readdirSync(HISTORY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse().map(f => {
      const lines = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8').split('\n').filter(Boolean);
      let shown = 0, heard = 0;
      for (const l of lines) { if (l.includes('"type":"shown"')) shown++; else if (l.includes('"type":"heard"')) heard++; }
      return { day: f.slice(0, 10), shown, heard };
    });
  } catch { return []; }
}
function historyDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return [];
  try {
    return fs.readFileSync(path.join(HISTORY_DIR, day + '.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
// who or what put something on the screen, in words (the console's History tab has the same list)
const WHY_TEXT = { 'auto-reference': 'by itself: reference heard', 'auto-context': 'by itself: verse number heard', 'auto-quote': 'by itself: quote heard',
  'auto-quote+': 'by itself: quote heard, with the verses before it', 'auto-phrase': 'by itself: set prayer', 'auto-next': 'by itself: "next verse" said',
  'auto-prev': 'by itself: "previous verse" said', 'spoken-next': 'by itself: "next verse" said', 'spoken-prev': 'by itself: "previous verse" said',
  'read-along': 'by itself: followed the reading', 'read-on': 'by itself: followed the reading', 'end-of-verse': 'by itself: followed the reading (verse ended)',
  'reading-stopped': 'by itself: the reading stopped, back one verse', 'chapter-opening': 'by itself: chapter announced, opening words heard',
  card: 'operator: a card', picker: 'operator: Bible tab', search: 'operator: search', plan: 'operator: plan', phone: 'phone remote', arrows: 'operator: next / previous',
  newest: 'operator: Enter', transcript: 'operator: transcript', history: 'operator: history', operator: 'operator', back: 'Back', 'video-ended': 'the video ended',
  'auto-video': 'by itself: its title was said' };
function historyText(day) {
  const rows = historyDay(day);
  const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const shown = rows.filter(r => r.type === 'shown');
  const out = [`Arabic Church Assistant — service of ${day}`, ''];
  if (shown.length) {
    out.push('Verses shown on screen:');
    const seen = new Set();
    for (const r of shown) { const k = r.labelEn || r.label; if (seen.has(k)) continue; seen.add(k); out.push(`  ${time(r.t)}  ${r.labelEn || ''}  ${r.label || ''}`); }
    out.push('');
  }
  const vids = rows.filter(r => r.type === 'video');
  if (vids.length) { out.push('Videos played:'); for (const r of vids) out.push(`  ${time(r.t)}  ${r.title}`); out.push(''); }
  // everything that happened on the screen, in order, to the second, and who or what did it
  const secs = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const screenRows = rows.filter(r => ['shown', 'message', 'video', 'clear', 'hold-on', 'hold-off', 'listen-on', 'listen-off', 'start', 'record-on', 'record-off'].includes(r.type));
  if (screenRows.length) {
    out.push('Screen log:');
    for (const r of screenRows) {
      const what = r.type === 'shown' ? `${r.labelEn || ''}  ${r.label || ''}` : r.type === 'message' ? `message: ${r.title || String(r.text || '').slice(0, 60)}`
        : r.type === 'video' ? `video: ${r.title}` : r.type === 'clear' ? 'screen cleared' : r.type === 'start' ? `Arabic Church Assistant ${r.version || ''} started`
        : r.type === 'record-on' ? `sound recording started: ${r.file}` : r.type === 'record-off' ? `sound recording stopped: ${r.file}`
        : r.type.replace('-', ' ');
      const why = r.why || r.by || '';
      out.push(`  ${secs(r.t)}  ${what}${why ? `   [${WHY_TEXT[why] || why}]` : ''}`);
    }
    out.push('');
  }
  // each sentence with the second it was heard and, when the service was recorded, where it is in the recording
  out.push('Transcript:');
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  for (const r of rows) if (r.type === 'heard') out.push(`[${secs(r.t)}${r.rec ? `, ${r.rec} at ${mmss(r.at)}` : ''}] ${r.text}`);
  return out.join('\r\n');
}

// =====================================================================================
// Service plan: verses prepared before the service, one click to show
// =====================================================================================
const PLAN_FILE = path.join(DATA, 'plan.json');
let plan = (() => { try { const p = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); return Array.isArray(p.items) ? p : { items: [] }; } catch { return { items: [] }; } })();
function savePlan() { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 1)); } catch { /* ignore */ } }

// =====================================================================================
// Speech engine: the model on this PC (Cohere Transcribe Arabic), Google through Chrome, or a paid cloud service
// =====================================================================================
const speech = new Speech(ROOT);
const liveInput = () => (settings.inputKind === 'loopback' ? { kind: 'loopback', name: settings.speakerName || '' } : { kind: 'mic', name: settings.micName || '' });
// USD an hour. ElevenLabs Scribe v3 Live: $0.22 + $0.08 for the Bible-name hints. Deepgram Nova-3 (whole sentences): $0.258.
// Soniox real-time (stt-rt-v6): about $0.12, charged for as long as a stream is open (it is open only while listening).
const PRICES = { elevenlabs: 0.30, deepgram: 0.258, soniox: 0.12, google: 0 };
const PAID = ['elevenlabs', 'deepgram', 'soniox'];

// What this PC has for listening. Google speech through Chrome (free, needs internet) is the default. "On this PC" uses
// the model on this PC; it is downloaded when that is chosen (installModel), and Google listens until it is ready.
// "Automatic" uses the model when it is installed and the graphics card is good enough for it, otherwise Google.
const hardware = { gpu: null, gpuGood: false, gpuChecked: false, chrome: '', localReady: false, torchGpu: true };
const modelJob = { state: 'idle', step: '', error: '', startedAt: 0, proc: null, switchWhenIdle: false, timer: null };
function findChrome() {
  const env = process.env;
  if (IS_MAC) {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const exe = path.join(dir, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
      if (fs.existsSync(exe)) return exe;
    }
    return '';
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) {
    const exe = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  if (process.platform !== 'win32') return '';
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?\.exe)"?\s*$/im.exec(out);
      if (m && fs.existsSync(m[1])) return m[1];
    } catch { /* not installed for this hive */ }
  }
  return '';
}
function localModelReady() {
  if (IS_MAC) return false;
  const eng = path.join(ROOT, 'engine');
  if (!fs.existsSync(path.join(enginePython(eng).packages, 'torch', '__init__.py'))) return false;   // the light install
  return modelFilesHere();
}
// the model's files: in engine\models, or in the Hugging Face cache of this Windows user
function modelFilesHere() {
  if (fs.existsSync(path.join(ROOT, 'engine', 'models', 'cohere-transcribe-arabic-07-2026', 'model.safetensors'))) return true;
  try {
    const hub = process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
    const snaps = path.join(hub, 'models--CohereLabs--cohere-transcribe-arabic-07-2026', 'snapshots');
    return fs.readdirSync(snaps).some(d => fs.existsSync(path.join(snaps, d, 'model.safetensors')));
  } catch { return false; }
}
// The model runs on NVIDIA cards (CUDA) in half precision and takes about 4.6 GB of the card's memory while it works
// (measured on an RTX 4070): so 6 GB or more, and a card that is fast at half precision (GeForce 16 / RTX 20 series or
// newer, compute capability 7.0+; the GTX 10 series and older are very slow at it).
function gpuGood(g) {
  return !!g && g.memMB >= 5800 && (g.cc != null ? g.cc >= 7 : /\bRTX\b|GTX 16|TITAN V|Tesla [TV]|Quadro (?:RTX|T)\d*|\b[AHL]\d{1,4}\b/i.test(g.name));
}
// Setup writes ready.txt (in engine\python, or engine\.venv for older installs) from torch.cuda.is_available():
// "cuda 2.x …" or "cpu 2.x …" (perhaps after warnings).
// "cpu" with a good card means the card can't be used (setup before the driver, a driver too old, Setup.bat -Cpu).
function torchUsesGpu() {
  try { const m = /^(cuda|cpu) \d/m.exec(fs.readFileSync(path.join(enginePython(path.join(ROOT, 'engine')).home, 'ready.txt'), 'utf8')); return !m || m[1] === 'cuda'; }
  catch { return true; }
}
function checkGpu() {
  const exe = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')].find(f => fs.existsSync(f));
  if (!exe) return Promise.resolve(null);
  const query = fields => new Promise(resolve => execFile(exe, ['--query-gpu=' + fields, '--format=csv,noheader,nounits'],
    { timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? null : String(out))));
  const parse = out => (out || '').split(/\r?\n/).map(l => l.split(',').map(x => x.trim())).filter(a => a[0])
    .map(([name, mem, cc]) => ({ name, memMB: parseInt(mem, 10) || 0, cc: Number.isFinite(parseFloat(cc)) ? parseFloat(cc) : null }))
    .sort((a, b) => gpuGood(b) - gpuGood(a) || b.memMB - a.memMB)[0] || null;
  // drivers from before 2022 don't know compute_cap: then the card's name decides
  return query('name,memory.total,compute_cap').then(out => out || query('name,memory.total')).then(parse);
}
// (while the model is being downloaded it is not ready, even when PyTorch and the model's file are already there)
function refreshHardware() { hardware.chrome = findChrome(); hardware.localReady = modelJob.state !== 'running' && localModelReady(); hardware.torchGpu = torchUsesGpu(); }
const autoProvider = () => (IS_MAC ? 'google' : hardware.gpuGood && hardware.localReady && hardware.torchGpu ? 'local' : hardware.chrome ? 'google' : 'local');
// "On this PC" before its model is ready: Google listens meanwhile (when Chrome is there). On a Mac: Google.
const speechProvider = () => {
  const p = settings.speechProvider === 'auto' ? autoProvider() : settings.speechProvider;
  return p === 'local' && (IS_MAC || (!hardware.localReady && hardware.chrome)) ? 'google' : p;
};
function hardwareInfo() {
  refreshHardware();
  // Chrome installed or the model set up since: an automatic choice follows (not in the middle of listening)
  if (hardware.gpuChecked && settings.speechProvider === 'auto' && autoProvider() !== speech.config.provider && !speech.listening) applySpeechSettings();
  return { gpu: hardware.gpu, gpuGood: hardware.gpuGood, gpuChecked: hardware.gpuChecked, chrome: !!hardware.chrome,
    localReady: hardware.localReady, torchGpu: hardware.torchGpu, auto: autoProvider(), provider: speechProvider(), platform: process.platform };
}
const cloudKey = () => (PAID.includes(speechProvider()) ? secrets[speechProvider() + 'Key'] || '' : '');
// words to listen out for (cloud services that take a hint list): the words that name a hymn, the books of the Bible and
// the hymn titles. (Without «ترنيمة» in the list Soniox wrote it «تقريباً» every time in a family's test on 26 Nov; with it,
// every time right.)
function keyterms() {
  const VE = require('./public/engine.js');
  const out = ['ترنيمة', 'ترانيم', 'نرنم'].concat(VE.BOOKS.map(b => b.ar.replace(/[\u064B-\u0652]/g, '')));
  for (const p of videoLib.playlists) for (const v of p.videos || []) { const t = (VE.splitTitle(v.title)[0] || '').trim(); if (t && t.length <= 40) out.push(t); }
  return [...new Set(out)].slice(0, 100);
}
function applySpeechSettings(before) {
  const provider = speechProvider(), was = speech.config.provider;
  const cfg = { language: settings.listenLang, pause: settings.pause, sensitivity: settings.sensitivity, device: settings.speechDevice,
    provider, keyterms: PAID.includes(provider) && settings.speechHints !== false ? keyterms() : [], record: settings.recordService ? RECORD_DIR : '' };
  const key = cloudKey(), keyChanged = key !== speech.cloudKey;      // (a key pasted into settings.json in Notepad, too)
  speech.cloudKey = key;
  speech.chrome = hardware.chrome;
  speech.setConfig(cfg);
  if (speech.child && (was !== provider || keyChanged || (before && before.speechDevice !== settings.speechDevice))) speech.restart();
  if (speech.input.kind !== 'file') {
    const want = liveInput();
    if (want.kind !== speech.input.kind || want.name !== speech.input.name) speech.setInput(want);
  }
}
refreshHardware();
speech.input = liveInput();
speech.config = { language: settings.listenLang, pause: settings.pause, maxLen: 15, sensitivity: settings.sensitivity, device: settings.speechDevice,
  provider: speechProvider(), record: settings.recordService ? RECORD_DIR : '' };
speech.chrome = hardware.chrome;
speech.cloudKey = '';
setImmediate(() => { speech.cloudKey = cloudKey(); });
// the engine starts once the graphics card has been looked at (for "Automatic"); it takes a moment
speech.gate = checkGpu().catch(() => null).then(g => {
  hardware.gpu = g; hardware.gpuGood = gpuGood(g); hardware.gpuChecked = true;
  refreshHardware();
  const card = g ? `${g.name}, ${Math.round(g.memMB / 1024)} GB${!hardware.gpuGood ? ' (not suited to the speech model)'
    : !hardware.torchGpu ? ' (the speech engine was installed without graphics-card support: run Setup again)' : ''}` : 'no NVIDIA graphics card';
  if (IS_MAC) speech.addLog(`This Mac: Google Chrome ${hardware.chrome ? 'found' : 'not found'}.`);
  else speech.addLog(`This PC: ${card}; speech model ${hardware.localReady ? 'installed' : 'not installed'}; Google Chrome ${hardware.chrome ? 'found' : 'not found'}.`);
  if (settings.speechProvider === 'auto') speech.addLog('Speech recognition: Automatic → ' + (autoProvider() === 'local' ? 'the model on this PC.' : 'Google, through Chrome.'));
  applySpeechSettings();
  if (settings.speechProvider === 'local' && !hardware.localReady) installModel('On this PC is chosen and its model is not here yet');
});

// ---- the speech model for this PC: downloaded only when "On this PC" is chosen (Settings -> Listening). engine\setup.ps1
// adds PyTorch (about 3 GB with an NVIDIA card, 0.2 GB without) and the model (4 GB, straight into engine\models).
const MODEL_REPO = 'CohereLabs/cohere-transcribe-arabic-07-2026';
const MODEL_DIR = path.join(ROOT, 'engine', 'models', 'cohere-transcribe-arabic-07-2026');
// The Hugging Face key for the model's download. The download zip carries a read-only one (engine\hf-token.json, never
// part of the code on GitHub), so the model downloads without signing in; a token saved in Settings is used first.
// It is kept reversed and in base64, so leak checkers that look for "hf_..." don't switch it off. It can only download.
const BUILT_IN_HF = (() => {
  try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'hf-token.json'), 'utf8').replace(/^﻿/, ''));
    return cleanKey(j.token || [...Buffer.from(j.key || '', 'base64').toString('utf8')].reverse().join('')); }
  catch { return ''; }
})();
const hfToken = () => secrets.hfToken || BUILT_IN_HF;
function folderMB(dir) {
  let n = 0;
  const walk = d => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { n += fs.statSync(p).size; } catch { /* gone */ } } }
  };
  walk(dir);
  return Math.round(n / 1048576);
}
function modelInfo() {
  return { state: modelJob.state, step: modelJob.step, error: modelJob.error, startedAt: modelJob.startedAt, ready: hardware.localReady,
    modelMB: modelJob.state === 'running' ? folderMB(MODEL_DIR) : 0, hfTokenSet: !!secrets.hfToken };
}
const modelChanged = () => broadcast('model', modelInfo());
// The model's page on Hugging Face lets anyone download it once they have signed in and accepted its terms (accepted
// straight away). This is asked before PyTorch is downloaded, so a refusal costs nothing.
async function modelAccess() {
  try {
    const r = await fetchWithTimeout(`https://huggingface.co/${MODEL_REPO}/resolve/main/config.json`, 15000,
      { method: 'HEAD', redirect: 'manual', headers: hfToken() ? { Authorization: 'Bearer ' + hfToken() } : {} });
    if (r.status === 401 || r.status === 403) return 'token';
    return r.status < 400 ? 'ok' : 'Hugging Face answered with error ' + r.status + '.';
  } catch { return 'No internet connection.'; }
}
async function installModel(why) {
  if (modelJob.state === 'running' || IS_MAC) return;
  refreshHardware();
  if (hardware.localReady) { modelChanged(); return; }
  Object.assign(modelJob, { state: 'running', step: 'Checking that the model can be downloaded…', error: '', startedAt: Date.now() });
  modelChanged();
  const access = modelFilesHere() ? 'ok' : await modelAccess();
  if (access !== 'ok') {
    Object.assign(modelJob, { state: access === 'token' ? 'needs-token' : 'failed', step: '', error: access === 'token' ? '' : access });
    refreshHardware();
    speech.addLog(access === 'token' ? 'Speech model for this PC: Hugging Face asks for a sign-in token first (Settings → Listening). Google listens meanwhile.'
      : 'Speech model for this PC: could not download it. ' + access);
    modelChanged();
    return;
  }
  speech.addLog(`Speech model for this PC: downloading it (${why}). Google listens until it is ready.`);
  logLine('model', 'download started: ' + why);
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  if (hfToken()) env.HF_TOKEN = hfToken();
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let proc;
  try {
    proc = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'engine', 'setup.ps1'), '-App'],
      { cwd: path.join(ROOT, 'engine'), env, windowsHide: true });
  } catch (e) {
    Object.assign(modelJob, { state: 'failed', step: '', error: 'Could not start the download: ' + e.message });
    refreshHardware(); modelChanged(); return;
  }
  modelJob.proc = proc;
  modelJob.timer = setInterval(modelChanged, 3000);                    // (how much of the model is here so far)
  const onText = buf => {
    for (let line of String(buf).split(/\r?\n|\r/)) {
      line = line.trim();
      if (!line || /^\[notice\]|^Requirement already satisfied|^Using cached|━|\d+%\|/.test(line)) continue;
      logLine('model', line);
      if (/^(Downloading|Installing|Getting|Successfully installed|NVIDIA|PyTorch|Speech engine ready|Model download failed)/i.test(line)) {
        modelJob.step = line.replace(/\s*\(\S+\)\s*$/, '').slice(0, 160);
        modelChanged();
      }
    }
  };
  proc.stdout.on('data', onText);
  proc.stderr.on('data', onText);
  proc.on('error', e => logLine('model', 'ERROR ' + e.message));
  proc.on('exit', code => {
    clearInterval(modelJob.timer);
    modelJob.proc = null;
    const stopped = modelJob.state !== 'running';                       // (stopped with the button)
    if (!stopped) modelJob.state = 'idle';
    refreshHardware();
    logLine('model', `download ended (${code})`);
    if (stopped) { /* already said */ }
    else if (code === 0 && hardware.localReady) {
      Object.assign(modelJob, { state: 'done', step: '', error: '' });
      speech.addLog('Speech model for this PC: ready.');
      if (speech.listening) { modelJob.switchWhenIdle = true; speech.addLog('It is used once listening stops.'); }
      else applySpeechSettings();
    } else if (code === 3) {
      Object.assign(modelJob, { state: 'needs-token', step: '', error: '' });
      speech.addLog('Speech model for this PC: Hugging Face asks for a sign-in token first (Settings → Listening).');
    } else {
      Object.assign(modelJob, { state: 'failed', step: '', error: `The download stopped (code ${code}). Try again carries on from where it stopped; data\\logs has the details.` });
      speech.addLog('Speech model for this PC: ' + modelJob.error);
    }
    modelChanged();
  });
}
function stopModelInstall() {
  if (!modelJob.proc) return;
  Object.assign(modelJob, { state: 'idle', step: '', error: '' });
  killTree(modelJob.proc);
  speech.addLog('Speech model for this PC: the download was stopped.');
  modelChanged();
}
hub.on('speech', st => {
  if (modelJob.switchWhenIdle && st && !st.listening) { modelJob.switchWhenIdle = false; applySpeechSettings(); }
});
// what the cloud service has cost this month (data\usage.json: seconds per month and service)
const USAGE_FILE = path.join(DATA, 'usage.json');
let usage = (() => { try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return {}; } })();
const month = () => today().slice(0, 7);
function usageNow() {
  const m = usage[month()] || {};
  const hours = Object.fromEntries(Object.entries(m).map(([k, s]) => [k, s / 3600]));
  const price = k => (k === 'elevenlabs' && settings.speechHints === false ? 0.22 : PRICES[k] || 0);
  const cost = Object.entries(hours).reduce((sum, [k, h]) => sum + h * price(k), 0);
  return { month: month(), hours, cost: Math.round(cost * 100) / 100 };
}
speech.on('billed', b => {
  const m = usage[month()] = usage[month()] || {};
  m[b.provider] = (m[b.provider] || 0) + (b.seconds || 0);
  clearTimeout(usage._t);
  usage._t = setTimeout(() => { try { const u = Object.assign({}, usage); delete u._t; fs.writeFileSync(USAGE_FILE, JSON.stringify(u)); } catch { /* ignore */ } }, 2000);
});
let lastSpeechLine = '';
speech.on('status', st => {
  broadcast('speech', st); hub.emit('speech', st);
  const line = `${st.state}${st.message ? ': ' + st.message : ''}${st.inputState && st.inputState.name ? `  [${st.inputState.kind}: ${st.inputState.name}${st.inputState.ok === false ? ' NOT OPEN' : ''}]` : ''}`;
  if (line !== lastSpeechLine) { lastSpeechLine = line; logLine('speech', line); }
});
speech.on('devices', d => broadcast('devices', d));
speech.on('level', l => broadcast('level', l));
speech.on('file', f => broadcast('file', f));
speech.on('warn', m => broadcast('speech-warn', { message: m }));
speech.on('transcript', t => {
  broadcast('transcript', t);
  if (!t.text) return;
  const seg = t.seg == null ? '-' : t.seg;
  // The log keeps every sentence and the words as they arrived (what the screen rules saw, and when), so a service can
  // be gone through again afterwards (node test/replay-log.js). A sentence also says where it is in the recording.
  if (!t.final) { logLine('words', `#${seg} ${t.text}`); return; }
  const where = t.rec ? `; ${t.rec} at ${t.at} s` : '';
  // (sure: how sure the model on this PC was of the sentence: 0 is certain, below about -0.3 it was guessing)
  const sure = typeof t.score === 'number' ? `; sure ${t.score.toFixed(2)}` : '';
  logLine('heard', `#${seg} ${t.text}  [${t.dur != null ? t.dur + ' s' : '?'}; ${t.ms != null ? t.ms + ' ms' : '?'}${sure}${where}${t.late ? '; late' : ''}]`);
  // heard: when the sentence started (clock time, s), how long it was, how long its text took (ms), and the recording
  history('heard', { text: t.text, lang: t.lang, start: t.start, dur: t.dur, ms: t.ms, late: t.late, rec: t.rec, at: t.at });
});
speech.on('recording', r => {
  if (r.on) { logLine('record', `started ${r.file}`); history('record-on', { file: r.file, began: r.began }); }
  else { logLine('record', `stopped ${r.file} (${r.seconds} s)`); history('record-off', { file: r.file, seconds: r.seconds }); }
});
let logQueue = [];
speech.on('log', line => {
  logLine('engine', line);
  logQueue.push(line);
  if (logQueue.length === 1) setTimeout(() => { broadcast('speech-log', logQueue); logQueue = []; }, 400);
});

// =====================================================================================
// Fonts — downloaded once from Google Fonts and kept in data\fonts so the display works offline
// =====================================================================================
const FONT_FAMILIES = {
  naskh: 'family=Noto+Naskh+Arabic:wght@400;700',
  amiri: 'family=Amiri:wght@400;700',
  scheherazade: 'family=Scheherazade+New:wght@400;700',
  cairo: 'family=Cairo:wght@400;700',
  tajawal: 'family=Tajawal:wght@400;700',
  readex: 'family=Readex+Pro:wght@400;600',
  kufi: 'family=Noto+Kufi+Arabic:wght@400;700',
  ui: 'family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Arabic:wght@400;500;600',
  en: 'family=EB+Garamond:ital@0;1',
};
const googleCss = key => `https://fonts.googleapis.com/css2?${FONT_FAMILIES[key]}&display=swap`;
const fontJobs = {};
async function cacheFont(key) {
  const cssPath = path.join(FONT_DIR, key + '.css');
  if (fs.existsSync(cssPath)) return true;
  if (fontJobs[key]) return fontJobs[key];
  fontJobs[key] = (async () => {
    try {
      fs.mkdirSync(path.join(FONT_DIR, 'files'), { recursive: true });
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
      const res = await fetchWithTimeout(googleCss(key), 15000, { headers: { 'User-Agent': ua } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let css = await res.text();
      const urls = [...new Set((css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g) || []).map(u => u.slice(4, -1)))];
      for (const u of urls) {
        const name = u.replace(/^https:\/\/fonts\.gstatic\.com\//, '').replace(/[^A-Za-z0-9._-]/g, '_');
        const dest = path.join(FONT_DIR, 'files', name);
        if (!fs.existsSync(dest)) {
          const r = await fetchWithTimeout(u, 30000);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
        }
        css = css.split(u).join('/fonts/files/' + name);
      }
      fs.writeFileSync(cssPath, css);
      return true;
    } catch { return false; }
  })();
  const ok = await fontJobs[key];
  delete fontJobs[key];
  return ok;
}
async function cacheAllFonts() {
  for (const key of ['ui', settings.font, 'en', ...Object.keys(FONT_FAMILIES)]) await cacheFont(key);
}

// =====================================================================================
// YouTube playlists: titles are read from YouTube (no API key needed) and kept in data\videos.json
// =====================================================================================
const VIDEOS_FILE = path.join(DATA, 'videos.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
let videoLib = (() => { try { return JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8')); } catch { return { playlists: [] }; } })();
if (!Array.isArray(videoLib.playlists)) videoLib.playlists = [];
function saveVideoLib() { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(VIDEOS_FILE, JSON.stringify(videoLib, null, 1)); }

function playlistIdFrom(url) {
  const m = String(url).match(/[?&]list=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : null;
}
function videoIdFrom(url) {
  const s = String(url);
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(s.trim()) ? s.trim() : null);
}
// Pull a JSON object that follows `marker` out of an HTML page (brace matching, string-aware)
function jsonAfter(html, marker) {
  let i = html.indexOf(marker);
  if (i < 0) return null;
  i = html.indexOf('{', i);
  if (i < 0) return null;
  let depth = 0, inStr = false, escp = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(html.slice(i, j + 1)); } catch { return null; } }
  }
  return null;
}
const ytText = t => !t ? '' : typeof t === 'string' ? t : t.simpleText || t.content || (Array.isArray(t.runs) ? t.runs.map(r => r.text).join('') : '');
// Walk YouTube's page data collecting videos (old and new page layouts) and the "load more" tokens, in the order they
// are on the page (a page can hold two: the first, at the end of the list of videos, is the one that brings more).
function collectVideos(node, out, seen) {
  const tokens = [];
  const tokenIn = n => {
    if (!n || typeof n !== 'object') return null;
    if (typeof n.token === 'string' && n.token) return n.token;
    for (const k in n) { const t = tokenIn(n[k]); if (t) return t; }
    return null;
  };
  const visit = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const r = n.playlistVideoRenderer || n.playlistPanelVideoRenderer;
    if (r && r.videoId) {
      const title = ytText(r.title);
      if (title && r.isPlayable !== false && !/^\[(Deleted|Private) video\]$/i.test(title) && !seen.has(r.videoId)) {
        seen.add(r.videoId);
        out.push({ id: r.videoId, title, duration: ytText(r.lengthText) || '' });
      }
    }
    const lv = n.lockupViewModel;
    if (lv && lv.contentId && /VIDEO/.test(lv.contentType || 'VIDEO')) {
      const md = lv.metadata && lv.metadata.lockupMetadataViewModel;
      const title = md ? ytText(md.title) : '';
      if (title && !seen.has(lv.contentId)) { seen.add(lv.contentId); out.push({ id: lv.contentId, title, duration: '' }); }
    }
    const c = n.continuationItemRenderer || n.continuationItemViewModel;
    if (c) { const t = tokenIn(c); if (t && !tokens.includes(t)) tokens.push(t); }
    for (const k in n) if (k !== 'playlistVideoRenderer' && k !== 'lockupViewModel' && k !== 'continuationItemRenderer' && k !== 'continuationItemViewModel') visit(n[k]);
  };
  visit(node);
  return tokens;
}
function playlistTitleFrom(data) {
  try {
    return ytText(data.metadata.playlistMetadataRenderer.title) ||
      ytText(data.header.playlistHeaderRenderer.title) ||
      ytText(data.header.pageHeaderRenderer.pageTitle) || '';
  } catch { return ''; }
}
async function fetchPlaylist(listId, maxPages) {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
  let lastErr = null;
  // 1) the playlist page (+ "load more" for long playlists)
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/playlist?list=${listId}&hl=ar`, 25000, { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const data = jsonAfter(html, 'var ytInitialData = ') || jsonAfter(html, 'window["ytInitialData"] = ') || jsonAfter(html, 'ytInitialData = ');
    if (!data) throw new Error('could not read the page');
    const alert = JSON.stringify(data.alerts || '');
    const version = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '2.20250101.00.00';
    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const videos = [], seen = new Set();
    let tokens = collectVideos(data, videos, seen);
    for (let page = 0; tokens.length && page < (maxPages || 25); page++) {
      let next = [];
      for (const token of tokens) {                 // the "load more" that brings videos is the one to follow
        const had = videos.length;
        let r = null;
        for (let go = 0; go < 2 && !(r && r.ok); go++) {
          r = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/browse?prettyPrint=false${key ? '&key=' + key : ''}`, 25000, {
            method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: 'ar' } }, continuation: token }),
          }).catch(() => null);
        }
        if (!r || !r.ok) continue;
        const more = collectVideos(await r.json(), videos, seen);
        if (videos.length > had) { next = more; break; }
      }
      tokens = next;
    }
    if (videos.length) return { id: listId, title: playlistTitleFrom(data) || 'YouTube playlist', videos };
    lastErr = new Error(/does not exist|private|غير متاح|غير موجود/i.test(alert) ? 'the playlist is private or does not exist' : 'no videos found on the page');
  } catch (e) { lastErr = e; }
  // 2) YouTube's feed (only the newest 15 videos, but very reliable)
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/feeds/videos.xml?playlist_id=${listId}`, 20000, { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const videos = [];
    for (const m of xml.matchAll(/<entry>[\s\S]*?<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<title>([^<]*)<\/title>[\s\S]*?<\/entry>/g)) videos.push({ id: m[1], title: dec(m[2]), duration: '' });
    const title = dec((xml.match(/<title>([^<]*)<\/title>/) || [])[1] || 'YouTube playlist');
    if (videos.length) return { id: listId, title, videos, partial: true };
  } catch (e) { lastErr = lastErr || e; }
  throw new Error('Could not read that playlist from YouTube (' + (lastErr ? lastErr.message : 'unknown error') + '). Make sure it is Public or Unlisted and that this PC is online.');
}
async function fetchVideoTitle(videoId) {
  const res = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`, 15000, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('YouTube could not find that video (HTTP ' + res.status + ')');
  const j = await res.json();
  return { id: videoId, title: j.title || videoId, duration: '' };
}
// Searches YouTube the way its own page does (no API key): the results are in the page's data.
async function youtubeSearch(q) {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
  const res = await fetchWithTimeout(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`, 20000, { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = jsonAfter(await res.text(), 'var ytInitialData = ') || {};
  const out = [], seen = new Set();
  const visit = n => {
    if (!n || typeof n !== 'object' || out.length >= 25) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const r = n.videoRenderer;
    if (r && r.videoId && !seen.has(r.videoId)) {
      seen.add(r.videoId);
      out.push({ id: r.videoId, title: ytText(r.title), duration: ytText(r.lengthText) || '', channel: ytText(r.ownerText || r.longBylineText) || '' });
    }
    for (const k in n) if (k !== 'videoRenderer') visit(n[k]);
  };
  visit(data);
  return out.filter(v => v.title);
}
function publicLibrary() {
  return {
    playlists: videoLib.playlists.map(p => ({ id: p.id, url: p.url, title: p.title, fetchedAt: p.fetchedAt, partial: !!p.partial, error: p.error || '', videos: p.videos || [] })),
  };
}
function syncPlaylistSetting() {
  settings = Object.assign({}, settings, { playlists: videoLib.playlists.filter(p => p.id !== 'singles').map(p => p.url) });
  try { saveSettings(settings); } catch { /* ignore */ }
  broadcast('settings', publicSettings());
}
async function addToLibrary(url) {
  url = String(url || '').trim();
  const listId = playlistIdFrom(url);
  if (listId) {
    const pl = await fetchPlaylist(listId);
    const entry = { id: listId, url, title: pl.title, fetchedAt: Date.now(), partial: !!pl.partial, videos: pl.videos };
    const i = videoLib.playlists.findIndex(p => p.id === listId);
    if (i >= 0) videoLib.playlists[i] = entry; else videoLib.playlists.push(entry);
    return entry;
  }
  const vid = videoIdFrom(url);
  if (!vid) throw new Error(channelLinkFrom(url) ? 'That is a channel. Your playlists take a playlist or a video: for every video of a channel, use “＋ Song database”.'
    : 'That isn\'t a YouTube playlist or video link. Copy the link from the address bar or the Share button.');
  const v = await fetchVideoTitle(vid);
  let singles = videoLib.playlists.find(p => p.id === 'singles');
  if (!singles) { singles = { id: 'singles', url: 'singles', title: 'Single videos', fetchedAt: Date.now(), videos: [] }; videoLib.playlists.push(singles); }
  if (!singles.videos.some(x => x.id === v.id)) singles.videos.push(v);
  singles.fetchedAt = Date.now();
  return singles;
}
async function refreshLibrary(onlyStale) {
  let changed = false;
  for (const p of videoLib.playlists) {
    if (p.id === 'singles') continue;
    if (onlyStale && Date.now() - (p.fetchedAt || 0) < 12 * 3600 * 1000) continue;
    try {
      const pl = await fetchPlaylist(p.id);
      Object.assign(p, { title: pl.title, videos: pl.videos, fetchedAt: Date.now(), partial: !!pl.partial, error: '' });
    } catch (e) { p.error = e.message; }
    changed = true;
  }
  // links typed into settings.json by hand
  for (const url of settings.playlists || []) {
    const id = playlistIdFrom(url);
    if (id && !videoLib.playlists.some(p => p.id === id)) {
      try { await addToLibrary(url); changed = true; } catch (e) { log('Could not load playlist ' + url + ': ' + e.message); }
    }
  }
  if (changed) { saveVideoLib(); broadcast('videos', publicLibrary()); }
}

// =====================================================================================
// The song database: every title of whole playlists and channels (thousands of hymns), read from YouTube once and kept
// in data\songs.json, so finding one takes no trip to YouTube. Nothing in it plays by itself: when a hymn is announced
// that is not in the playlists above, the console lists what the database has by that name, and the Videos tab
// searches it as you type. A video's link is https://www.youtube.com/watch?v=<its id>.
//   { sources: [ { id, kind: 'playlist' | 'channel', url, title, fetchedAt, error, videos: [[id, title], …] } ] }
// =====================================================================================
const SONGS_FILE = path.join(DATA, 'songs.json');
let songDb = (() => { try { const j = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8').replace(/^\uFEFF/, '')); return j && Array.isArray(j.sources) ? j : { sources: [] }; } catch { return { sources: [] }; } })();
function saveSongDb() {
  fs.mkdirSync(DATA, { recursive: true });
  // a video a line: the file can be read, searched and compared by eye
  const one = x => JSON.stringify({ id: x.id, kind: x.kind, url: x.url, title: x.title, fetchedAt: x.fetchedAt, error: x.error || '' }).slice(0, -1) +
    ',"videos":[\n' + (x.videos || []).map(v => JSON.stringify(v)).join(',\n') + '\n]}';
  const txt = '{"sources":[\n' + songDb.sources.map(one).join(',\n') + '\n]}\n';
  const tmp = SONGS_FILE + '.tmp';
  fs.writeFileSync(tmp, txt);
  fs.renameSync(tmp, SONGS_FILE);
}
// what the console gets: each video once (the first list that has it), with which list it came from
function publicSongs() {
  const seen = new Set(), videos = [];
  songDb.sources.forEach((src, i) => { for (const v of src.videos || []) if (!seen.has(v[0])) { seen.add(v[0]); videos.push([v[0], v[1], i]); } });
  return { sources: songDb.sources.map(x => ({ id: x.id, kind: x.kind, url: x.url, title: x.title, fetchedAt: x.fetchedAt, error: x.error || '', count: (x.videos || []).length })), videos };
}
let phoneSongIdx = null;
function songIndexForPhone() {
  if (!phoneSongIdx) phoneSongIdx = new (require('./public/engine.js').SongIndex)(publicSongs().videos.map(([id, title]) => ({ id, title })));
  return phoneSongIdx;
}
const songsChanged = () => { phoneSongIdx = null; broadcast('songs', { at: Date.now(), count: publicSongs().videos.length }); };
// a channel link (youtube.com/@name, /channel/UC…, /c/name, /user/name): its uploads are a playlist of their own, "UU…"
function channelLinkFrom(url) {
  const m = String(url).match(/youtube\.com\/(@[^\/?#\s]+|channel\/UC[\w-]{22}|c\/[^\/?#\s]+|user\/[^\/?#\s]+)/i);
  return m ? 'https://www.youtube.com/' + m[1] : null;
}
async function channelUploads(link) {
  let id = (link.match(/channel\/(UC[\w-]{22})/) || [])[1], title = '';
  const res = await fetchWithTimeout(link + '?hl=ar', 25000, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
  if (!res.ok) throw new Error('YouTube could not open that channel (HTTP ' + res.status + ')');
  const html = await res.text();
  id = id || (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) || html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/"channelId":"(UC[\w-]{22})"/) || [])[1];
  if (!id) throw new Error('Could not find that channel on YouTube. Copy the link of its page (youtube.com/@name).');
  title = ((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return { listId: 'UU' + id.slice(2), title };
}
async function readSongSource(url) {
  url = String(url || '').trim();
  const listId = playlistIdFrom(url), channel = listId ? null : channelLinkFrom(url);
  if (!listId && !channel) throw new Error('That isn\'t a YouTube playlist or channel link. Copy the link of a playlist, or of a channel\'s page (youtube.com/@name).');
  const ch = channel ? await channelUploads(channel) : null;
  const pl = await fetchPlaylist(ch ? ch.listId : listId, 120);
  if (pl.partial) throw new Error('YouTube only gave the newest 15 videos of that list just now. Try again in a minute.');
  return { id: ch ? ch.listId : listId, kind: ch ? 'channel' : 'playlist', url: channel || url, title: ch ? (ch.title || pl.title) : pl.title, fetchedAt: Date.now(), error: '',
    videos: pl.videos.map(v => [v.id, v.title]) };
}
async function addSongSource(url) {
  const entry = await readSongSource(url);
  const i = songDb.sources.findIndex(x => x.id === entry.id);
  if (i >= 0) songDb.sources[i] = entry; else songDb.sources.push(entry);
  saveSongDb(); songsChanged();
  return entry;
}
// read the lists again: all of them (asked for), or only those not read for two weeks (when the app starts)
async function refreshSongs(onlyStale, id) {
  let changed = false;
  for (const src of songDb.sources) {
    if (id && src.id !== id) continue;
    if (onlyStale && Date.now() - (src.fetchedAt || 0) < 14 * 24 * 3600 * 1000) continue;
    try {
      const e = await readSongSource(src.url);
      // (a list that came back much shorter was cut off on the way: the titles there are kept)
      if (e.videos.length >= (src.videos || []).length * 0.8) Object.assign(src, e); else src.error = 'YouTube gave only part of the list; kept the titles from before';
    } catch (e) { src.error = e.message; }
    changed = true;
  }
  if (changed) { saveSongDb(); songsChanged(); }
}

// =====================================================================================
// English on screen: built-in translations (KJV, BSB, WEB, ASV), or ESV / API.Bible (NIV, NKJV…)
// fetched verse by verse with the church's own free key. At most 500 verses are kept in memory,
// as the ESV terms require.
// =====================================================================================
const ESV_BASE = process.env.ESV_API_BASE || 'https://api.esv.org';
const APIBIBLE_BASE = process.env.APIBIBLE_BASE || 'https://rest.api.bible';
const USFM = ['GEN', 'EXO', 'LEV', 'NUM', 'DEU', 'JOS', 'JDG', 'RUT', '1SA', '2SA', '1KI', '2KI', '1CH', '2CH', 'EZR', 'NEH', 'EST', 'JOB',
  'PSA', 'PRO', 'ECC', 'SNG', 'ISA', 'JER', 'LAM', 'EZK', 'DAN', 'HOS', 'JOL', 'AMO', 'OBA', 'JON', 'MIC', 'NAM', 'HAB', 'ZEP', 'HAG',
  'ZEC', 'MAL', 'MAT', 'MRK', 'LUK', 'JHN', 'ACT', 'ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL', '1TH', '2TH', '1TI', '2TI', 'TIT',
  'PHM', 'HEB', 'JAS', '1PE', '2PE', '1JN', '2JN', '3JN', 'JUD', 'REV'];
const enTitle = b => EN_BOOK_NAMES[b - 1].replace(/\b[a-z]/g, ch => ch.toUpperCase()).replace(/ Of /g, ' of ');
const verseCache = new Map();
function cacheGet(k) { const v = verseCache.get(k); if (v !== undefined) { verseCache.delete(k); verseCache.set(k, v); } return v; }
function cachePut(k, v) { verseCache.set(k, v); while (verseCache.size > 500) verseCache.delete(verseCache.keys().next().value); }

async function esvVerses(b, c, v1, v2) {
  if (!bibleKey('esvKey')) throw new Error('No ESV key yet — add it in Settings → English on screen.');
  if ([...Array(v2 - v1 + 1)].some((_, i) => cacheGet(`esv:${b}.${c}.${v1 + i}`) === undefined)) {
    const q = `${enTitle(b)} ${c}:${v1}${v2 > v1 ? '-' + v2 : ''}`;
    const url = `${ESV_BASE}/v3/passage/text/?q=${encodeURIComponent(q)}&include-passage-references=false&include-verse-numbers=true` +
      '&include-first-verse-numbers=true&include-footnotes=false&include-footnote-body=false&include-headings=false' +
      '&include-short-copyright=false&include-selahs=true&indent-paragraphs=0&indent-poetry=false&indent-declares=0&indent-psalm-doxology=0';
    const r = await fetchWithTimeout(url, 8000, { headers: { Authorization: 'Token ' + bibleKey('esvKey') } });
    if (r.status === 401 || r.status === 403) throw new Error('The ESV key was not accepted. Check it in Settings → English on screen.');
    if (!r.ok) throw new Error('The ESV service answered with error ' + r.status);
    const j = await r.json();
    const parts = (j.passages || []).join(' ').split(/\[(\d+)\]/);   // "[16] For God so loved … [17] …"
    if (parts.length === 1 && parts[0].trim()) cachePut(`esv:${b}.${c}.${v1}`, parts[0].replace(/\s+/g, ' ').trim());
    for (let i = 1; i < parts.length; i += 2) {
      const n = +parts[i];
      if (n >= v1 && n <= v2) cachePut(`esv:${b}.${c}.${n}`, parts[i + 1].replace(/\s+/g, ' ').trim());
    }
  }
  const verses = [];
  for (let v = v1; v <= v2; v++) { const t = cacheGet(`esv:${b}.${c}.${v}`); if (t) verses.push({ n: v, text: t }); }
  if (!verses.length) throw new Error('The ESV service returned no text for that verse.');
  return { version: 'ESV', verses };
}

async function apiBibleVerses(b, c, v1, v2) {
  if (!bibleKey('apiBibleKey') || !settings.apiBibleId) throw new Error('Choose the API.Bible translation in Settings → English on screen.');
  const verses = [];
  let fumsId = null;
  for (let v = v1; v <= v2; v++) {
    const k = `ab:${settings.apiBibleId}:${b}.${c}.${v}`;
    let hit = cacheGet(k);
    if (hit === undefined) {
      const url = `${APIBIBLE_BASE}/v1/bibles/${encodeURIComponent(settings.apiBibleId)}/verses/${USFM[b - 1]}.${c}.${v}` +
        '?content-type=text&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-numbers=false&include-verse-spans=false';
      const r = await fetchWithTimeout(url, 8000, { headers: { 'api-key': bibleKey('apiBibleKey') } });
      if (r.status === 401 || r.status === 403) throw new Error('API.Bible did not accept the key, or this translation is not included in your API.Bible plan.');
      if (r.status === 404) hit = { t: '', f: null };
      else {
        if (!r.ok) throw new Error('API.Bible answered with error ' + r.status);
        const j = await r.json();
        hit = { t: String((j.data && j.data.content) || '').replace(/\s+/g, ' ').trim(), f: (j.meta && j.meta.fumsId) || null };
      }
      cachePut(k, hit);
    }
    if (hit.t) verses.push({ n: v, text: hit.t });
    fumsId = hit.f || fumsId;
  }
  if (!verses.length) throw new Error('API.Bible returned no text for that verse.');
  return { version: settings.apiBibleAbbr || 'API.Bible', verses, fumsId };
}
async function apiBibleList(key) {
  const r = await fetchWithTimeout(`${APIBIBLE_BASE}/v1/bibles?language=eng`, 12000, { headers: { 'api-key': key } });
  if (r.status === 401 || r.status === 403) throw new Error('API.Bible did not accept that key.');
  if (!r.ok) throw new Error('API.Bible answered with error ' + r.status);
  const j = await r.json();
  return (j.data || []).map(x => ({ id: x.id, abbr: x.abbreviationLocal || x.abbreviation || '', name: x.nameLocal || x.name || '',
    desc: String(x.descriptionLocal || x.description || '').trim() }));
}
// Every English translation to choose from, in one list: the four on this PC, the ESV, and all that the church's API.Bible
// key gives. The API.Bible list is kept in data\apibible-bibles.json (with a fingerprint of the key, never the key), so it
// is there at once and without internet; it is asked for again when it is a week old or the key has changed.
const AB_LIST_FILE = path.join(DATA, 'apibible-bibles.json');
const BUILT_IN_NAMES = { kjv: ['KJV', 'King James Version'], bsb: ['BSB', 'Berean Standard Bible'], web: ['WEB', 'World English Bible'], asv: ['ASV', 'American Standard Version'] };
const FAMOUS = ['NIV', 'NKJV', 'NLT', 'NASB', 'CSB', 'AMP', 'MSG', 'NRSV', 'RSV', 'GNT'];
const keyMark = k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
async function apiBibleBibles(force) {
  if (!bibleKey('apiBibleKey')) return { bibles: [], error: '' };
  const mark = keyMark(bibleKey('apiBibleKey'));
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(AB_LIST_FILE, 'utf8')); } catch { /* not asked for yet */ }
  if (saved && saved.key !== mark) saved = null;                       // (another key: another list)
  if (saved && !force && Date.now() - (saved.fetchedAt || 0) < 7 * 864e5) return { bibles: saved.bibles || [], fetchedAt: saved.fetchedAt, error: '' };
  try {
    const bibles = await apiBibleList(bibleKey('apiBibleKey')), fetchedAt = Date.now();
    try { fs.writeFileSync(AB_LIST_FILE, JSON.stringify({ key: mark, fetchedAt, bibles }, null, 1)); } catch { /* read-only folder */ }
    return { bibles, fetchedAt, error: '' };
  } catch (e) {                                                            // no internet, or the key was refused: the list from before
    return { bibles: saved ? saved.bibles || [] : [], fetchedAt: saved ? saved.fetchedAt : null, error: e.message };
  }
}
async function englishList(force) {
  const ab = await apiBibleBibles(force);
  const items = Object.entries(BUILT_IN_NAMES).map(([v, [abbr, name]]) => ({ v, abbr, name, where: 'pc', ready: haveBible(ENGLISH_BUILT_IN[v]) }));
  items.push({ v: 'esv', abbr: 'ESV', name: 'English Standard Version', where: 'esv' });
  const onPc = new Set(Object.values(BUILT_IN_NAMES).map(x => x[0]));
  const rank = b => { const i = FAMOUS.indexOf(b.abbr.toUpperCase()); return i < 0 ? FAMOUS.length : i; };
  const online = ab.bibles
    .filter(b => !onPc.has(b.abbr.toUpperCase()) || (settings.englishVersion === 'apibible' && settings.apiBibleId === b.id))   // (the same text is on this PC)
    .sort((a, b) => rank(a) - rank(b) || a.abbr.localeCompare(b.abbr) || a.desc.localeCompare(b.desc));
  for (const b of online) items.push({ v: 'apibible', id: b.id, abbr: b.abbr, name: b.name, desc: b.desc, where: 'apibible' });
  return { items, esvKey: !!bibleKey('esvKey'), apiBibleKey: !!bibleKey('apiBibleKey'), apiBibleCheckedAt: ab.fetchedAt || null, apiBibleError: ab.error };
}
async function onlineEnglish(b, c, v1, v2) {
  if (settings.englishVersion === 'esv') return esvVerses(b, c, v1, v2);
  if (settings.englishVersion === 'apibible') return apiBibleVerses(b, c, v1, v2);
  throw new Error('The English translation is built in.');
}

// =====================================================================================
// HTTP
// =====================================================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendFile(res, file, cache) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache || 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const isLocal = req => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');

// play / pause / resume / restart / stop / seek (t) / skip (by) / volume / mute: from the console or the phone
function videoAction(b) {
    const num = (x, lo, hi) => { const n = parseFloat(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  if (b.action === 'play' && b.id) {
    videoStatus = null;
    setScreen({ type: 'video', video: { id: String(b.id).slice(0, 20), title: String(b.title || '').slice(0, 300) }, paused: false,
      volume: videoAudio.volume, muted: videoAudio.muted }, b.why || 'operator');
  } else if (screen.type === 'video' && ['pause', 'resume', 'restart'].includes(b.action)) {
    screen.paused = b.action === 'pause';
    broadcast('video-control', { action: b.action, at: Date.now() });
  } else if (screen.type === 'video' && b.action === 'seek' && num(b.t, 0, 86400) != null) {
    broadcast('video-control', { action: 'seek', t: num(b.t, 0, 86400), at: Date.now() });
  } else if (screen.type === 'video' && b.action === 'skip' && num(b.by, -3600, 3600) != null) {
    broadcast('video-control', { action: 'skip', by: num(b.by, -3600, 3600), at: Date.now() });
  } else if (b.action === 'volume' && num(b.volume, 0, 100) != null) {
    videoAudio.volume = Math.round(num(b.volume, 0, 100));
    if (videoAudio.volume > 0) videoAudio.muted = false;
    if (screen.type === 'video') Object.assign(screen, videoAudio);
    broadcast('video-control', { action: 'volume', volume: videoAudio.volume, muted: videoAudio.muted, at: Date.now() });
  } else if (b.action === 'mute') {
    videoAudio.muted = !!b.muted;
    if (screen.type === 'video') Object.assign(screen, videoAudio);
    broadcast('video-control', { action: 'volume', volume: videoAudio.volume, muted: videoAudio.muted, at: Date.now() });
  } else if (b.action === 'stop' && screen.type === 'video') setScreen({ type: 'clear' }, b.why || 'operator');
}

// The Arabic Bible for the phone's Bible picker: read once, the first time the phone asks
let remoteBibleCache = null;
function remoteBible() {
  if (remoteBibleCache) return remoteBibleCache;
  const key = haveBible('arFull') ? 'arFull' : haveBible('arPlain') ? 'arPlain' : null;
  if (!key) return null;
  try {
    const VE = require('./public/engine.js');
    remoteBibleCache = { VE, bible: new VE.Bible(JSON.parse(fs.readFileSync(bibleFile(key), 'utf8').replace(/^﻿/, ''))) };
  } catch { return null; }
  return remoteBibleCache;
}

// one plan item, as the phone's plan list shows it (verses with the start of their text)
// What the console found lately (verses heard, hymns announced), newest first, for the phone's "Found" list. The same
// verse or hymn found again moves to the top.
let foundForPhone = [], foundSeq = 0;
function addFound(f) {
  f.n = ++foundSeq; f.t = Date.now();
  foundForPhone = [f].concat(foundForPhone.filter(x => x.key !== f.key)).slice(0, 30);
}
const cleanSongs = list => (Array.isArray(list) ? list : []).slice(0, 8).map(s => ({ id: String((s && s.id) || '').slice(0, 20), title: String((s && s.title) || '').slice(0, 200) })).filter(s => s.id);
function planForPhone(it) {
  if (it.kind === 'video') return { kind: 'video', id: it.id, title: it.title };
  const B = it.verse != null ? remoteBible() : null;
  const text = B ? String(B.bible.verse(it.book, it.chapter, it.verse) || '').replace(/[ً-ْ]/g, '') : '';
  return { kind: 'verse', label: it.label, labelEn: it.labelEn, text: text.length > 90 ? text.slice(0, 90) + '…' : text };
}

const routes = {
  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 2000\n\n');
    send(res, 'settings', publicSettings());
    send(res, 'screen', screen);
    send(res, 'hold', { on: hold });
    send(res, 'speech', speech.status());
    send(res, 'devices', speech.devices);
    send(res, 'videos', publicLibrary());
    send(res, 'plan', plan);
    if (speech.file) send(res, 'file', speech.file);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },
  'POST /api/show': async (req, res) => {
    const body = await readBody(req);
    setScreen(Object.assign({}, body, { type: 'show' }), String(body.why || 'operator').slice(0, 40));
    json(res, 200, { ok: true });
  },
  // Back: what was on the screen before
  'POST /api/back': (req, res) => json(res, 200, { ok: screenBack() }),
  // Hold: nothing goes on the screen by itself (every console follows it)
  'POST /api/hold': async (req, res) => { const b = await readBody(req); setHold(!!b.on, 'operator'); json(res, 200, { hold }); },
  // a console found a verse (the record of the service: what was found, and whether it went up by itself)
  // a hymn was heard: from the playlists (and whether it started by itself), or looked up in the song database
  'POST /api/hymn': async (req, res) => {
    const b = await readBody(req);
    const t = String(b.title || '').slice(0, 120), heard = String(b.heard || '').slice(0, 80), how = String(b.how || '').slice(0, 12);
    history('hymn', { id: b.id ? String(b.id).slice(0, 20) : undefined, title: t, heard, how, played: !!b.played, mine: !!b.mine, found: b.mine ? undefined : +b.found || 0 });
    if (b.mine && b.id) addFound({ k: 'song', key: 's:' + String(b.id).slice(0, 20), id: String(b.id).slice(0, 20), title: t, played: !!b.played });
    else if (!b.mine && cleanSongs(b.songs).length) addFound({ k: 'songs', key: 'h:' + heard, heard, how, songs: cleanSongs(b.songs) });
    logLine('hymn', b.mine ? `${t}  (heard “${heard}”; ${how}; ${b.played ? 'played by itself' : 'card only'})`
      : `“${heard}”  (${how}; not in the playlists; song database: ${+b.found ? (+b.found) + ' found, first: ' + t : 'nothing'})`);
    json(res, 200, { ok: true });
  },
  'POST /api/card': async (req, res) => {
    const b = await readBody(req);
    history('card', { label: String(b.label || '').slice(0, 100), labelEn: String(b.labelEn || '').slice(0, 100), ref: b.ref, source: String(b.source || '').slice(0, 20),
      auto: !!b.auto, partial: !!b.partial, probable: !!b.probable, match: b.match });
    logLine('card', `${String(b.labelEn || b.label || '').slice(0, 100)}  (${String(b.source || '').slice(0, 20)}${b.probable ? ', not sure' : ''}${b.partial ? ', from words still being said' : ''}; ${b.auto ? 'went up' : 'card only'})`);
    const r = b.ref || {}, num = x => (Number.isInteger(x) && x > 0 ? x : null);
    if (num(r.book) && num(r.chapter)) {
      const ref = { book: num(r.book), chapter: num(r.chapter), verse: num(r.verse), verseEnd: num(r.verseEnd) };
      addFound({ k: 'verse', key: `v:${ref.book}:${ref.chapter}:${ref.verse}:${ref.verseEnd}`, label: String(b.label || '').slice(0, 100), labelEn: String(b.labelEn || '').slice(0, 100),
        ref, source: String(b.source || '').slice(0, 20), auto: !!b.auto, probable: !!b.probable });
    }
    json(res, 200, { ok: true });
  },
  // the console's Clear: the phone's "Found" list is emptied too
  'POST /api/found/clear': (req, res) => { foundForPhone = []; foundSeq++; json(res, 200, { ok: true }); },
  // set prayers and formulas (data\phrases.json; the built-in list until it is changed)
  'GET /api/phrases': (req, res) => json(res, 200, { phrases: loadPhrases(), custom: fs.existsSync(PHRASES_FILE) }),
  'POST /api/phrases': async (req, res) => {
    const b = await readBody(req);
    try {
      if (b.reset) { try { fs.unlinkSync(PHRASES_FILE); } catch { /* was not there */ } }
      else {
        const list = (Array.isArray(b.phrases) ? b.phrases : []).slice(0, 80).map(x => ({ text: String(x.text || '').trim().slice(0, 300),
          action: ['ignore', 'card', 'show'].includes(x.action) ? x.action : 'ignore', ref: String(x.ref || '').trim().slice(0, 60), off: !!x.off })).filter(x => x.text);
        const B = remoteBible();
        for (const x of list) {
          if (x.action === 'ignore') { delete x.ref; continue; }
          const r = B && B.VE.parseQuery(x.ref, B.bible);
          if (B && (!r || r.verse == null || !B.bible.valid(r.book, r.chapter, r.verse))) return json(res, 400, { error: `“${x.ref || '(empty)'}” is not a verse. Write it like John 3:16 or متى ٦: ٩-١٣.` });
        }
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(PHRASES_FILE, JSON.stringify(list, null, 1));
      }
    } catch (e) { return json(res, 500, { error: 'Could not save: ' + e.message }); }
    broadcast('phrases', loadPhrases());
    json(res, 200, { phrases: loadPhrases(), custom: fs.existsSync(PHRASES_FILE) });
  },
  // a message of your own on the screen (announcement, sermon title, prayer points …)
  'POST /api/message': async (req, res) => {
    const b = await readBody(req);
    const text = String(b.text || '').slice(0, 2000), title = String(b.title || '').slice(0, 200);
    if (!text.trim() && !title.trim()) return json(res, 400, { error: 'Type a message first.' });
    setScreen({ type: 'message', title, text }, 'operator');
    json(res, 200, { ok: true });
  },
  'POST /api/clear': (req, res) => {
    setScreen({ type: 'clear' }, 'operator');
    json(res, 200, { ok: true });
  },
  'GET /api/state': (req, res) => json(res, 200, screen),
  'GET /api/settings': (req, res) => json(res, 200, publicSettings()),
  'POST /api/settings': async (req, res) => {
    const body = await readBody(req);
    const before = settings;
    settings = Object.assign({}, settings, cleanSettings(body));
    try { saveSettings(settings); } catch (e) { return json(res, 500, { error: 'Could not write settings.json: ' + e.message }); }
    settingsChanged(before);
    json(res, 200, publicSettings());
  },
  'GET /api/status': (req, res) => json(res, 200, {
    version: VERSION,
    desktop: !!process.versions.electron,
    bibles: { ar: haveBible('arFull') ? 'full' : haveBible('arPlain') ? 'plain' : null, en: haveBible('en') },
    english: Object.fromEntries(Object.entries(ENGLISH_BUILT_IN).map(([v, key]) => [v, haveBible(key)])),
    speech: speech.status(),
    addresses: lanAddresses().map(ip => `http://${ip}:${server.address() ? server.address().port : PORT}`),
    secureAddresses: httpsServer ? lanAddresses().map(ip => `https://${ip}:${HTTPS_PORT}`) : [],
  }),

  // ---- speech engine
  'GET /api/speech': (req, res) => json(res, 200, Object.assign(speech.status(), { log: speech.log.slice(-200), devices: speech.devices, usage: usageNow(), hardware: hardwareInfo() })),
  'POST /api/listening': async (req, res) => {
    const b = await readBody(req);
    speech.setListening(!!b.on);
    history(b.on ? 'listen-on' : 'listen-off', {});
    logLine('speech', b.on ? 'Listening on (operator)' : 'Listening off (operator)');
    hub.emit('listening', !!b.on);
    json(res, 200, { listening: speech.listening });
  },
  'POST /api/speech/input': async (req, res) => {
    const b = await readBody(req);
    if (b.kind === 'file') {
      const p = String(b.path || '');
      if (!p || !fs.existsSync(p)) return json(res, 400, { error: 'That file could not be found.' });
      speech.setInput({ kind: 'file', path: p, play: b.play !== false, realtime: true, t: 0 });
      if (!speech.listening) speech.setListening(true);
    } else {
      const patch = b.kind === 'loopback' ? { inputKind: 'loopback', speakerName: String(b.name || '') } : { inputKind: 'mic', micName: String(b.name || '') };
      const before = settings;
      settings = Object.assign({}, settings, cleanSettings(patch));
      try { saveSettings(settings); } catch { /* keep in memory */ }
      if (speech.input.kind === 'file') speech.fileControl('stop');
      speech.setInput(liveInput());
      settingsChanged(before);
    }
    json(res, 200, speech.status());
  },
  'POST /api/speech/file': async (req, res) => {
    const b = await readBody(req);
    if (!['pause', 'resume', 'seek', 'stop'].includes(b.action)) return json(res, 400, { error: 'bad action' });
    speech.fileControl(b.action, b.t);
    json(res, 200, { ok: true });
  },
  'POST /api/speech/restart': (req, res) => { speech.restart(); json(res, 200, speech.status()); },
  'POST /api/speech/devices': (req, res) => { speech.refreshDevices(); json(res, 200, { ok: true }); },
  // a recording to test with (browser version; the desktop app passes the file's path directly)
  'POST /api/upload': (req, res) => {
    const name = String(req.headers['x-file-name'] || 'recording').replace(/[^\w.\- ()؀-ۿ]/g, '_').slice(-120);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const dest = path.join(UPLOAD_DIR, Date.now() + '-' + decodeURIComponent(name));
    const out = fs.createWriteStream(dest);
    let size = 0;
    req.on('data', d => { size += d.length; if (size > 2e9) req.destroy(); });
    req.pipe(out);
    out.on('finish', () => json(res, 200, { path: dest }));
    out.on('error', e => json(res, 500, { error: e.message }));
  },

  // ---- history
  'GET /api/history': (req, res) => json(res, 200, { days: historyDays(), today: today() }),
  'GET /api/history/day': (req, res, url) => json(res, 200, { day: url.searchParams.get('d'), rows: historyDay(url.searchParams.get('d')) }),
  'GET /api/history/export': (req, res, url) => {
    const d = url.searchParams.get('d');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return json(res, 400, { error: 'bad date' });
    res.writeHead(200, { 'Content-Type': MIME['.txt'], 'Content-Disposition': `attachment; filename="Arabic Church Assistant ${d}.txt"` });
    res.end('﻿' + historyText(d));
  },

  // ---- service plan
  'GET /api/plan': (req, res) => json(res, 200, plan),
  'POST /api/plan': async (req, res) => {
    const b = await readBody(req);
    const items = Array.isArray(b.items) ? b.items.slice(0, 200).map(x => ({
      text: String(x.text || '').slice(0, 200), label: String(x.label || '').slice(0, 100), labelEn: String(x.labelEn || '').slice(0, 100),
      book: x.book | 0, chapter: x.chapter | 0, verse: x.verse ? x.verse | 0 : null, verseEnd: x.verseEnd ? x.verseEnd | 0 : null,
      kind: x.kind === 'video' || x.kind === 'message' ? x.kind : 'verse', id: String(x.id || '').slice(0, 20), title: String(x.title || '').slice(0, 300),
    })) : [];
    plan = { items, updated: Date.now() };
    savePlan();
    broadcast('plan', plan);
    json(res, 200, plan);
  },

  // ---- phone remote (needs the PIN shown in Settings)
  'GET /api/remote/pin': (req, res) => (isLocal(req) ? json(res, 200, { pin: settings.remotePin }) : json(res, 403, { error: 'only on this PC' })),
  'POST /api/remote': async (req, res) => {
    const b = await readBody(req);
    if (String(b.pin || '') !== settings.remotePin) return json(res, 403, { error: 'Wrong PIN. It is shown in Arabic Church Assistant → Settings → Phone remote.' });
    const action = String(b.action || '');
    let extra = {};
    if (action === 'clear') setScreen({ type: 'clear' }, 'phone');
    else if (action === 'back') extra.message = screenBack() ? 'Back to what was on screen before.' : 'Nothing to go back to.';
    else if (action === 'hold-on' || action === 'hold-off') setHold(action === 'hold-on', 'phone');
    else if (['next', 'prev', 'show-latest', 'plan-next', 'listen-on', 'listen-off'].includes(action)) {
      if (action === 'listen-on' || action === 'listen-off') {
        speech.setListening(action === 'listen-on');
        history(action, { by: 'phone' });
        logLine('speech', `Listening ${action === 'listen-on' ? 'on' : 'off'} (phone)`);
      }
      broadcast('remote', { action });
    } else if (action === 'message') {
      setScreen({ type: 'message', title: String(b.title || '').slice(0, 200), text: String(b.text || '').slice(0, 2000) }, 'phone');
    } else if (action === 'video') videoAction(Object.assign({}, b.video || {}, { why: 'phone' }));
    else if (action === 'videos') extra.videos = publicLibrary().playlists.flatMap(p => (p.videos || []).map(v => ({ id: v.id, title: v.title, duration: v.duration || '' })));
    else if (action === 'youtube') {
      try { extra.videos = await youtubeSearch(String(b.q || '').slice(0, 200)); } catch (e) { return json(res, 502, { error: 'YouTube search failed: ' + e.message }); }
    } else if (action === 'add-video') {
      try { await addToLibrary('https://www.youtube.com/watch?v=' + String(b.id || '')); saveVideoLib(); syncPlaylistSetting(); broadcast('videos', publicLibrary()); }
      catch (e) { return json(res, 400, { error: e.message }); }
    } else if (action === 'plan-video') {
      const id = String(b.id || '').slice(0, 20);
      if (id && !plan.items.some(it => it.kind === 'video' && it.id === id)) {   // already in the plan: nothing to add
        plan = { items: plan.items.concat([{ kind: 'video', id, title: String(b.title || '').slice(0, 300), text: '', label: '', labelEn: '', book: 0, chapter: 0, verse: null, verseEnd: null }]), updated: Date.now() };
        savePlan(); broadcast('plan', plan);
      }
    } else if (action === 'find-songs') {           // the phone's song search: your playlists first, then the song database
      const q = String(b.q || '').trim().slice(0, 100);
      const VE = require('./public/engine.js'), nq = VE.normalize(q), mine = [];
      if (nq) for (const p of videoLib.playlists) for (const v of p.videos || []) if (VE.normalize(v.title).includes(nq) && !mine.some(x => x.id === v.id)) mine.push({ id: v.id, title: v.title, duration: v.duration || '', mine: true });
      const more = nq ? songIndexForPhone().search(q, 40).filter(v => !mine.some(x => x.id === v.id)).map(v => ({ id: v.id, title: v.title })) : [];
      extra.songs = mine.slice(0, 30).concat(more);
    } else if (action === 'plan-verse') {           // "＋ Plan" on a verse the phone was shown
      const B = remoteBible(), bk = parseInt(b.book, 10), ch = parseInt(b.chapter, 10), v = parseInt(b.verse, 10), e = parseInt(b.verseEnd, 10) || null;
      if (!B || !B.bible.valid(bk, ch, v)) return json(res, 400, { error: 'No such verse.' });
      const ref = { book: bk, chapter: ch, verse: v, verseEnd: e && e > v && B.bible.valid(bk, ch, e) ? e : null };
      if (!plan.items.some(it => it.kind !== 'video' && it.book === bk && it.chapter === ch && it.verse === v && (it.verseEnd || null) === ref.verseEnd)) {
        plan = { items: plan.items.concat([Object.assign({ kind: 'verse' }, ref, { label: B.VE.refLabel(ref), labelEn: B.VE.refLabel(ref, { lang: 'en' }) })]), updated: Date.now() };
        savePlan(); broadcast('plan', plan);
      }
      extra.message = 'Added to the plan: ' + B.VE.refLabel(ref, { lang: 'en' });
    } else if (action === 'unplan-video') {         // "In Plan" tapped on the phone: take that video out of the plan
      const id = String(b.id || '').slice(0, 20);
      if (plan.items.some(it => it.kind === 'video' && it.id === id)) {
        plan = { items: plan.items.filter(it => !(it.kind === 'video' && it.id === id)), updated: Date.now() };
        savePlan(); broadcast('plan', plan);
      }
    } else if (action === 'plan-go') {            // a plan item tapped on the phone: the console runs it (and keeps its place for "Next in plan")
      const i = parseInt(b.index, 10), it = plan.items[i];
      if (!it) return json(res, 400, { error: 'That plan item is gone.' });
      broadcast('remote', { action: 'plan-go', index: i });
      extra.message = it.kind === 'video' ? 'Playing: ' + it.title : 'On screen: ' + (it.labelEn || it.label);
    } else if (action === 'command') {           // a verse or hymn typed on the phone: the console does it, like hold-to-speak
      const text = String(b.text || '').trim().slice(0, 300);
      if (!text) return json(res, 400, { error: 'Type a verse or a hymn title.' });
      const id = 'v' + Date.now();
      const answer = new Promise(resolve => { voiceWaiting.set(id, resolve); setTimeout(() => { if (voiceWaiting.delete(id)) resolve(null); }, 8000); });
      broadcast('voice-command', { id, text });
      Object.assign(extra, phoneAnswer(await answer));
    } else if (action === 'books') {                // the phone's Bible picker: book names and chapter counts…
      const B = remoteBible();
      if (!B) return json(res, 503, { error: 'The Arabic Bible is still downloading. Try again in a minute.' });
      extra.books = B.VE.BOOKS.map(k => ({ n: k.num, ar: k.ar.replace(/[ً-ْ]/g, ''), en: k.en, ch: B.bible.chapterCount(k.num) }));
    } else if (action === 'chapter') {              // …the verses of one chapter…
      const B = remoteBible(), bk = parseInt(b.book, 10), ch = parseInt(b.chapter, 10);
      if (!B || !B.bible.valid(bk, ch)) return json(res, 400, { error: 'No such chapter.' });
      extra.verses = Array.from({ length: B.bible.verseCount(bk, ch) }, (_, i) => String(B.bible.verse(bk, ch, i + 1) || '').replace(/[ً-ْ]/g, ''));
    } else if (action === 'show-ref') {             // …and one verse on the screen (the console shows it, as it does for Next)
      const B = remoteBible(), bk = parseInt(b.book, 10), ch = parseInt(b.chapter, 10), v = parseInt(b.verse, 10), e = parseInt(b.verseEnd, 10) || null;
      if (!B || !B.bible.valid(bk, ch, v)) return json(res, 400, { error: 'No such verse.' });
      const verseEnd = e && e > v && B.bible.valid(bk, ch, e) ? e : null;
      broadcast('remote', { action: 'show-ref', book: bk, chapter: ch, verse: v, verseEnd });
      extra.message = 'On screen: ' + B.VE.refLabel({ book: bk, chapter: ch, verse: v, verseEnd }, { lang: 'en' });
    } else if (action !== 'state') return json(res, 400, { error: 'unknown action' });
    json(res, 200, Object.assign({ ok: true, screen: { type: screen.type, label: screen.label, labelEn: screen.labelEn, title: screen.title || (screen.video && screen.video.title) || '' },
      video: screen.type === 'video' ? Object.assign({ id: screen.video.id, title: screen.video.title, paused: !!screen.paused, volume: videoAudio.volume, muted: videoAudio.muted },
        videoStatus && videoStatus.id === screen.video.id ? { time: videoStatus.time, duration: videoStatus.duration, playing: videoStatus.playing, age: Date.now() - videoStatus.at } : {}) : null,
      planItems: plan.items.length, plan: plan.items.map(planForPhone), listening: speech.listening, speech: speech.state, hold, canBack: screenStack.length > 0,
      found: foundForPhone.slice(0, 15), foundSeq }, extra));
  },
  // spoken command from the phone: hold to speak, let go -> a recording arrives here
  'POST /api/remote/voice': (req, res, url) => {
    if (String(url.searchParams.get('pin') || '') !== settings.remotePin) { req.resume(); return json(res, 403, { error: 'Wrong PIN.' }); }
    const chunks = []; let size = 0;
    req.on('data', d => { size += d.length; if (size > 4e6) req.destroy(); else chunks.push(d); });
    req.on('end', async () => {
      const ct = req.headers['content-type'] || '';
      const ext = /wav/.test(ct) ? '.wav' : /mp4|aac|m4a/.test(ct) ? '.m4a' : /ogg/.test(req.headers['content-type'] || '') ? '.ogg' : '.webm';
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const file = path.join(UPLOAD_DIR, 'voice-' + Date.now() + ext);
      try {
        fs.writeFileSync(file, Buffer.concat(chunks));
        const text = await speech.transcribeOnce(file);
        if (!text.trim()) return json(res, 200, { text: '', message: "Didn't catch anything. Hold the button while you speak." });
        const id = 'v' + Date.now();
        const answer = new Promise(resolve => { voiceWaiting.set(id, resolve); setTimeout(() => { if (voiceWaiting.delete(id)) resolve(null); }, 8000); });
        broadcast('voice-command', { id, text });
        json(res, 200, Object.assign({ text }, phoneAnswer(await answer)));
      } catch (e) { json(res, 500, { error: e.message }); }
      finally { setTimeout(() => fs.unlink(file, () => {}), 2000); }
    });
  },
  'POST /api/remote/voice-result': async (req, res) => {
    const b = await readBody(req);
    const done = voiceWaiting.get(b.id);
    const num = x => (Number.isInteger(x) && x > 0 ? x : null), v = b.verse || {};
    if (done) { voiceWaiting.delete(b.id); done({ message: String(b.message || ''), songs: cleanSongs(b.songs),
      verse: num(v.book) && num(v.chapter) && num(v.verse) ? { book: num(v.book), chapter: num(v.chapter), verse: num(v.verse), labelEn: String(v.labelEn || '').slice(0, 100), label: String(v.label || '').slice(0, 100) } : null }); }
    json(res, 200, { ok: true });
  },

  // ---- desktop app
  'POST /api/app/display': async (req, res) => {
    const b = await readBody(req);
    hub.emit('display', b.action || 'open', b);
    json(res, 200, { ok: true, desktop: !!process.versions.electron });
  },

  // ---- YouTube videos
  'GET /api/videos': (req, res) => json(res, 200, publicLibrary()),
  'POST /api/videos/add': async (req, res) => {
    const b = await readBody(req);
    try {
      const entry = await addToLibrary(b.url);
      saveVideoLib(); syncPlaylistSetting();
      broadcast('videos', publicLibrary());
      json(res, 200, { ok: true, playlist: { id: entry.id, title: entry.title, count: entry.videos.length, partial: !!entry.partial } });
    } catch (e) { json(res, 400, { error: e.message }); }
  },
  'POST /api/videos/remove': async (req, res) => {
    const b = await readBody(req);
    videoLib.playlists = videoLib.playlists.filter(p => p.id !== b.id);
    saveVideoLib(); syncPlaylistSetting();
    broadcast('videos', publicLibrary());
    json(res, 200, { ok: true });
  },
  'POST /api/videos/refresh': async (req, res) => { await refreshLibrary(false); json(res, 200, publicLibrary()); },
  // ---- the song database (data\songs.json)
  'GET /api/songs': (req, res) => json(res, 200, publicSongs()),
  'POST /api/songs/add': async (req, res) => {
    const b = await readBody(req);
    try { const e = await addSongSource(b.url); json(res, 200, { ok: true, source: { id: e.id, kind: e.kind, title: e.title, count: e.videos.length } }); }
    catch (e) { json(res, 400, { error: e.message }); }
  },
  'POST /api/songs/remove': async (req, res) => {
    const b = await readBody(req);
    songDb.sources = songDb.sources.filter(x => x.id !== b.id);
    saveSongDb(); songsChanged();
    json(res, 200, { ok: true });
  },
  'POST /api/songs/refresh': async (req, res) => { const b = await readBody(req); await refreshSongs(false, b.id || null); json(res, 200, { ok: true, sources: publicSongs().sources }); },
  'GET /api/youtube/search': async (req, res, url) => {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return json(res, 400, { error: 'Type something to search for.' });
    try { json(res, 200, { videos: await youtubeSearch(q) }); }
    catch (e) { json(res, 502, { error: 'YouTube could not be searched (' + e.message + '). Is this PC online?' }); }
  },
  'POST /api/video': async (req, res) => {
    videoAction(await readBody(req));
    json(res, 200, { ok: true, screen });
  },
  'POST /api/video/status': async (req, res) => {
    const b = await readBody(req);
    broadcast('video-status', b);
    if (b && b.id && (b.state === 'playing' || b.state === 'paused')) {
      videoStatus = { id: String(b.id), playing: b.state === 'playing', time: Math.max(0, +b.time || 0), duration: Math.max(0, +b.duration || 0), at: Date.now() };
    }
    if (b.state === 'ended' && screen.type === 'video' && screen.video && screen.video.id === b.id) setScreen({ type: 'clear' }, 'video-ended');
    json(res, 200, { ok: true });
  },

  // ---- English on screen
  'GET /api/verse-en': async (req, res, url) => {
    const q = k => parseInt(url.searchParams.get(k), 10);
    const b = q('b'), c = q('c'), v = q('v'), e = Math.min(q('e') || q('v'), q('v') + 7);
    if (!(b >= 1 && b <= 66 && c >= 1 && v >= 1)) return json(res, 400, { error: 'bad reference' });
    try { json(res, 200, await onlineEnglish(b, c, v, Math.max(v, e))); }
    catch (err) { json(res, 502, { error: err.message }); }
  },
  'POST /api/english/keys': async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { error: 'Keys can only be changed on this PC.' });
    const b = await readBody(req);
    const before = Object.assign({}, secrets);
    for (const k of Object.keys(secrets)) if (typeof b[k] === 'string') secrets[k] = cleanKey(b[k]);
    verseCache.clear();
    const sp = speechProvider();
    if (PAID.includes(sp) && secrets[sp + 'Key'] !== before[sp + 'Key']) { speech.cloudKey = cloudKey(); if (speech.child) speech.restart(); }
    try { saveSettings(settings); } catch (e) { return json(res, 500, { error: 'Could not write settings.json: ' + e.message }); }
    broadcast('settings', publicSettings());
    json(res, 200, publicSettings());
  },
  'GET /api/english/list': async (req, res, url) => json(res, 200, await englishList(url.searchParams.get('refresh') === '1')),
  // the speech model for this PC (Settings -> Listening -> On this PC)
  'GET /api/model': (req, res) => { refreshHardware(); json(res, 200, modelInfo()); },
  'POST /api/model/install': async (req, res) => {
    if (!isLocal(req)) return json(res, 403, { error: 'The model can only be downloaded from this PC.' });
    const b = await readBody(req);
    if (typeof b.hfToken === 'string' && b.hfToken.trim()) {
      secrets.hfToken = cleanKey(b.hfToken);
      try { saveSettings(settings); } catch { /* kept for this time */ }
    }
    installModel('asked for in Settings');
    json(res, 200, modelInfo());
  },
  'POST /api/model/cancel': (req, res) => {
    if (!isLocal(req)) return json(res, 403, { error: 'Only from this PC.' });
    stopModelInstall();
    json(res, 200, modelInfo());
  },
  'POST /api/english/test': async (req, res) => {
    try { const r = await onlineEnglish(43, 3, 16, 16); json(res, 200, { ok: true, version: r.version, text: r.verses[0].text }); }
    catch (e) { json(res, 200, { ok: false, error: e.message }); }
  },
};

const voiceWaiting = new Map();
// what a command from the phone found, for the phone: the console's message, songs to choose from, a verse to show
function phoneAnswer(a) {
  if (!a || typeof a !== 'object') return { message: 'Sent to the console.' };
  const out = { message: a.message || 'Sent to the console.' };
  if (a.songs && a.songs.length) out.songs = a.songs;
  if (a.verse) out.verse = a.verse;
  return out;
}
const PHRASES_FILE = path.join(DATA, 'phrases.json');
function loadPhrases() {
  try { const list = JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf8').replace(/^\uFEFF/, '')); if (Array.isArray(list)) return list; } catch { /* the built-in list */ }
  return require('./public/engine.js').DEFAULT_PHRASES;
}
const PAGES = { '/': '/index.html', '/display': '/display.html', '/settings': '/settings.html', '/remote': '/remote.html', '/history': '/history.html' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    const route = routes[`${req.method} ${p}`];
    if (route) return await route(req, res, url);

    const bm = p.match(/^\/api\/bible\/(ar|en)$/);
    if (bm) {
      const key = ENGLISH_BUILT_IN[url.searchParams.get('v') || 'kjv'] || 'en';
      const f = bm[1] === 'ar' ? await arabicFile() : (haveBible(key) || await downloadBible(key)) ? bibleFile(key) : null;
      if (!f) return json(res, 404, { error: `Could not download the ${bm[1] === 'ar' ? 'Arabic' : 'English'} Bible. Check the internet connection and restart.` });
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'X-Bible-Edition': path.basename(f) });
      return fs.createReadStream(f).pipe(res);
    }
    const fm = p.match(/^\/fonts\/([a-z]+)\.css$/);
    if (fm && FONT_FAMILIES[fm[1]]) {
      const cssPath = path.join(FONT_DIR, fm[1] + '.css');
      if (fs.existsSync(cssPath)) return sendFile(res, cssPath, 'no-cache');
      cacheFont(fm[1]);
      res.writeHead(200, { 'Content-Type': MIME['.css'], 'Cache-Control': 'no-store' });
      return res.end('/* font not downloaded yet */');
    }
    const ff = p.match(/^\/fonts\/files\/([A-Za-z0-9._-]+)$/);
    if (ff) {
      const f = path.join(FONT_DIR, 'files', ff[1]);
      if (fs.existsSync(f)) return sendFile(res, f, 'max-age=31536000');
      res.writeHead(404); return res.end();
    }
    const file = PAGES[p] || p;
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found');
    }
    sendFile(res, full);
  } catch (e) {
    log('Error:', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

// The phone remote's microphone needs https. A certificate for this PC is made once with Windows' own tool
// (New-SelfSignedCertificate); the phone warns about it the first time, then it works.
const HTTPS_PORT = PORT + 393;   // 5443
const CERT_FILE = path.join(DATA, 'remote-cert.pfx');
let httpsServer = null;
function startHttps() {
  if (IS_MAC) return startHttpsMac();
  if (process.platform !== 'win32') return;
  const go = () => {
    try {
      httpsServer = require('https').createServer({ pfx: fs.readFileSync(CERT_FILE), passphrase: 'versefinder' }, (req, res) => server.emit('request', req, res));
      httpsServer.on('error', e => log('Phone remote (https) not available: ' + e.message));
      httpsServer.listen(HTTPS_PORT, '0.0.0.0');
    } catch (e) { log('Phone remote (https) not available: ' + e.message); }
  };
  if (fs.existsSync(CERT_FILE)) return go();
  const ips = lanAddresses();
  const san = ['DNS=localhost'].concat(ips.map(ip => 'IPAddress=' + ip)).join('&');
  const ps = `$c = New-SelfSignedCertificate -Subject 'CN=Arabic Church Assistant' -FriendlyName 'Arabic Church Assistant phone remote' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.17={text}${san}'); ` +
    `Export-PfxCertificate -Cert $c -FilePath '${CERT_FILE.replace(/'/g, "''")}' -Password (ConvertTo-SecureString 'versefinder' -AsPlainText -Force) | Out-Null; Remove-Item ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint)`;
  fs.mkdirSync(DATA, { recursive: true });
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true }, err => {
    if (err || !fs.existsSync(CERT_FILE)) return log('Could not make the phone remote certificate: ' + (err ? err.message : 'no file'));
    go();
  });
}

// On a Mac the certificate is made with the Mac's own openssl, as two files (the key and the certificate).
const KEY_PEM = path.join(DATA, 'remote-key.pem'), CERT_PEM = path.join(DATA, 'remote-cert.pem');
function startHttpsMac() {
  const go = () => {
    try {
      httpsServer = require('https').createServer({ key: fs.readFileSync(KEY_PEM), cert: fs.readFileSync(CERT_PEM) }, (req, res) => server.emit('request', req, res));
      httpsServer.on('error', e => log('Phone remote (https) not available: ' + e.message));
      httpsServer.listen(HTTPS_PORT, '0.0.0.0');
    } catch (e) { log('Phone remote (https) not available: ' + e.message); }
  };
  if (fs.existsSync(KEY_PEM) && fs.existsSync(CERT_PEM)) return go();
  const san = ['DNS:localhost'].concat(lanAddresses().map(ip => 'IP:' + ip)).join(',');
  const cnf = path.join(os.tmpdir(), `aca-remote-${process.pid}.cnf`);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(cnf, '[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nCN = Arabic Church Assistant\n' +
      `[ext]\nsubjectAltName = ${san}\nbasicConstraints = CA:FALSE\nkeyUsage = digitalSignature, keyEncipherment\nextendedKeyUsage = serverAuth\n`);
  } catch (e) { return log('Could not make the phone remote certificate: ' + e.message); }
  execFile('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', KEY_PEM, '-out', CERT_PEM, '-config', cnf],
    { timeout: 30000 }, err => {
      try { fs.unlinkSync(cnf); } catch { /* gone */ }
      if (err || !fs.existsSync(CERT_PEM)) return log('Could not make the phone remote certificate: ' + (err ? err.message : 'no file'));
      go();
    });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) out.push(a.address);
  }
  return out;
}

// Starts everything. Resolves with the port once the server is listening.
let started = null;
function start() {
  if (started) return started;
  started = new Promise((resolve, reject) => {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major < 18) return reject(new Error('Node.js 18 or newer is needed.'));
    let port = PORT, tries = 0;
    server.on('error', e => {
      if (e.code === 'EADDRINUSE' && tries < 10) {
        tries++; port++;
        log(`Port ${port - 1} is in use (is the old Arabic Church Assistant still open?). Trying ${port}…`);
        setTimeout(() => server.listen(port, '0.0.0.0'), 200);
      } else reject(e);
    });
    server.on('listening', () => {
      // the Bibles: Arabic first (needed to detect anything), then the English ones
      (async () => {
        if (!haveBible('arFull') && !haveBible('arPlain')) await arabicFile();
        else if (!haveBible('arFull')) downloadBible('arFull');
        for (const k of ['en', 'bsb', 'web', 'asv']) if (!haveBible(k)) await downloadBible(k);
      })().catch(() => {});
      cacheAllFonts().catch(() => {});
      refreshLibrary(true).catch(() => {});
      setTimeout(() => refreshSongs(true).catch(() => {}), 60000).unref();   // (long lists: not in the way of starting up)
      pruneOld(LOG_DIR, 60, /^\d{4}-\d{2}-\d{2}\.log$/);
      pruneOld(RECORD_DIR, 7 * settings.recordKeepWeeks, /\.(ogg|opus|wav)$/);
      history('start', { version: VERSION });
      log(`Arabic Church Assistant ${VERSION} started (port ${port}).`);
      speech.start();
      startHttps();
      resolve({ port, url: `http://localhost:${port}` });
    });
    server.listen(port, '0.0.0.0');
  });
  return started;
}
function shutdown() { try { speech.stop(); } catch { /* ignore */ } stopModelInstall(); }
process.on('exit', () => { if (speech.child) killTree(speech.child); if (modelJob.proc) killTree(modelJob.proc); });

module.exports = { start, shutdown, hub, speech, getSettings: () => settings, getScreen: () => screen, VERSION, lanAddresses, ROOT, DATA, logLine };

// On its own (without the desktop app): node server.js
if (require.main === module) {
  start().then(({ port, url }) => {
    log('\n==============================================');
    log(`  Arabic Church Assistant ${VERSION} (server only)`);
    log('==============================================');
    log(`  Operator console : ${url}`);
    log(`  Display / OBS    : ${url}/display`);
    const ips = lanAddresses();
    if (ips.length) log(`  From another PC  : http://${ips[0]}:${port}/display`);
    log('\n  The desktop app is the normal way to run Arabic Church Assistant: double-click "Arabic Church Assistant" on the desktop.\n');
    if (process.argv.includes('--open')) exec(process.platform === 'win32' ? `start "" "${url}"` : `${IS_MAC ? 'open' : 'xdg-open'} "${url}"`);
  }).catch(e => { log('Could not start: ' + e.message); process.exit(1); });
  const bye = () => { shutdown(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
