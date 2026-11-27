// Run: node test/english.test.js — API.Bible a chapter at a time, kept on this PC (server.js, the part between "API.Bible a
// chapter at a time" and "API.Bible (end)"), with a stand-in for API.Bible that has the KJV's words. No internet needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const block = src.slice(src.indexOf('// ---- API.Bible a chapter at a time'), src.indexOf('// ---- API.Bible (end)'));
const USFM = JSON.parse(src.match(/const USFM = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'en_kjv.json'), 'utf8');
const kjv = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
let pass = 0, fail = 0;
const ok = (name, cond, more) => { if (cond) pass++; else { fail++; console.log('FAIL', name, more || ''); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

const asked = [], reports = [];
async function standIn(url) {
  const m = /\/chapters\/(\w+)\.(\d+)\?/.exec(url);
  if (m) {
    asked.push(m[1] + '.' + m[2]);
    const ch = kjv[USFM.indexOf(m[1])] && kjv[USFM.indexOf(m[1])].chapters[+m[2] - 1];
    if (!ch) return { ok: false, status: 404, json: async () => ({}) };
    // (the NIV leaves Matthew 17:21 out: the stand-in does too)
    const content = '     ' + ch.map((t, i) => (m[1] === 'MAT' && m[2] === '17' && i === 20 ? '' : `[${i + 1}] ${t}`)).join('  ');
    return { ok: true, status: 200, json: async () => ({ data: { content }, meta: { fumsToken: 'tok-' + m[1] + '.' + m[2] } }) };
  }
  if (url.includes('/f3?')) { reports.push(new URL(url).searchParams); return { ok: true, status: 200 }; }
  return { ok: false, status: 404, json: async () => ({}) };
}
// a fresh copy of that part of server.js, with its own data folder and stand-ins for what it uses from the rest
function load(data) {
  const settings = { englishVersion: 'apibible', apiBibleId: 'niv-test', apiBibleAbbr: 'NIV' };
  const bible = { chapterCount: b => kjv[b - 1].chapters.length };
  const fast = (fn) => setTimeout(fn, 20);          // (the 2 s and 3 s waits of the app, made short)
  const make = new Function('fs', 'path', 'crypto', 'DATA', 'settings', 'bibleKey', 'remoteBible', 'APIBIBLE_BASE', 'USFM', 'fetchWithTimeout', 'process', 'setTimeout',
    block + '\nreturn { apiBibleVerses, abRead, abChapters, fumsReport, fums };');
  return make(fs, path, crypto, data, settings, () => 'test-key', () => ({ bible }), 'http://api.test', USFM, (url) => standIn(url), { env: { FUMS_BASE: 'http://fums.test' } }, fast);
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-en-'));
  const a = load(data);
  let r = await a.apiBibleVerses(45, 8, 1, 1);
  ok('the first verse of a chapter: the whole chapter in one request', r.verses[0].n === 1 && /no condemnation/.test(r.verses[0].text) && r.version === 'NIV' && r.fumsToken === 'tok-ROM.8' && asked.length === 1, JSON.stringify(asked));
  r = await a.apiBibleVerses(45, 8, 28, 29);
  ok('… then any verse of it at once, nothing fetched', r.verses.length === 2 && /work together for good/.test(r.verses[0].text) && asked.length === 1);
  await a.apiBibleVerses(45, 8, 38, 39);
  await wait(30);
  ok('near the end of a chapter the next one is fetched before it is needed', asked.includes('ROM.9'), JSON.stringify(asked));
  let err = '';
  try { await a.apiBibleVerses(40, 17, 21, 21); } catch (e) { err = e.message; }
  ok('a verse the translation leaves out says so', /The NIV does not have this verse/.test(err), err);
  await wait(60);
  const file = path.join(data, 'english-cache.json');
  ok('the chapters are kept in data\\english-cache.json with their token', fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).chapters['niv-test:45.8'].f === 'tok-ROM.8');
  const b = load(data); b.abRead();
  asked.length = 0;
  r = await b.apiBibleVerses(45, 8, 14, 14);
  ok('kept chapters are at hand again after a restart', /led by the Spirit/.test(r.verses[0].text) && asked.length === 0, JSON.stringify(asked));
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.chapters['niv-test:45.8'].at = Date.now() - 29 * 24 * 3600 * 1000;
  fs.writeFileSync(file, JSON.stringify(old));
  const c = load(data); c.abRead();
  await c.apiBibleVerses(45, 8, 14, 14);
  ok('… but fetched again once 28 days old (API.Bible: refreshed within 30)', asked.includes('ROM.8'), JSON.stringify(asked));
  const d = load(fs.mkdtempSync(path.join(os.tmpdir(), 'aca-en-')));
  for (let ch = 1; ch <= 20; ch++) await d.apiBibleVerses(1, ch, 1, 1);
  const kept = [...d.abChapters.keys()].filter(k => k.startsWith('niv-test:1.')).map(k => +k.split('.')[1]).sort((x, y) => x - y);
  let longest = 0, run = 0, prev = -1;
  for (const ch of kept) { const n = kjv[0].chapters[ch - 1].length; run = ch === prev + 1 ? run + n : n; prev = ch; longest = Math.max(longest, run); }
  ok(`never more than 450 verses in a row (Genesis 1–20 asked for: ${kept[0]}–${kept[kept.length - 1]} kept, ${longest} verses)`, longest <= 450 && kept.includes(20));
  // a whole translation kept on this PC (data\english\<bible id>.json, downloaded with the publisher's permission)
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-en-'));
  fs.mkdirSync(path.join(full, 'english'));
  const chap = (b, c, skip) => ({ f: `tok-${USFM[b - 1]}.${c}`, verses: kjv[b - 1].chapters[c - 1].map((t, i) => [i + 1, t]).filter(x => x[0] !== skip) });
  fs.writeFileSync(path.join(full, 'english', 'niv-test.json'), JSON.stringify({ v: 1, version: 'NIV', id: 'niv-test', complete: true, chapters: { '45.8': chap(45, 8), '40.17': chap(40, 17, 21) } }));
  const e = load(full);
  asked.length = 0;
  r = await e.apiBibleVerses(45, 8, 28, 28);
  ok('a translation kept on this PC: every verse from it, nothing fetched', /work together for good/.test(r.verses[0].text) && r.fumsToken === 'tok-ROM.8' && asked.length === 0, JSON.stringify(asked));
  err = '';
  try { await e.apiBibleVerses(40, 17, 21, 21); } catch (x) { err = x.message; }
  ok('… a verse it leaves out says so', /does not have this verse/.test(err) && asked.length === 0, err);
  d.fumsReport('tok-A'); d.fumsReport('tok-B');
  await wait(60);
  const rep = reports[reports.length - 1];
  ok('views are reported to API.Bible together, with an anonymous id for this PC and one for this run',
    rep && rep.getAll('t').join() === 'tok-A,tok-B' && /^[\w-]{8,}$/.test(rep.get('dId') || '') && /^[\w-]{8,}$/.test(rep.get('sId') || ''));
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL unexpected:', e.stack); process.exit(1); });
