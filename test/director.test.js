// Run: node test/director.test.js
// The rules for what goes on the screen by itself (VE.Director in public/engine.js, the same code the console runs):
// auto-show, following a reading, set prayers, guessed book names, Hold and Back.
// Uses the real Bible in data\ and a clock of its own, and replays what the speech engines wrote for two sermon clips
// (test/fixtures: each sentence, and the words as they arrived, with their time in the recording).
const fs = require('fs');
const path = require('path');
const VE = require('../public/engine.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`FAIL ${name}\n   got:  ${g}\n   want: ${w}`); }
}
const arPath = path.join(__dirname, '..', 'data', 'ar_vandyke.json');
if (!fs.existsSync(arPath)) { console.log('FAIL: data/ar_vandyke.json is not there (open Arabic Church Assistant once: it downloads the Bible)'); process.exit(1); }
const bible = new VE.Bible(JSON.parse(fs.readFileSync(arPath, 'utf8').replace(/^﻿/, '')));
const verse = (b, c, v) => VE.stripTashkeel(bible.verse(b, c, v));
const JOHN = 43, ROMANS = 45, PSALMS = 19, MATTHEW = 40;

(async () => {
  const qi = new VE.QuoteIndex(); await qi.build(bible, 1e9);
  const fi = new VE.FuzzyQuoteIndex(); await fi.build(bible, 1e9);
  // the English translations on this PC (a reading in English is followed with them)
  const enBibles = ['en_kjv', 'en_bsb', 'en_web', 'en_asv'].map(f => path.join(__dirname, '..', 'data', f + '.json')).filter(f => fs.existsSync(f))
    .map(f => new VE.Bible(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))));
  const qe = new VE.QuoteIndex({ tokenize: VE.enTokens });
  for (const b of enBibles) await qe.addBible(b);
  qe.finalize(); qe.ready = true;
  const english = (b, c, v) => enBibles[enBibles.length - 1].verse(b, c, v);

  // a console without a screen: what the rules would show, and the cards they would list
  function desk(over) {
    const settings = Object.assign({ autoShow: true, autoShowQuotes: true, catchQuotes: true, navFollow: true, readAlong: true, readEnd: true, readLead: 0, cardOnly: [] }, over);
    const det = new VE.Detector(bible, { quotes: settings.catchQuotes });
    det.setQuoteIndex(qi); det.setFuzzyQuoteIndex(fi); det.setEnglishQuoteIndex(qe);
    const k = { t: 1000, shows: [], cards: [], settings };
    k.d = new VE.Director(bible, det, { settings: () => k.settings, now: () => k.t * 1000, english: () => enBibles,
      card: (c, info) => k.cards.push({ label: c.labelEn + (c.probable ? '?' : ''), source: c.source, auto: !!info.auto }),
      show: (r, why) => k.shows.push({ label: VE.refLabel(r, { lang: 'en' }), why, t: k.t, ref: r }) });
    k.go = to => { for (let t = Math.floor(k.t) + 1; t <= to; t++) { k.t = t; k.d.tick(); } k.t = to; };     // time passes (the console looks once a second)
    k.wait = s => k.go(k.t + s);
    k.say = (text, after) => { k.go(k.t + (after == null ? 6 : after)); return k.d.final(text); };       // a finished sentence
    k.hear = (text, after) => { k.go(k.t + (after == null ? 0.4 : after)); k.d.interim(text); };          // words still being said
    k.read = (text, each) => { const w = text.split(' '); for (let i = 1; i <= w.length; i++) k.hear(w.slice(0, i).join(' '), each); };   // … word by word
    k.labels = () => k.shows.map(s => s.label);
    k.last = () => k.shows[k.shows.length - 1] || {};
    k.covered = (book, chapter) => { const out = new Set(); for (const s of k.shows) if (s.ref.book === book && s.ref.chapter === chapter) for (let v = s.ref.verse; v <= (s.ref.verseEnd || s.ref.verse); v++) out.add(v); return [...out].sort((a, b) => a - b); };
    return k;
  }
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  // ---- a passage read verse by verse: every verse goes up, in order
  {
    const k = desk();
    k.say('افتحوا معايا انجيل يوحنا الاصحاح الرابع عدد 3');
    eq('the announced verse goes up', [k.last().label, k.last().why], ['John 4:3', 'auto-reference']);
    for (let v = 4; v <= 12; v++) k.say(verse(JOHN, 4, v));
    eq('reading on, a sentence a verse: none is skipped', k.covered(JOHN, 4), range(3, 12));
    eq('… and nothing else goes up', k.shows.every(s => s.ref.book === JOHN && s.ref.chapter === 4), true);
  }
  // ---- a hymn named by a verse's words («ترنيمة باركي يا نفسي الرب», 26 Nov: "it brought the psalm — but I said hymn"):
  //      the console found the hymn, so those words make no verse card; nor does a verse go up while they are being said
  {
    const words = VE.stripTashkeel(bible.verse(PSALMS, 103, 2)).replace(/[،.]/g, '');
    const alone = desk();
    alone.say(words);
    const named = desk();
    named.go(named.t + 6); named.d.final('ترنيمة ' + words, false, null, { hymn: true });
    const live = desk();
    live.read('ترنيمة ' + words, 0.4);
    eq('a hymn named by a verse\'s words: no card for the verse (the words alone: Psalm 103:2), nothing on the screen',
      [alone.cards.some(c => c.label === 'Psalms 103:2'), named.cards.length, named.shows.length, live.shows.length], [true, 0, 0, 0]);
  }
  // ---- one sentence that runs from a verse into the next: both are up
  {
    const k = desk();
    k.d.show({ book: JOHN, chapter: 4, verse: 5 }, 'card');
    k.say(verse(JOHN, 4, 6) + ' ' + verse(JOHN, 4, 7).split(' ').slice(0, 7).join(' '));
    eq('a sentence over two verses shows both', k.last().label, 'John 4:6-7');
    k.say(verse(JOHN, 4, 7).split(' ').slice(7).join(' ') + ' ' + verse(JOHN, 4, 8));
    eq('… and the reading carries on from there', k.covered(JOHN, 4).includes(8), true);
  }
  // ---- the reader is two verses on (the one between was not caught): it goes up with the one that was skipped
  {
    const k = desk();
    k.d.show({ book: JOHN, chapter: 4, verse: 3 }, 'card');
    k.say(verse(JOHN, 4, 5));
    eq('a quote two verses on shows the skipped verse too', [k.last().label, k.last().why], ['John 4:4-5', 'auto-quote+']);
    const far = desk();
    far.d.show({ book: JOHN, chapter: 4, verse: 3 }, 'card');
    far.say(verse(JOHN, 4, 5), 300);
    eq('… but not when the verse on screen has been up for minutes', far.last().label, 'John 4:5');
  }
  // ---- in a reading the screen moves on as each verse ends, and goes back if the reader stops there
  {
    const k = desk();
    k.d.show({ book: JOHN, chapter: 4, verse: 7 }, 'card');
    k.say(verse(JOHN, 4, 8));                                    // 7 -> 8: two in a row, a reading
    k.read(verse(JOHN, 4, 9));
    const at9 = k.shows.find(s => s.label === 'John 4:9'), at10 = k.shows.find(s => s.label === 'John 4:10');
    eq('the next verse is followed from the words as they arrive', !!at9 && at9.why, 'read-along');
    eq('at the last words of the verse on screen, the next one goes up', !!at10 && at10.why, 'end-of-verse');
    k.read(verse(JOHN, 4, 10));                                  // he reads it: it stays, and 11 goes up at its end
    eq('he reads on: it stays, and the one after goes up at its end', [k.shows.some(s => s.why === 'reading-stopped'), k.last().label, k.last().why], [false, 'John 4:11', 'end-of-verse']);
    k.say(verse(JOHN, 4, 10), 1);                                // (the finished sentence of verse 10 arrives)
    k.say('وهنا بقى يا جماعه عايز اقول لكم حاجه مهمه جدا عن الموضوع ده النهارده', 10);
    eq('he stops reading there: back to the verse he ended on', [k.last().label, k.last().why], ['John 4:10', 'reading-stopped']);
    const off = desk({ readEnd: false });
    off.d.show({ book: JOHN, chapter: 4, verse: 7 }, 'card');
    off.say(verse(JOHN, 4, 8));
    off.read(verse(JOHN, 4, 9));
    eq('with "move on as each verse ends" off, it waits for the next verse to begin', off.shows.some(s => s.why === 'end-of-verse'), false);
  }
  // ---- an announced passage ends where it was said to end
  {
    const k = desk();
    k.say('انجيل يوحنا الاصحاح 4 من عدد 3 الى عدد 6');
    eq('a long passage goes up a verse at a time', k.last().label, 'John 4:3');
    for (const v of [4, 5, 6]) k.read(verse(JOHN, 4, v));
    eq('… and the screen does not run on past its last verse', [k.covered(JOHN, 4), k.shows.some(s => s.label === 'John 4:7')], [[3, 4, 5, 6], false]);
  }
  // ---- a chapter announced without a verse, then its opening words
  {
    const k = desk();
    k.say('وعلشان كده بيقول في مزمور 46');
    eq('a chapter alone is a card, not a screen', [k.shows.length, k.cards.map(c => c.label)], [0, ['Psalms 46']]);
    k.say('الله لنا ملجا وقوه عونا في الضيقات وجد شديدا');
    eq('its opening words put the verse up', [k.last().label, k.last().why], ['Psalms 46:1', 'chapter-opening']);
    const late = desk();
    late.say('وعلشان كده بيقول في مزمور 46');
    late.say('ونعمة ربنا تكون معاكم كلكم النهارده يا احبائي في المسيح', 90);
    eq('… only for a minute, and only for its own words', late.shows.length, 0);
  }
  // ---- guesses: a card to check, never the screen
  {
    const k = desk();
    k.say('في الصومين الاول اصحاح ثلاثه وعدد واحد');
    eq('a book name that was only guessed never goes up by itself', [k.shows.length, k.cards.map(c => c.label)], [0, ['1 Samuel 3:1?']]);
    k.say(verse(9, 3, 1));
    eq('… but the verse itself, quoted, does', k.last().label, '1 Samuel 3:1');
  }
  // ---- set prayers
  {
    const k = desk();
    k.d.show({ book: JOHN, chapter: 4, verse: 3 }, 'card');
    k.say('وعدد ثلاثه باسم الاب والابن اروح القدس الاله الواحد امين');
    eq('the Trinitarian formula (misheard) changes nothing', [k.last().label, k.cards.length], ['John 4:3', 0]);
    k.say('نصلي مع بعض ابانا الذي في السموات ليتقدس اسمك ليات ملكوتك');
    eq("the Lord's Prayer brings up its passage", [k.last().label, k.last().why], ['Matthew 6:9', 'auto-phrase']);
    const b = desk();
    b.say('نعمة ربنا يسوع المسيح ومحبة الله وشركة الروح القدس مع جميعكم امين');
    eq('the benediction is a card only', [b.shows.length, b.cards.map(c => c.label + ':' + c.source)], [0, ['2 Corinthians 13:14:phrase']]);
    const only = desk({ cardOnly: ['43:3:16'] });
    only.say(verse(JOHN, 3, 16));
    eq('"Card only" on a verse: quoted words never show it', [only.shows.length, only.cards.map(c => c.label)], [0, ['John 3:16']]);
    only.say('انجيل يوحنا الاصحاح الثالث عدد 16', 100);
    eq('… a spoken reference still does', only.last().label, 'John 3:16');
  }
  // ---- Hold, late sentences, Back
  {
    const k = desk();
    k.d.hold = true;
    k.say('رساله روميه الاصحاح 8 عدد 28');
    k.say(verse(JOHN, 3, 16));
    eq('Hold: verses are still listed, nothing goes up', [k.shows.length, k.cards.map(c => c.label)], [0, ['Romans 8:28', 'John 3:16']]);
    k.d.hold = false;
    k.say('رساله روميه الاصحاح 8 عدد 31', 100);
    eq('Hold off: it goes up again', k.last().label, 'Romans 8:31');

    const l = desk();
    l.d.final('رساله روميه الاصحاح 8 عدد 28', true);
    eq('a sentence that arrives late (the model was loading) is listed, not shown', [l.shows.length, l.cards.length], [0, 1]);

    const u = desk();
    u.d.show({ book: JOHN, chapter: 4, verse: 5 }, 'card');
    u.say(verse(JOHN, 4, 6));
    eq('(the reading moves the screen on)', u.last().label, 'John 4:6');
    u.d.onScreen('show', { book: JOHN, chapter: 4, verse: 5, verseEnd: null }, true);       // the operator pressed Back
    eq('Back: the rules carry on from the screen that came back', [u.d.current.verse, u.d.detector.context.chapter], [5, 4]);
    const n = u.shows.length;
    u.say(verse(JOHN, 4, 6), 20);
    eq('… and do not put the verse that was taken off straight back', u.shows.length, n);
    u.say(verse(JOHN, 4, 6), 120);
    eq('… until a minute has passed', u.last().label, 'John 4:6');
    const before = u.shows.length;
    u.d.onScreen('show', { book: JOHN, chapter: 4, verse: 6, verseEnd: null });              // our own show, coming back from the server
    eq('the echo of its own screen is not news', u.d.shows.length, before + 1);
    u.d.onScreen('show', { book: ROMANS, chapter: 8, verse: 28, verseEnd: null });           // another console or the phone
    eq('a screen from elsewhere is taken in', [u.d.current.book, u.d.detector.context.book], [ROMANS, ROMANS]);
  }

  // ---- real sermon clips, as the speech engines wrote them
  function replay(file, over, first) {
    const k = desk(over);
    if (first) first(k);
    for (const line of fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').split('\n').filter(Boolean)) {
      const it = JSON.parse(line);
      k.go(1000 + it.t);
      if (it.f) k.d.final(it.x, false, it.seg); else k.d.interim(it.x, it.seg);      // (seg: the engine's number for the sentence, in the newer fixtures)
    }
    return k;
  }
  const at = (k, label) => { const s = k.shows.find(x => x.label === label || x.label.startsWith(label + '-')); return s ? Math.round(s.t - 1000) : null; };
  {
    const k = replay('john4-elevenlabs.jsonl');                    // John 4:3-17 read aloud; ElevenLabs Live (words as they arrive)
    eq('John 4 reading (ElevenLabs): every verse from 3 to 17 goes up', k.covered(JOHN, 4).filter(v => v <= 17), range(3, 17));
    eq('… most of them as the verse before ends', k.shows.filter(s => s.why === 'end-of-verse').length >= 10, true);
    eq('… and nothing but John 4', k.shows.every(s => s.ref.book === JOHN && s.ref.chapter === 4), true);
    const s = replay('john4-local-sentences.jsonl');               // the same clip from the model on this PC, finished sentences only
    eq('John 4 reading (model on this PC, sentences only): every verse from 3 to 17', s.covered(JOHN, 4).filter(v => v <= 17), range(3, 17));
    const held = replay('john4-elevenlabs.jsonl', {});
    held.d.hold = true;
    eq('(a replay under Hold shows nothing)', replay('john4-elevenlabs.jsonl', { autoShow: false, autoShowQuotes: false, readAlong: false }).shows.length, 0);
  }
  for (const [file, name] of [['habakkuk-psalm46-local.jsonl', 'model on this PC'], ['habakkuk-psalm46-elevenlabs.jsonl', 'ElevenLabs']]) {
    const k = replay(file);        // «ارجع معايا لحبقوك 3 17» … «مزمور 46 الله لنا ملجأ»
    const hab = at(k, 'Habakkuk 3:17'), ps = at(k, 'Psalms 46:1');
    eq(`Habakkuk 3:17 as soon as it is announced (${name})`, hab != null && hab < 30, true);
    eq(`Psalm 46:1 from its opening words (${name})`, ps != null && ps < 125, true);
    eq(`… and no other book on the screen (${name})`, k.shows.every(s => [35, PSALMS].includes(s.ref.book)), true);
  }

  // =====================================================================================
  // Following a reading (version 3.3). What went wrong on 17 November: the first verse of an announced passage stayed up
  // while the second was read; the end of John 3:16 put John 3:15 up; a verse was left early on words two verses share.
  // =====================================================================================
  // ---- a passage announced with its end is followed from its first verse
  {
    const k = desk();
    k.say('انجيل يوحنا الاصحاح 3 من عدد 14 الى عدد 20');
    eq('a passage is announced: its first verse goes up', k.last().label, 'John 3:14');
    k.read(verse(JOHN, 3, 14));
    eq('the first verse is read to its end: the second goes up', [k.last().label, k.last().why], ['John 3:15', 'end-of-verse']);
    k.say(verse(JOHN, 3, 14), 1);
    k.wait(6);                                                     // (a long breath)
    eq('a pause inside an announced passage changes nothing', k.last().label, 'John 3:15');
    k.read(verse(JOHN, 3, 15));
    eq('… and so on, verse by verse', [k.last().label, k.last().why], ['John 3:16', 'end-of-verse']);
    k.say(verse(JOHN, 3, 15), 1);
    k.read(verse(JOHN, 3, 16).split(' ').slice(0, 13).join(' '));
    eq('verse 16 ends with the words of verse 15: they do not end it before it is read', k.last().label, 'John 3:16');
    k.read(verse(JOHN, 3, 16));
    eq('… its own ending does', [k.last().label, k.last().why], ['John 3:17', 'end-of-verse']);
    k.say(verse(JOHN, 3, 16), 1);
    for (const v of [17, 18, 19]) { k.read(verse(JOHN, 3, v)); k.say(verse(JOHN, 3, v), 1); }
    k.read(verse(JOHN, 3, 20));
    eq('the passage stops where it was said to', [k.covered(JOHN, 3), k.last().label], [range(14, 20), 'John 3:20']);
    eq('… and never went back or ahead on the way', k.shows.map(x => x.ref.verse), range(14, 20));
  }
  // ---- how much before the end of a verse the next one goes up (Settings: "readLead", seconds)
  {
    const w = verse(JOHN, 3, 14).split(' ');
    const at = lead => {
      const k = desk({ readLead: lead });
      k.say('انجيل يوحنا الاصحاح 3 من عدد 14 الى عدد 20');
      k.read(w.slice(0, w.length - 2).join(' '));
      const early = k.last().label;
      k.read(w.join(' ')); k.say(w.join(' '), 1);
      k.read(verse(JOHN, 3, 15).split(' ').slice(0, 6).join(' '));
      return [early, k.last().label, k.shows.some(x => x.why === 'reading-stopped')];
    };
    eq('lead 0: two words before the end the verse is still up; it goes at its last word', at(0), ['John 3:14', 'John 3:15', false]);
    eq('lead 1 s: the next verse is up two words before the end, and stays while the last words are read', at(1), ['John 3:15', 'John 3:15', false]);
    const k = desk({ readLead: 3 });
    k.say('انجيل يوحنا الاصحاح 3 من عدد 14 الى عدد 20');
    k.read(w.slice(0, 4).join(' '));
    eq('a long lead does not move on at the start of a verse', k.last().label, 'John 3:14');
  }
  // ---- a reference said again brings the verse back (17 Nov: "can you bring that back up? Matthew 28, 19" did nothing)
  {
    const k = desk();
    k.say('What is that? Matthew 28 19.');
    k.say('Matthew 28 19 says go and make disciples', 20);
    eq('said again while it is on the screen: nothing new', [k.labels(), k.cards.length], [['Matthew 28:19'], 1]);
    k.say('The next verse.', 10);
    eq('("the next verse" moves on)', k.last().label, 'Matthew 28:20');
    k.say('Can you bring that back up? Matthew 28, 19.', 30);
    eq('said again when another verse is up: it comes back', k.last().label, 'Matthew 28:19');
  }
  // ---- short quotes: five words of a verse, word for word, go up when hardly another verse has them
  //      (17 Nov: «الرب راعي فلا يعوزني شيء», «ارحمني يا الله حسب رحمتك» and "He leads me in green pastures" only made cards)
  {
    const k = desk();
    k.say('الرب راعي فلا يعوزني شيء');
    eq('five words that are a whole verse', [k.last().label, k.last().why], ['Psalms 23:1', 'auto-quote']);
    k.d.onScreen('clear');
    k.say('ارحمني يا الله حسب رحمتك', 20);
    eq('five words that open a verse', k.last().label, 'Psalms 51:1');
    if (enBibles.length) {
      k.d.onScreen('clear');
      k.say('He leads me in green pastures. He quiets my soul.', 15);
      eq('… in English', k.last().label, 'Psalms 23:2');
    }
    const n = k.shows.length;
    k.say('ويعبد ويشكر ربنا يسوع المسيح', 20);
    k.say('النهارده الجو حلو والناس كلها جت الكنيسة بدري', 8);
    eq('everyday words still put nothing up', k.shows.length, n);
  }
  // ---- a verse quoted again after it left the screen comes back (17 Nov: cleared, said again four times, nothing)
  {
    const k = desk();
    k.say('في البدء خلق الله السموات والأرض');
    eq('(quoted: it goes up)', k.labels(), ['Genesis 1:1']);
    k.say('خلق الله السموات والأرض في البدء خلق الله السموات والأرض', 8);
    eq('said again while it is up: nothing new, and no second card', [k.shows.length, k.cards.length], [1, 1]);
    k.d.onScreen('clear');
    k.say('في البدء خلق الله السموات والأرض', 5);
    eq('its words arriving just after it was taken off do not bring it back', k.shows.length, 1);
    k.say('في البدء خلق الله السماء والأرض', 20);
    eq('said again later, a word different: it comes back', [k.shows.length, k.last().label], [2, 'Genesis 1:1']);
    k.d.onScreen('clear');
    if (enBibles.length) {
      k.say('In the beginning God created the heavens and the earth.', 20);
      eq('… and in English', [k.shows.length, k.last().label], [3, 'Genesis 1:1']);
    }
    // in a reading the verse before is not pulled back by its own last words
    const r = desk();
    r.say('انجيل يوحنا الاصحاح الثالث عدد 16');
    r.say(verse(JOHN, 3, 16));
    r.say(verse(JOHN, 3, 17));
    r.say(verse(JOHN, 3, 18));
    const up = r.labels().join(' ');
    r.say(verse(JOHN, 3, 16).split(' ').slice(0, 8).join(' '), 4);
    eq('a verse of the chapter being read, quoted again, does not pull the screen back', r.labels().join(' '), up);
  }
  // ---- a verse said in two pieces, a pause between them (18 Nov, heard from across the room: «لأنها هكذا أحب الله العالم.»
  //      and «حتى بذل ابنه الوحيد.» came as two sentences, and the verse stayed a card)
  {
    const k = desk();
    k.say('لأنها هكذا أحب الله العالم.');
    eq('the first words, one of them wrong: a card to check', [k.shows.length, k.cards.map(c => c.label)], [0, ['John 3:16']]);
    k.say('حتى بذل ابنه الوحيد.', 3);
    eq('… the rest, a moment later: the verse goes up, with no second card', [k.labels(), k.last().why, k.cards.length], [['John 3:16'], 'auto-quote', 1]);
    k.say('لكي لا يهلك كل من يؤمن به', 3);
    eq('… and its last words add nothing', [k.labels(), k.cards.length], [['John 3:16'], 1]);
    const z = desk();
    z.say('لأنها هكذا أحب الله العالم.');
    z.say('حتى بذل ابنه الوحيد.', 40);
    eq('the two halves most of a minute apart are not one verse', z.shows.length, 0);
    const y = desk();
    y.say('لأنها هكذا أحب الله العالم.');
    y.say('يعني الآية دي حلوة قوي يا جماعة وكلنا عارفينها', 3);
    y.say('في البدء خلق الله السماوات والأرض', 3);
    eq('talk after the first half, then another verse: only that one goes up', y.labels(), ['Genesis 1:1']);
    const w = desk();
    w.say('في البدء خلق الله السماوات والأرض');
    w.say('الرب راعي فلا يعوزني شيء', 3);
    eq('two verses one after the other are still two', w.labels(), ['Genesis 1:1', 'Psalms 23:1']);
    const h = desk();
    h.d.hold = true;
    h.say('لأنها هكذا أحب الله العالم.');
    h.say('حتى بذل ابنه الوحيد.', 3);
    eq('Hold on: the two pieces stay one card', [h.shows.length, h.cards.length], [0, 1]);
  }
  // ---- a quote goes up while it is still being said (18 Nov, with words arriving as they are spoken: John 3:16 went up
  //      only when the sentence ended, eight seconds after it began: "by then the user is basically done talking")
  {
    const J = 'لأنه هكذا أحب الله العالم حتى بذل ابنه الوحيد لكي لا يهلك كل من يؤمن به بل تكون له الحياة الأبدية', words = J.split(' ');
    const upTo = (k, a, b) => { for (let i = a; i <= b; i++) k.hear(words.slice(0, i).join(' ')); };
    const k = desk();
    let at = null;
    for (let i = 1; i <= words.length; i++) { upTo(k, i, i); if (at == null && k.shows.length) at = i; }
    eq('it goes up part of the way through the verse', [k.labels(), k.last().why, at != null && at <= 9], [['John 3:16'], 'auto-quote', true]);
    k.say(J, 0.4);
    eq('… and the finished sentence adds nothing: one show, one card', [k.shows.length, k.cards.length], [1, 1]);
    k.say(verse(JOHN, 3, 17), 3);
    eq('… and the reading is followed from there', k.last().label, 'John 3:17');
    // the switch in Settings: off, a quote waits for the end of the sentence
    const o = desk({ quoteLive: false });
    upTo(o, 1, words.length);
    eq('the switch off: nothing while it is being said', o.shows.length, 0);
    o.say(J, 0.4);
    eq('… it goes up when the sentence is finished', o.labels(), ['John 3:16']);
    // quotes that only make cards are not hurried
    const c = desk({ autoShowQuotes: false });
    upTo(c, 1, words.length);
    eq('quotes not put up by themselves: no card from words still being said', [c.shows.length, c.cards.length], [0, 0]);
    c.say(J, 0.4);
    eq('… the card comes with the sentence', [c.shows.length, c.cards.map(x => x.label)], [0, ['John 3:16']]);
    // the operator takes it off while it is still being said: it stays off
    const x = desk();
    upTo(x, 1, 12);
    eq('(up while being said)', x.labels(), ['John 3:16']);
    x.d.onScreen('clear');
    upTo(x, 13, words.length);
    x.say(J, 0.4);
    eq('taken off while it was being said: it is not put back', x.shows.length, 1);
    // words still being said can change: one preview is not enough
    const y = desk();
    y.hear(words.slice(0, 9).join(' '));
    eq('found in one preview only: not yet', y.shows.length, 0);
    y.hear('والناس كلها جت الكنيسة بدري النهارده علشان الاجتماع');
    eq('… and the next preview says something else: nothing', y.shows.length, 0);
    // Hold
    const h = desk();
    h.d.hold = true;
    upTo(h, 1, words.length);
    eq('Hold on: nothing from words still being said', [h.shows.length, h.cards.length], [0, 0]);
    // a set prayer is still a set prayer while it is being said
    const p = desk();
    p.read('أبانا الذي في السماوات ليتقدس اسمك ليأت ملكوتك لتكن مشيئتك كما في السماء كذلك على الأرض');
    eq("the Lord's Prayer, word by word: no verse goes up from the words still being said", p.shows.length, 0);
    p.say('أبانا الذي في السماوات ليتقدس اسمك ليأت ملكوتك لتكن مشيئتك كما في السماء كذلك على الأرض', 0.4);
    eq('… the finished prayer brings up its passage, as before (a verse at a time)', [p.last().label, p.last().why], ['Matthew 6:9', 'auto-phrase']);
    if (enBibles.length) {
      const e = desk();
      e.read('For God so loved the world that he gave his one and only Son that whoever believes in him shall not perish');
      eq('in English too', e.labels(), ['John 3:16']);
    }
  }
  // ---- following ends at the last verse of a chapter (18 Nov: James 2:26 went on to 3:1 and Psalm 1:6 to 2:1 as the last
  //      verse ended: "I want it to end at the last verse of the chapter instead of going to the next chapter")
  {
    const k = desk();
    k.say('مزمور 1 عدد 3');
    for (let v = 4; v <= 6; v++) k.say(verse(PSALMS, 1, v));
    eq('(a psalm read through: the screen is on its last verse)', k.last().label, 'Psalms 1:6');
    k.say(verse(PSALMS, 1, 6), 4);
    k.wait(12);
    eq('its last verse read to the end: the screen stays there', k.last().label, 'Psalms 1:6');
    k.say('آمين يا رب بارك كلمتك لينا النهارده', 4);
    eq('… and talk after it changes nothing', k.last().label, 'Psalms 1:6');
    // the reader goes on into the next psalm: found by its words, like any quote
    k.say(verse(PSALMS, 2, 1), 6);
    eq('the next psalm, really read: it goes up', k.last().label, 'Psalms 2:1');
    // inside a chapter nothing has changed
    const m = desk();
    m.say('مزمور 1 عدد 1');
    for (let v = 2; v <= 4; v++) m.say(verse(PSALMS, 1, v));
    m.read(verse(PSALMS, 1, 5));
    eq('(inside the chapter the next verse still goes up as one ends)', [m.last().label, m.last().why], ['Psalms 1:6', 'end-of-verse']);
  }
  // ---- 18 Nov, the first evening with words arriving as they are spoken (Soniox): three stretches of that evening's
  //      tests, read from an English translation this PC does not have (the words as they arrived are in test/fixtures)
  if (enBibles.length) {
    // James 2:16 quoted, "Next", then read on to the end of the chapter, and the next chapter's first verse read
    const LEAD = { readLead: 1 };                // (the setting that evening: the next verse goes up a second before the end)
    const j = replay('james2-soniox-live.jsonl', LEAD);
    const quoted = j.shows[0] || {};
    eq('a quote goes up while it is still being said (its sentence ended at 27.1 s)', [quoted.label, quoted.why, quoted.t < 1000 + 26.5], ['James 2:16', 'auto-quote', true]);
    eq('the chapter is followed to its last verse', j.covered(59, 2), range(16, 26));
    const ch3 = j.shows.filter(s => s.ref.chapter === 3);
    eq('the last verse ended: the screen did not go on into the next chapter', j.shows.filter(s => s.t < 1000 + 112).slice(-1)[0].label, 'James 2:26');
    eq('… the next chapter went up only when its first verse was really read', ch3.map(s => [s.label, s.why]), [['James 3:1', 'auto-quote']]);
    // John 3:16 said in two breaths, "Next verse", then read on (Arabic, then English) to verse 24
    const n = replay('john3-soniox-live.jsonl', LEAD);
    eq('said in two breaths: up in the second one, before the sentence ended (11.2 s)', [n.shows[0].label, n.shows[0].t < 1000 + 10], ['John 3:16', true]);
    eq('"Next verse" and the reading are followed', n.covered(JOHN, 3), range(16, 24));
    eq('a verse of the reading in other words ("This was before John was put in prison") does not pull the screen to Mark 1:14',
      [n.labels().includes('Mark 1:14'), n.last().label, n.cards.filter(c => c.label === 'Mark 1:14').map(c => c.auto)], [false, 'John 3:24', [false]]);
    // 1 John 4:13 put up by hand, then read on to verse 20
    const o = replay('1john4-soniox-live.jsonl', LEAD, k => k.d.show({ book: 62, chapter: 4, verse: 13 }, 'operator'));
    eq('a verse read to its end in another translation is not taken for "he has stopped" (the screen went back to 4:19)',
      [o.shows.some(s => s.why === 'reading-stopped'), o.covered(62, 4).filter(v => v >= 13 && v <= 20), o.last().ref.verse >= 20], [false, range(13, 20), true]);
  }
  // ---- "Next verse." after an Arabic verse, written «التالي» by the speech model
  {
    const k = desk();
    k.say('وأما أنتم فلكم مسحة من القدوس');
    eq('(1 John 2:20 by its words)', k.last().label, '1 John 2:20');
    k.say('التالي', 9);
    eq('«التالي» alone moves on', [k.last().label, k.last().why], ['1 John 2:21', 'spoken-next']);
    k.say('verse.', 1);
    eq('… and "verse." after it does nothing', k.last().label, '1 John 2:21');
  }
  // ---- Philippians heard as «فليب» / «في ليبيا»: the verse asked for goes up, not that verse of the chapter before
  {
    const k = desk();
    k.say('في تكوين 3.15');
    k.say('وكمان في فليب 5', 20);
    k.say('مفيش فليب خمسة فليب أربعة', 6);
    k.say('عدد واحد بيقول الكتاب', 3);
    eq('«فليب أربعة … عدد واحد»', k.last().label, 'Philippians 4:1');
    k.say('الأصح رابع وعدد أربع', 16);
    eq('«الأصح رابع وعدد أربع»', k.last().label, 'Philippians 4:4');
    eq('… and Genesis 3:1 was never shown', k.labels().includes('Genesis 3:1'), false);
  }
  // ---- "John 3:16 to 20": followed to verse 20, and it stays there when 20 has been read
  if (enBibles.length) {
    const k = desk({ readLead: 1 });
    k.say('Let us read John 3:16 to 20');
    eq('a range said in English: its first verse goes up', k.last().label, 'John 3:16');
    for (let v = 16; v <= 20; v++) { k.read(english(JOHN, 3, v)); k.say(english(JOHN, 3, v), 1); }
    k.wait(15);
    eq('… every verse to 20, and no further when 20 has been read', [k.covered(JOHN, 3), k.last().label, k.shows.some(x => x.ref.verse > 20)], [range(16, 20), 'John 3:20', false]);
  }
  // ---- words that arrive faster than anyone can read are not believed
  {
    const k = desk();
    k.say('انجيل يوحنا الاصحاح 3 من عدد 14 الى عدد 20');
    k.read(verse(JOHN, 3, 14));
    k.say(verse(JOHN, 3, 14), 1);
    k.hear(verse(JOHN, 3, 15), 0.6);                               // the whole verse 0.6 s after it went up
    eq('a whole verse at once, a moment after it went up: the screen stays', k.last().label, 'John 3:15');
    k.hear(verse(JOHN, 3, 15), 3);
    eq('… once there has been time to read it, it counts', k.last().label, 'John 3:16');
  }
  // ---- a short range is shown whole and ends where it says
  {
    const k = desk();
    k.say('انجيل يوحنا الاصحاح 3 من عدد 14 الى عدد 17');             // (announced first, as on 17 November)
    k.say('انجيل يوحنا الاصحاح 3 من عدد 14 الى عدد 16');
    eq('three verses go up together', k.last().label, 'John 3:14-16');
    for (const v of [14, 15]) { k.read(verse(JOHN, 3, v)); k.say(verse(JOHN, 3, v), 1); }
    eq('reading the first two changes nothing (the end of 15 is not the end of 16)', k.last().label, 'John 3:14-16');
    k.read(verse(JOHN, 3, 16));
    eq('… nor does the end of the last one: the range ends there', k.last().label, 'John 3:14-16');
  }
  // ---- the end of the verse on screen is, word for word, the verse before it
  {
    const k = desk();
    k.say('انجيل يوحنا الاصحاح 3 عدد 16');
    const w = verse(JOHN, 3, 16).split(' ');
    k.say(w.slice(0, 12).join(' '));
    const r = k.say(w.slice(12).join(' '));
    eq('the last words of John 3:16 are not a quote of John 3:15', [k.labels(), k.cards.map(c => c.label), r.found.length], [['John 3:16'], ['John 3:16'], 0]);
  }
  // ---- one verse announced, and the reader goes on
  {
    const k = desk();
    k.say('رساله روميه الاصحاح 8 عدد 28');
    k.read(verse(ROMANS, 8, 28));
    eq('one verse announced and read: the screen stays on it', k.last().label, 'Romans 8:28');
    k.say(verse(ROMANS, 8, 28), 1);
    const t0 = k.t;
    k.read(verse(ROMANS, 8, 29));
    const s29 = k.shows.find(x => x.label === 'Romans 8:29');
    eq('he goes on into the next verse: it goes up at its first words', [!!s29 && s29.why, !!s29 && s29.t - t0 <= 2.5], ['read-along', true]);
    k.say(verse(ROMANS, 8, 29), 1);
    k.read(verse(ROMANS, 8, 30));
    eq('two verses in a row are not yet a reading: the third is waited for too', k.shows.find(x => x.label === 'Romans 8:30').why, 'read-along');
    eq('… three are: the fourth goes up as the third ends', [k.last().label, k.last().why], ['Romans 8:31', 'end-of-verse']);
    k.say(verse(ROMANS, 8, 30), 1);
    k.wait(9);
    eq('he stops there and says nothing: back to the verse he ended on', [k.last().label, k.last().why], ['Romans 8:30', 'reading-stopped']);
  }
  // ---- "we read from verse 3"
  {
    const k = desk();
    k.say('انجيل يوحنا الاصحاح 4');
    k.say('هنقرا من عدد 3');
    eq('"from verse 3" puts it up', k.last().label, 'John 4:3');
    k.read(verse(JOHN, 4, 3));
    eq('… and is a reading from there: the next verse goes up as it ends', [k.last().label, k.last().why], ['John 4:4', 'end-of-verse']);
    k.say(verse(JOHN, 4, 3), 1);
    k.say('وهنا عايز اقول لكم حاجه مهمه جدا قبل ما نكمل القرايه', 4);
    eq('he stops to talk: back to the verse he read', [k.last().label, k.last().why], ['John 4:3', 'reading-stopped']);
  }
  // ---- a preview's reference counts once it has been there twice
  {
    const k = desk();
    k.hear('يوحنا ثلاثة'); k.hear('يوحنا ثلاثة ستة عام'); k.hear('يوحنا 316');
    eq('a number still being said shows nothing', k.shows.length, 0);
    k.say('يوحنا ثلاثة ستة عشر', 0.7);
    eq('the finished sentence does', k.labels(), ['John 3:16']);
  }
  // ---- English, and a reading in two languages
  if (enBibles.length) {
    const k = desk();
    k.d.show({ book: PSALMS, chapter: 1, verse: 1, verseEnd: 6 }, 'plan');
    eq('a planned passage goes up a verse at a time', k.last().label, 'Psalms 1:1');
    k.read(english(PSALMS, 1, 1));
    eq('read in English, it is followed the same way', [k.last().label, k.last().why], ['Psalms 1:2', 'end-of-verse']);
    k.say(english(PSALMS, 1, 1), 1);
    k.read(english(PSALMS, 1, 2));
    eq('… verse after verse', k.last().label, 'Psalms 1:3');

    const b = desk();
    b.d.show({ book: PSALMS, chapter: 1, verse: 1, verseEnd: 6 }, 'plan');
    b.read(verse(PSALMS, 1, 1)); b.say(verse(PSALMS, 1, 1), 1);
    eq('(Arabic first: the next verse goes up)', b.last().label, 'Psalms 1:2');
    b.read(english(PSALMS, 1, 1).split(' ').slice(0, 9).join(' '));
    eq('the same verse again in English: back to it', [b.last().label, b.last().why], ['Psalms 1:1', 'reading-stopped']);
    b.read(english(PSALMS, 1, 1)); b.say(english(PSALMS, 1, 1), 1);
    eq('… and on when it has been read in both', b.last().label, 'Psalms 1:2');
    b.read(verse(PSALMS, 1, 2)); b.say(verse(PSALMS, 1, 2), 1);
    eq('from then on a verse is over when both languages have read it: Arabic alone is not the end', b.last().label, 'Psalms 1:2');
    b.read(english(PSALMS, 1, 2));
    eq('… the English after it is', b.last().label, 'Psalms 1:3');
  } else console.log('(no English Bible in data: the English tests were left out)');

  // =====================================================================================
  // An interpreted sermon: an English pastor, and an interpreter who gives each sentence in Arabic after him
  // =====================================================================================
  {
    eq('a few English words in an Arabic sentence are not a sentence of their own', VE.langRuns('الـ grace بتاعة ربنا كبيرة قوي في John 3:16').length, 1);
    eq('an English sentence and then its Arabic are two', VE.langRuns('For God so loved the world, that he gave his Son. لأنه هكذا أحب الله العالم حتى بذل ابنه').map(x => VE.isEnglish(x)), [true, false]);
    const k = desk();
    k.say('Please open your Bibles to John chapter 3, verse 16. من فضلكم افتحوا الكتاب المقدس على إنجيل يوحنا الإصحاح الثالث العدد السادس عشر');
    eq('the pastor and the interpreter in one sentence: the reference is found once', [k.labels(), k.cards.length], [['John 3:16'], 1]);
    k.say('God did not send his love in words only. He sent his Son.');
    eq('talk that begins like the next verse does not move the screen', k.last().label, 'John 3:16');
  }
  if (enBibles.length) {
    const k = desk(), en = (b, c, v) => enBibles[1 % enBibles.length].verse(b, c, v);
    // (the sentences keep changing language: an interpreter is at work)
    k.say('Good morning everyone, it is a joy to be with you today.'); k.say('صباح الخير يا جماعة، فرحان جدا إني معاكم النهارده', 3);
    k.say('I want to talk to you about the love of God.', 3); k.say('عايز أكلمكم عن محبة ربنا', 3);
    k.say('دلوقتي هنقرا من رسالة رومية الاصحاح 8 من عدد 28 الى عدد 31', 3);
    eq('(a passage is announced)', k.last().label, 'Romans 8:28');
    k.read(en(ROMANS, 8, 28)); k.say(en(ROMANS, 8, 28), 1);
    eq('the pastor reads the verse in English: the screen waits for the interpreter', k.last().label, 'Romans 8:28');
    k.read(verse(ROMANS, 8, 28));
    eq('the interpreter reads it in Arabic: now the next verse goes up', [k.last().label, k.last().why], ['Romans 8:29', 'end-of-verse']);
    k.say(verse(ROMANS, 8, 28), 1);
    k.read(en(ROMANS, 8, 29)); k.say(en(ROMANS, 8, 29), 1);
    k.say('علشان اللي ربنا عرفهم من الأول، هو كمان اختارهم يبقوا شبه صورة ابنه، علشان يبقى هو البكر وسط إخوات كتير', 9);   // his own words, not the Bible's
    eq('the interpreter gives the verse in his own words: the screen stays while he speaks', k.last().label, 'Romans 8:29');
    k.read(en(ROMANS, 8, 30).split(' ').slice(0, 9).join(' '));
    eq('… and moves on when the pastor begins the next verse', [k.last().label, k.last().why], ['Romans 8:30', 'read-along']);
  }
  // ---- a reader who talks between the verses; words that are in two verses of the chapter; «عدد ٩» after a quote card
  {
    const k = desk(), EZEKIEL = 26;
    k.say('سفر حزقيال الاصحاح 37 من عدد 1 الى عدد 14');
    k.read(verse(EZEKIEL, 37, 1)); k.say(verse(EZEKIEL, 37, 1), 1);
    eq('(a passage: the second verse goes up as the first ends)', k.last().label, 'Ezekiel 37:2');
    k.say('وهنا عايز اقول لكم حاجه مهمه جدا عن الوادي ده قبل ما نكمل', 4);
    eq('he talks about the verse instead: back to it', [k.last().label, k.last().why], ['Ezekiel 37:1', 'reading-stopped']);
    k.read(verse(EZEKIEL, 37, 2));
    eq('he reads on: the next verse at its first words', k.last().label, 'Ezekiel 37:2');
    k.say(verse(EZEKIEL, 37, 2), 1);
    eq('… and from then on the screen waits for him at the end of each verse', k.last().label, 'Ezekiel 37:2');
    k.d.show({ book: EZEKIEL, chapter: 37, verse: 9 }, 'card');
    k.say(verse(EZEKIEL, 37, 10).split(' ').slice(0, 3).join(' '), 8);          // «فتنبأت كما أمرني»: verse 7 begins the same way
    eq('words that begin the next verse and are also in an earlier one: the next verse', [k.last().label, k.last().why], ['Ezekiel 37:10', 'read-along']);
    const c = desk({ cardOnly: ['19:23:1'] });
    c.d.show({ book: EZEKIEL, chapter: 37, verse: 4 }, 'card');
    c.say(verse(PSALMS, 23, 1), 30);                                         // quoted in passing: a card (this verse is 'card only'), not the screen
    c.say('في عدد 9', 20);
    eq('«عدد ٩» is verse 9 of the chapter on the screen', c.last().label, 'Ezekiel 37:9');
  }

  // ---- two recordings as the model on this PC heard them, words as they arrived: how much of the time was the verse
  //      being read the one on the screen? (truth: when each verse is read in the recording)
  function inStep(file, over) {
    const k = replay(file + '.jsonl', over);
    const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file + '.truth.json'), 'utf8')).filter(u => u.ref);
    let n = 0, on = 0, ahead = 0;
    for (const u of truth) {
      const [b, c, v] = u.ref.split(':').map(Number);
      for (let t = u.start; t <= u.end; t += 0.1) {
        let s = null;
        for (const x of k.shows) { if (x.t - 1000 <= t) s = x; else break; }
        n++;
        if (s && s.ref.book === b && s.ref.chapter === c) { if (v >= s.ref.verse && v <= (s.ref.verseEnd || s.ref.verse)) on++; else if (s.ref.verse > v) ahead++; }
      }
    }
    return { on: Math.round(100 * on / n), ahead: Math.round(100 * ahead / n), k };
  }
  {
    // Psalm 1 (a range), John 3:16, John 3:14-20 (a range), Romans 8:28-31 (unannounced), Psalm 23:1 then talk, Psalm 1 in English
    const r = inStep('readings-local-live');
    eq(`six readings, spoken: the right verse is up 93% of the time or more (${r.on}%), ahead under 5% (${r.ahead}%)`, r.on >= 93 && r.ahead < 5, true);
    eq('… John 3:6 and 3:4 (numbers still being said) never go up, and John 3:15 only in its own passage', r.k.labels().filter(l => ['John 3:6', 'John 3:4', 'John 3:15'].includes(l)).length, 1);
    // with the usual one-second lead the verses go up earlier, and the screen is still on the verse being read most of the time
    const mean = k => { const t = k.shows.filter(x => x.why === 'end-of-verse').map(x => x.t); return t.reduce((a, b) => a + b, 0) / t.length; };
    const early = inStep('readings-local-live', { readLead: 1 });
    const gain = mean(r.k) - mean(early.k);
    eq(`a one-second lead: verses go up 0.4 to 2 s earlier (${gain.toFixed(1)} s), the right verse still up 85% of the time or more (${early.on}%)`, gain >= 0.4 && gain <= 2 && early.on >= 85, true);
    const j = inStep('john4-local-live');                            // the sermon clip: «هنقرأ من عدد ثلاثة», then John 4:3-17 read aloud
    eq(`John 4 read in a sermon: the right verse is up 88% of the time or more (${j.on}%), ahead under 5% (${j.ahead}%)`, j.on >= 88 && j.ahead < 5, true);
  }

  {
    // A real interpreted sermon from the sound desk (an English pastor, an Arabic interpreter talking over the end of each
    // sentence), heard by the model on this PC with both languages kept: «the chapter of 37 Ezekiel», then Ezekiel
    // 37:1-14 read a verse at a time with talk in between.
    const r = inStep('ezekiel37-interpreted-live');
    const order = r.k.shows.filter(x => x.ref.book === 26 && x.why !== 'reading-stopped').map(x => x.ref.verse);
    eq('an interpreted reading: every verse from 1 to 14 goes up, in order', [r.k.covered(26, 37), order.every((v, i) => i === 0 || v >= order[i - 1])], [range(1, 14), true]);
    eq("… the first from the pastor's English, as soon as he begins the chapter", [r.k.shows[0].label, r.k.shows[0].why, r.k.shows[0].t - 1000 < 50], ['Ezekiel 37:1', 'chapter-opening', true]);
    eq('… the screen goes on ahead of him once at most, and nothing else is shown', [r.k.shows.filter(x => x.why === 'reading-stopped').length <= 1, r.k.shows.every(x => x.ref.book === 26 && x.ref.chapter === 37)], [true, true]);
    eq(`… and while the interpreter reads a verse it is the one on the screen 80% of the time or more (${r.on}%)`, r.on >= 80, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
