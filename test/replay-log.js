// Goes through a service again from its log: every sentence and the words as they arrived (data\logs\<day>.log) are
// given to the screen rules as they are now, at the same times, and what they would put on the screen is listed beside
// what the app did put on the screen then. For finding out why a verse was missed, late or wrong, and for checking
// that a change to the rules mends it.
//
//   node test/replay-log.js                         today
//   node test/replay-log.js 2026-11-17              that day
//   node test/replay-log.js 2026-11-17 17:04 17:08  only between those times (HH:MM or HH:MM:SS)
//   … --words                                       also print the words as they arrived
//   … --data <folder>                               another data folder (default: data, or VF_DATA_DIR)
//
// The operator's own clicks (cards, arrows, Back, Hold) are replayed as they happened. A day from before version 3.3
// has no sentences in its log: then the finished sentences of data\history are used (no words as they arrived, so
// the timing is rougher). The sound of a line is in data\recordings: the log says which file and how far into it.
const fs = require('fs');
const path = require('path');
const VE = require('../public/engine.js');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = n => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const WORDS = flag('--words');
const DATA = opt('--data') || process.env.VF_DATA_DIR || path.join(__dirname, '..', 'data');
const p2 = n => String(n).padStart(2, '0');
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
const day = args[0] || today;
const clock = s => { if (!s) return null; const [h, m, x] = s.split(':').map(Number); return h * 3600 + (m || 0) * 60 + (x || 0); };
const FROM = clock(args[1]), TO = clock(args[2]);
const load = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8').replace(/^﻿/, ''));
const stamp = t => { const s = Math.floor(t), ms = Math.round((t - s) * 10); return `${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}.${Math.min(9, ms)}`; };
const BY_ITSELF = /^(auto-|spoken-|read-|end-of-verse|reading-stopped|chapter-opening)/;

// ---- what happened: the log's lines, or the history's finished sentences for an older day
const events = [];        // { t (seconds since midnight), kind: words | heard | screen | hold, … }
const logFile = path.join(DATA, 'logs', day + '.log');
if (fs.existsSync(logFile)) {
  for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
    const m = /^(\d\d):(\d\d):(\d\d)\.(\d{3})  (\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const t = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, src = m[5], msg = m[6];
    if (src === 'words' || src === 'heard') {
      const x = /^#(\S+) (.*?)(?:  \[([^\]]*)\])?$/.exec(msg);
      if (!x) continue;
      events.push({ t, kind: src, seg: /^\d+$/.test(x[1]) ? +x[1] : null, text: x[2], late: /; late$/.test(x[3] || ''), note: x[3] || '' });
    } else if (src === 'screen') {
      const h = /^Hold (on|off)/.exec(msg);
      if (h) { events.push({ t, kind: 'hold', on: h[1] === 'on' }); continue; }
      const x = /^(.*?)(?:  \(([^)]*)\))?$/.exec(msg);
      events.push({ t, kind: 'screen', what: x[1], why: x[2] || '' });
    }
  }
}
if (!events.some(e => e.kind === 'heard')) {
  const hist = path.join(DATA, 'history', day + '.jsonl');
  if (fs.existsSync(hist)) {
    for (const r of fs.readFileSync(hist, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))) {
      if (r.type !== 'heard') continue;
      const d = new Date(r.t);
      events.push({ t: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000, kind: 'heard', seg: null, text: r.text, late: !!r.late, note: 'from the history: no words as they arrived' });
    }
    events.sort((a, b) => a.t - b.t);
  }
}
const run = events.filter(e => (FROM == null || e.t >= FROM) && (TO == null || e.t <= TO));
if (!run.some(e => e.kind === 'heard' || e.kind === 'words')) { console.log(`Nothing was heard on ${day}${FROM != null ? ' between those times' : ''} (looked in ${DATA}).`); process.exit(0); }

(async () => {
  const arName = ['ar_vandyke.json', 'ar_svd.json'].find(f => fs.existsSync(path.join(DATA, f)));
  if (!arName) { console.log('The Arabic Bible is not in ' + DATA + ' (open Arabic Church Assistant once: it downloads it).'); process.exit(1); }
  const bible = new VE.Bible(load(arName));
  const qi = new VE.QuoteIndex(); await qi.build(bible, 1e9);
  const fi = new VE.FuzzyQuoteIndex(); await fi.build(bible, 1e9);
  const enBibles = ['en_kjv', 'en_bsb', 'en_web', 'en_asv'].filter(f => fs.existsSync(path.join(DATA, f + '.json'))).map(f => new VE.Bible(load(f + '.json')));
  const qe = new VE.QuoteIndex({ tokenize: VE.enTokens });
  for (const b of enBibles) await qe.addBible(b);
  qe.finalize(); qe.ready = true;
  // the settings that decide what goes up by itself, as they are now (settings.json beside the data folder, or in it)
  let saved = {};
  for (const f of [path.join(DATA, '..', 'settings.json'), path.join(DATA, 'settings.json')]) { try { saved = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch { /* the next one */ } }
  const settings = { autoShow: true, autoShowQuotes: true, quoteLive: true, catchQuotes: true, navFollow: true, readAlong: true, readEnd: true, readLead: 1, cardOnly: [] };
  for (const k of Object.keys(settings)) if (k in saved) settings[k] = saved[k];
  const det = new VE.Detector(bible, { quotes: settings.catchQuotes });
  det.setQuoteIndex(qi); det.setFuzzyQuoteIndex(fi); det.setEnglishQuoteIndex(qe);
  try { const ph = JSON.parse(fs.readFileSync(path.join(DATA, 'phrases.json'), 'utf8')); if (Array.isArray(ph.phrases || ph)) det.setPhrases(ph.phrases || ph); } catch { /* the built-in set prayers */ }
  let now = 0, mine = false;
  const out = [];
  const d = new VE.Director(bible, det, { settings: () => settings, now: () => now * 1000, english: () => enBibles,
    card: (c, info) => { if (!info.auto) out.push({ t: now, text: `      NOW   card  ${c.labelEn}${c.probable ? ' (not sure)' : ''}  (${c.source})` }); },
    show: (r, why) => { if (!mine) out.push({ t: now, text: `      NOW   ${VE.refLabel(r, { lang: 'en' })}  (${why})` }); } });
  let last = run[0].t;
  for (const e of run) {
    for (let t = Math.ceil(last + 0.001); t < e.t; t++) { now = t; d.tick(); }           // (the console looks once a second)
    now = e.t; last = e.t;
    if (e.kind === 'words') { if (WORDS) out.push({ t: now, text: `   …  ${e.text}` }); d.interim(e.text, e.seg); }
    else if (e.kind === 'heard') { out.push({ t: now, text: `heard: ${e.text}${e.note ? `   [${e.note}]` : ''}` }); d.final(e.text, e.late, e.seg); }
    else if (e.kind === 'hold') { d.hold = e.on; out.push({ t: now, text: `      (Hold ${e.on ? 'on' : 'off'})` }); }
    else if (BY_ITSELF.test(e.why)) out.push({ t: now, text: `      THEN  ${e.what}  (${e.why})` });
    else {
      // the operator (or a video ending): it happened, so it happens here too
      out.push({ t: now, text: `      (${e.why || 'operator'}: ${e.what})` });
      const ref = /^(cleared|video:|message:)/.test(e.what) ? null : VE.parseQuery(e.what, bible);
      // (a verse the operator put up from the console goes through the rules' own show(), as in the app: that is what
      //  ends "the screen moved on at the end of a verse" when he steps back with the arrows)
      if (ref && e.why !== 'back') { mine = true; d.show(ref, e.why || 'operator'); mine = false; }
      else if (ref) d.onScreen('show', ref, true);
      else d.onScreen(e.what.startsWith('video:') ? 'video' : e.what.startsWith('message:') ? 'message' : 'clear');
    }
  }
  for (let t = Math.ceil(last + 0.001); t < last + 12; t++) { now = t; d.tick(); }
  out.sort((a, b) => a.t - b.t);
  console.log(`Arabic Church Assistant ${VE.version}: the service of ${day} through the screen rules as they are now.`);
  console.log('THEN = what the app put on the screen by itself that day; NOW = what it would put up today.\n');
  for (const o of out) console.log(`${stamp(o.t)}  ${o.text}`);
  const count = k => out.filter(o => o.text.includes(k) && !o.text.includes('card  ')).length;
  console.log(`\n${count('THEN')} changes then, ${count('NOW')} now.`);
})();
