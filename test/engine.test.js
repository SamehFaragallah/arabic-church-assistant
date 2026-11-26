// Run: node test/engine.test.js
// Uses a tiny fake Bible (correct chapter/verse counts for the books tested) so it runs without the download.
// If data/ar_svd.json exists, the quote-matching tests also run against the real text.
const fs = require('fs');
const path = require('path');
const VE = require('../public/engine.js');

let pass = 0, fail = 0;
const pendingTests = [];
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got:  ${g}\n   want: ${w}`); }
}

// ---- numbers
const num = s => { const t = VE.tokenize(s); const r = VE.parseNumber(t, 0); return r && r.value; };
eq('num 16 words', num('ستة عشر'), 16);
eq('num 16 ordinal', num('السادس عشر'), 16);
eq('num 16 egyptian', num('ستاشر'), 16);
eq('num 28', num('ثمانية وعشرين'), 28);
eq('num 23 ordinal', num('الثالث والعشرون'), 23);
eq('num 119', num('مية وتسعتاشر'), 119);
eq('num 119 msa', num('المئة والتاسع عشر'), 119);
eq('num 11', num('الحادي عشر'), 11);
eq('num 12', num('اثنا عشر'), 12);
eq('num digits', num('١٦'), 16);
eq('num first', num('الأول'), 1);

// ---- fake bible: enough chapters/verses for tests
function fakeBible() {
  const raw = [];
  for (let b = 1; b <= 66; b++) {
    const chs = [];
    for (let c = 1; c <= 150; c++) { const vs = []; for (let v = 1; v <= 176; v++) vs.push(`b${b} c${c} v${v}`); chs.push(vs); }
    raw.push({ chapters: chs });
  }
  // single-chapter books
  for (const b of [31, 57, 63, 64, 65]) raw[b - 1] = { chapters: [raw[b - 1].chapters[0].slice(0, 25)] };
  raw[42].chapters = raw[42].chapters.slice(0, 21);       // John 21 chapters
  raw[44].chapters = raw[44].chapters.slice(0, 16);       // Romans 16
  raw[44].chapters[7] = raw[44].chapters[7].slice(0, 39); // Romans 8 has 39 verses
  raw[36].chapters = [raw[36].chapters[0].slice(0, 15), raw[36].chapters[1].slice(0, 23)];   // Haggai: 2 chapters, 15 and 23 verses
  return new VE.Bible(raw);
}
const bible = fakeBible();

function detect(text) {
  const d = new VE.Detector(bible, { quotes: false });
  return d.processFinal(text, 1000).map(c => `${c.labelEn}|${c.source}`);
}

eq('digits', detect('افتحوا معايا يوحنا ٣: ١٦'), ['John 3:16|reference']);
eq('msa words', detect('في إنجيل يوحنا الأصحاح الثالث والعدد السادس عشر'), ['John 3:16|reference']);
eq('egyptian', detect('يوحنا تلاتة عدد ستاشر'), ['John 3:16|reference']);
eq('romans words', detect('رومية ثمانية ثمانية وعشرين'), ['Romans 8:28|reference']);
eq('range', detect('رومية ٨ من عدد ٢٨ لعدد ٣٠'), ['Romans 8:28-30|reference']);
eq('range dash', detect('رومية 8: 28-30'), ['Romans 8:28-30|reference']);
eq('verse before book', detect('العدد ١٦ من الأصحاح الثالث من إنجيل يوحنا'), ['John 3:16|reference']);
eq('1 cor after', detect('كورنثوس الأولى الأصحاح ١٣ عدد ٤'), ['1 Corinthians 13:4|reference']);
eq('1 cor long', detect('رسالة بولس الرسول الأولى إلى أهل كورنثوس الأصحاح الثالث عشر'), ['1 Corinthians 13|reference']);
eq('2 cor digit', detect('٢ كورنثوس ٥ ١٧'), ['2 Corinthians 5:17|reference']);
eq('1 john', detect('رسالة يوحنا الأولى الأصحاح الأول عدد تسعة'), ['1 John 1:9|reference']);
eq('psalm', detect('مزمور ٢٣'), ['Psalms 23|reference']);
eq('psalm 119', detect('المزمور المية وتسعتاشر عدد مية وخمسة'), ['Psalms 119:105|reference']);
eq('jude single', detect('رسالة يهوذا عدد ٢٤'), ['Jude 1:24|reference']);
eq('jude number', detect('يهوذا ٢٤'), ['Jude 1:24|reference']);
eq('1 samuel', detect('صموئيل الأول الأصحاح السابع عشر'), ['1 Samuel 17|reference']);
eq('2 kings before', detect('تاني ملوك خمسة'), ['2 Kings 5|reference']);
eq('matthew', detect('متى خمسة عدد تلاتة'), ['Matthew 5:3|reference']);
eq('when not matthew', detect('متى جاء يسوع إلى الهيكل'), []);
eq('numbers needs sefer', detect('العدد كبير جدا'), []);
eq('book name w/o number', detect('يوحنا المعمدان كان في البرية'), []);
eq('revelation john', detect('رؤيا يوحنا ٣ ٢٠'), ['Revelation 3:20|reference']);
eq('acts', detect('أعمال الرسل الأصحاح الثاني'), ['Acts 2|reference']);
eq('waw prefix', detect('وفي رومية ١٢ وعدد ١'), ['Romans 12:1|reference']);
eq('invalid verse drops to chapter', detect('رومية ٨ عدد ٩٠'), ['Romans 8|reference']);
eq('two refs', detect('يوحنا ٣ ١٦ و رومية ٥ ٨'), ['John 3:16|reference', 'Romans 5:8|reference']);
eq('chapter from..to', detect('النهارده هنقرا يوحنا واحد من واحد لغايه 24'), ['John 1:1-24|reference']);
eq('chapter from..to digits', detect('هنقرا يوحنا 3 من 16 الى 18'), ['John 3:16-18|reference']);
eq('chapter from..to lahad', detect('رومية تمانية من واحد لحد عشرة'), ['Romans 8:1-10|reference']);
eq('chapter from awal', detect('يوحنا واحد من الأول لغاية الخامس'), ['John 1:1-5|reference']);
eq('chapter then from verse', detect('متى خمسة من عدد ٣ لعدد ١٢'), ['Matthew 5:3-12|reference']);
eq('chapter word first + على', detect('يلا نقرا مع بعض اصحاح يوحنا على الثلاثه'), ['John 3|reference']);
eq('book على chapter', detect('افتحوا معايا رومية على تمانية'), ['Romans 8|reference']);
eq('على chapter + verse', detect('اصحاح يوحنا على التلاتة عدد ستاشر'), ['John 3:16|reference']);
eq('على digits', detect('مزمور على ٢٣'), ['Psalms 23|reference']);
eq('على no number', detect('يوحنا على الصليب كان واقف'), []);
eq('psalm al-', detect('المزمور الـ ٢٣'), ['Psalms 23|reference']);
eq('to end of chapter', detect('رومية ٨ من عدد ٢٨ لحد آخر الأصحاح'), ['Romans 8:28-39|reference']);
eq('to end lil-akher', detect('رومية ٨ من ٣١ للآخر'), ['Romans 8:31-39|reference']);
eq('consecutive و', detect('يوحنا ٣ عدد ١٦ و ١٧'), ['John 3:16-17|reference']);
eq('non-consecutive و ignored', detect('يوحنا ٣ عدد ١٦ و ٢٠'), ['John 3:16|reference']);
eq('feminine ordinal verse', detect('رومية ٨ الآية الحادية عشرة'), ['Romans 8:11|reference']);
eq('chronicles no al', detect('أخبار أيام التاني ٧ ١٤'), ['2 Chronicles 7:14|reference']);
eq('3 john digit', detect('٣ يوحنا ٤'), ['3 John 1:4|reference']);
eq('arabic decimal sep', detect('يوحنا ٣٫١٦'), ['John 3:16|reference']);
eq('revelation ta marbuta', detect('سفر الرؤية ٢١ ٤'), ['Revelation 21:4|reference']);
eq('query end', VE.parseQuery('رومية ٨ من ٢٨ لآخر الأصحاح', bible), { book: 45, chapter: 8, verse: 28, verseEnd: 39 });
eq('strip tashkeel', VE.stripTashkeel('لِأَنَّهُ هَكَذَا أَحَبَّ ٱللَّهُ'), 'لأنه هكذا أحب الله');
eq('normalize tashkeel', VE.normalize('لِأَنَّهُ هَكَذَا أَحَبَّ ٱللَّهُ ٱلْعَالَمَ'), 'لانه هكذا احب الله العالم');
eq('nav next', VE.detectNav('تعالوا نشوف العدد اللي بعده'), 'next');
eq('nav next msa', VE.detectNav('ونقرأ الآية التالية'), 'next');
eq('nav next gai', VE.detectNav('العدد الجاي بيقول'), 'next');
eq('nav prev', VE.detectNav('ارجعوا للعدد اللي قبله'), 'prev');
eq('nav prev msa', VE.detectNav('كما قرأنا في الآية السابقة'), 'prev');
eq('nav none', VE.detectNav('واللي بعده جه وقال'), null);
eq('bare next: end of sentence', VE.detectNav('نقرا اللي بعده'), 'next');
eq('bare next: and the next', VE.detectNav('واللي بعده'), 'next');
eq('Google mishearing "next verse": Nexus 1', VE.detectNav('Nexus 1.'), 'next');
eq('Google mishearing "next verse": next word', VE.detectNav('next word'), 'next');
eq('Google mishearing "next verse": «اكس بوكس»', VE.detectNav('اكس بوكس'), 'next');
eq('Google mishearing "next verse": «نكسبر»', VE.detectNav('نكسبر'), 'next');
eq('not a command: "the next word is love"', VE.detectNav('the next word is love'), null);
eq('bare next: feminine', VE.detectNav('طب اللي بعدها'), 'next');
eq('bare next: goes on reading', VE.detectNav('اللي بعده بيقول لأن الله'), 'next');
eq('bare next: with vocative', VE.detectNav('يلا اللي بعده يا جماعة'), 'next');
eq('bare next: reading noun', VE.detectNav('نشوف الكلام اللي بعده'), 'next');
// "Next verse." said after an Arabic verse is often written «التالي»: the one word, and nothing else, is the command
eq('one word: التالي', VE.detectNav('التالي'), 'next');
eq('one word: Next.', VE.detectNav('Next.'), 'next');
eq('one word: السابق', VE.detectNav('السابق'), 'prev');
eq('… not among other words', VE.detectNav('التالي هو أهم حاجة في الموضوع'), null);
eq('"when I say the next one, the next one comes" is talk about the screen', VE.detectNav('بصي يا مينا لما اقول اللي بعده بيجي اللي بعده'), null);
eq('bare prev', VE.detectNav('نرجع للي قبله'), 'prev');
eq('bare next: «اللي بعديها», the way it is said at home', [VE.detectNav('اللي بعديها.'), VE.detectNav('الآية اللي بعديها'), VE.detectNav('نرجع للي قبليها')], ['next', 'next', 'prev']);
eq('"it is not in the one after it" is not a command', VE.detectNav('أهو في المزمور ده بس مش في اللي بعديها.'), null);
eq('… nor is talk about what the screen does, written as two sentences', VE.detectNav('بص يا مينا، لما أقول اللي بعديه بيجي. اللي بعده.'), null);
eq('bare: the next day is not navigation', VE.detectNav('واليوم اللي بعده راحوا'), null);
eq('bare: the king after him', VE.detectNav('والملك اللي بعده'), null);
eq('bare: the one after him came', VE.detectNav('واللي بعده جه وعمل كده'), null);
eq('bare: mid-sentence', VE.detectNav('اللي بعده في الطابور كان مستني'), null);
eq('bare flag', [VE.detectNavDetail('واللي بعده').bare, VE.detectNavDetail('العدد اللي بعده').bare], [true, false]);
eq('nav none 2', VE.detectNav('عدد كبير من الناس جم بعد كده'), null);
eq('english search', VE.parseQuery('1 cor 13:4-7', bible), { book: 46, chapter: 13, verse: 4, verseEnd: 7 });
eq('english john', VE.parseQuery('john 3 16', bible), { book: 43, chapter: 3, verse: 16, verseEnd: null });

// context: book named first, verse later
{
  const d = new VE.Detector(bible, { quotes: false });
  const a = d.processFinal('خلونا نفتح رومية الأصحاح الثامن', 1000).map(c => c.labelEn);
  const b = d.processFinal('شوفوا عدد ثمانية وعشرين بيقول', 5000).map(c => `${c.labelEn}|${c.source}`);
  eq('context chapter', a, ['Romans 8']);
  eq('context verse', b, ['Romans 8:28|context']);
  const c = d.processFinal('شوفوا عدد ثمانية وعشرين بيقول', 9000);
  eq('dedup', c.length, 0);
}
// operator showed a verse manually: later "عدد ٥" means that chapter
{
  const d = new VE.Detector(bible, { quotes: false });
  d.setContext(45, 12, 1000);
  eq('setContext', d.processFinal('شوفوا معايا عدد اتنين', 2000).map(c => c.labelEn), ['Romans 12:2']);
}
// split across two final segments
{
  const d = new VE.Detector(bible, { quotes: false });
  const a = d.processFinal('افتحوا معايا إنجيل يوحنا', 1000).map(c => c.labelEn);
  const b = d.processFinal('الأصحاح التالت عدد ستاشر', 2000).map(c => c.labelEn);
  eq('split segments', [a, b], [[], ['John 3:16']]);
}
// interim: not accepted while the number may still be growing
{
  const d = new VE.Detector(bible, { quotes: false });
  eq('interim at end', d.processInterim('يوحنا ٣ ١', 1000).length, 0);
  eq('interim complete, seen once: not yet', d.processInterim('يوحنا ٣ ١٦ لأنه', 1100).length, 0);
  eq('interim complete, still there in the next preview', d.processInterim('يوحنا ٣ ١٦ لأنه هكذا', 1150).map(c => c.labelEn), ['John 3:16']);
  eq('final after interim no dup', d.processFinal('يوحنا ٣ ١٦ لأنه هكذا', 1200).length, 0);
}
// a preview's last word is often a guess at a word cut in half: what it seemed to say for one preview is not shown
{
  const d = new VE.Detector(bible, { quotes: false });
  const got = [];
  for (const [t, x] of [[1000, 'يوحنا ثلاثة'], [1700, 'يوحنا ثلاثة ستة عام'], [2400, 'يوحنا 316']]) got.push(...d.processInterim(x, t).map(c => c.labelEn));
  got.push(...d.processFinal('يوحنا ثلاثة ستة عشر', 3000).map(c => c.labelEn));
  eq('«ستة عام» on the way to «ستة عشر» is not John 3:6', got, ['John 3:16']);
}
// Philippians as the speech model writes it («فيلبي ٤ عدد ١» came out as «فليب أربعة … عدد واحد» and «في ليبيا 4 عدد واحد»,
// «الإصحاح الرابع وعدد أربعة» as «الأصح رابع وعدد أربع»)
eq('«فليب» is Philippians', detect('في فليب أربعة عدد واحد'), ['Philippians 4:1|reference']);
eq('«في ليبيا 4 عدد واحد» is Philippians 4:1', detect('في ليبيا 4 عدد واحد خلينا نقرا مع بعض'), ['Philippians 4:1|reference']);
eq('… Libya with a number and no verse is Libya', detect('كان في ليبيا 4 سنين وبعدين رجع'), []);
// Philemon as Soniox wrote it (18 Nov: «في لمون 1:5»). «حاجة» and «حجة» are words, not Haggai (on 18 Nov they were tries at
// saying the name, not mishearings)
eq('«في لمون 1:5» is Philemon 1:5', detect('هنقرأ مع بعض في لمون 1:5.'), ['Philemon 1:5|reference']);
eq('«حاجة 1:1» and «حجة 1:1» are not Haggai', [detect('طب خلينا نقرأ حاجة 1:1.'), detect('وخلينا كمان نقرأ حجة 1:1.')], [[], []]);
{
  const d = new VE.Detector(bible, { quotes: false });
  eq('«مفيش فليب خمسة، فليب أربعة»: chapter four it is', d.processFinal('مفيش فليب خمسة فليب أربعة', 1000).map(c => c.labelEn).slice(-1), ['Philippians 4']);
  eq('… and «عدد واحد» in the next sentence is its verse', d.processFinal('عدد واحد بيقول الكتاب', 4000).map(c => c.labelEn), ['Philippians 4:1']);
  d.processFinal('رسالة الرسول', 20000);
  d.processFinal('بولس الي اهلي فيليبي', 23000);
  eq('«الأصح رابع وعدد أربع» is chapter four, verse four', d.processFinal('الأصح رابع وعدد أربع', 27000).map(c => c.labelEn), ['Philippians 4:4']);
}
// «إيه» / «ايه» is "what", not «آية»
{
  const d = new VE.Detector(bible, { quotes: false });
  d.processFinal('متى 28 عدد 19', 1000);
  d.processFinal('النص اللي عايز يبقى شكله ايه', 30000);
  eq('"what" and then counting is not a verse', d.processFinal('واحد اثنين ثلاثة', 34000).length, 0);
  eq('«إيه 7» neither', d.processFinal('إيه 7 دول', 40000).length, 0);
  eq('«الآية 5» is', d.processFinal('شوف الآية 5', 50000).map(c => c.labelEn), ['Matthew 28:5']);
  eq('«آية 7» is', d.processFinal('وفي آية 7', 60000).map(c => c.labelEn), ['Matthew 28:7']);
}
// «103 عدد 3», the word «مزمور» missed: only the Psalms have a chapter 103. A guess, unless the Psalms are being read
{
  const d = new VE.Detector(bible, { quotes: false });
  d.processFinal('يوحنا 3 16', 1000);
  const c = d.processFinal('102 - 103 - عدد 3 بيت', 30000);
  eq('a chapter number only the Psalms have, John in mind: a card to check, not John 3:3', c.map(x => [x.labelEn, !!x.probable]), [['Psalms 103:3', true]]);
  d.processFinal('مزمور 102 عدد 3', 40000);
  eq('… with the Psalms being read, for certain', d.processFinal('103 عدد 5', 50000).map(x => [x.labelEn, !!x.probable]), [['Psalms 103:5', false]]);
  eq('… a number a book could have is left alone', d.processFinal('4 عدد 6', 60000).map(x => x.labelEn), ['Psalms 103:6']);
}
// «جون» is John said the English way: believed with chapter and verse together; "from verse 3" is a reading from there
eq('جون with chapter and verse', detect('جون 3:14-17'), ['John 3:14-17|reference']);
eq('"Jean 3:15 to 20", as Soniox wrote "John"', detect("We're going to start off by reading Jean 3:15 to 20."), ['John 3:15-20|reference']);
{
  const d = new VE.Detector(bible, { quotes: false });
  eq('جون with a chapter alone is not believed', d.processFinal('جون 3', 1000).length, 0);
  const from = d.processFinal('انجيل يوحنا اصحاح تلاتة وهنقرا من عدد خمسة', 200000).find(c => c.verse != null);
  eq('"from verse 5" is a reading that starts there', [from && from.labelEn, !!(from && from.from)], ['John 3:5', true]);
  const one = d.processFinal('انجيل لوقا اصحاح اتنين عدد عشرة', 400000)[0];
  eq('a verse on its own is not', [one.labelEn, !!one.from], ['Luke 2:10', false]);
  const range = d.processFinal('رومية 8 من 28 الى 30', 600000)[0];
  eq('a range has its own end', [range.labelEn, !!range.from], ['Romans 8:28-30', false]);
}

// ---- English references and navigation
eq('en john words', detect('turn with me to John chapter three verse sixteen'), ['John 3:16|reference']);
eq('en romans words', detect('Romans eight twenty eight says'), ['Romans 8:28|reference']);
eq('en first corinthians range', detect('First Corinthians thirteen four through seven'), ['1 Corinthians 13:4-7|reference']);
eq('en psalm 119', detect('Psalm one hundred nineteen verse one hundred five'), ['Psalms 119:105|reference']);
eq('en psalm hyphen', detect('Psalm twenty-three'), ['Psalms 23|reference']);
eq('en digits colon', detect('2 Corinthians 5:21 tells us'), ['2 Corinthians 5:21|reference']);
eq('en 1st john', detect('1st John 1 9'), ['1 John 1:9|reference']);
eq('en job as a word', detect('I started my job 2 years ago'), []);
eq('en mark as a word', detect('mark 3 things down'), []);
eq('en acts with verse', detect('Acts chapter 2 verse 38'), ['Acts 2:38|reference']);
eq('en lang flag', new VE.Detector(bible, { quotes: false }).processFinal('John 3 16 is amazing', 1)[0].lang, 'en');
eq('ar lang flag', new VE.Detector(bible, { quotes: false }).processFinal('يوحنا ٣ ١٦', 1)[0].lang, 'ar');
eq('en nav next', VE.detectNav("let's read the next verse"), 'next');
eq('en nav prev', VE.detectNav('go back to the previous verse'), 'prev');
eq('en tokens', VE.enTokens("He that believeth hath everlasting life; whoever believes has"), ['he', 'that', 'believ', 'has', 'everlast', 'lif', 'whoever', 'believ', 'has']);
eq('is english', [VE.isEnglish('he became sin for us'), VE.isEnglish('يوحنا ٣ ١٦'), VE.isEnglish('ok')], [true, false, false]);

// ---- YouTube playlist titles
{
  const B = ' | توزيع بولس باسيلى';
  const titles = ['موسيقى ترنيمة أنا عايز أشكرك', 'موسيقى ترنيمة يا رب ارحم', 'موسيقى ترنيمة إنت الراعي الصالح', 'موسيقى ترنيمة ربنا موجود',
    'موسيقى ترنيمة عيد النيروز', 'موسيقى ترنيمة قلبي الخفاق', 'موسيقى ترنيمة سبحوه', 'موسيقى ترنيمة في وسط الضيقات (Official Audio)',
    'Hallelujah - موسيقى ترنيمة هللويا', 'موسيقى ترنيمة بحبك يا يسوع ❤️'];
  const videos = titles.map((t, i) => ({ id: 'v' + (i + 1), title: t + B }));
  const vm = () => new VE.VideoMatcher(videos);
  const hit = (m, text) => m.process(text, Date.now()).map(x => x.video.id + (x.sure ? '!' : ''));
  eq('video phrases drop boilerplate', vm().phrasesFor('v1'), ['انا عايز اشكرك']);
  eq('video phrases english + arabic', vm().phrasesFor('v9'), ['hallelujah', 'هللويا']);
  eq('video announced', hit(vm(), 'دلوقتي هنرنم مع بعض ترنيمة أنا عايز أشكرك'), ['v1!']);
  eq('video long title no cue', hit(vm(), 'وأنا عايزة أشكرك يا رب على كل حاجة'), ['v1']);
  eq('video short title needs cue (none)', hit(vm(), 'ربنا موجود في كل ظروفنا'), []);
  eq('video short title with cue', hit(vm(), 'يلا نرنم ربنا موجود'), ['v4!']);
  eq('kyrie is not a video', hit(vm(), 'يا رب ارحم يا رب ارحم'), []);
  eq('kyrie with cue', hit(vm(), 'هنرنم ترنيمة يا رب ارحم'), ['v2!']);
  eq('single word with cue', hit(vm(), 'نرنم سبحوه'), ['v7!']);
  eq('single word without cue', hit(vm(), 'سبحوه يا كل الأمم'), []);
  eq('verse is not the hymn', hit(vm(), 'أنا هو الراعي الصالح والراعي الصالح يبذل نفسه'), []);
  eq('feast greeting is not a video', hit(vm(), 'كل سنة وانتم طيبين بمناسبة عيد النيروز'), []);
  eq('title split across sentences', (() => { const m = vm(); m.process('خلونا نرنم ترنيمة', 1); return hit(m, 'قلبي الخفاق'); })(), ['v6!']);
  eq('said again within minutes: marked as a repeat', (() => { const m = vm(); const a = m.process('هنرنم أنا عايز أشكرك', 1000); const b = m.process('هنرنم أنا عايز أشكرك', 5000); return [a[0].repeat, b.length, b[0].repeat]; })(), [false, 1, true]);
  eq('said again later: new', (() => { const m = vm(); m.process('هنرنم أنا عايز أشكرك', 1000); return m.process('هنرنم أنا عايز أشكرك', 1000 + 6 * 60000)[0].repeat; })(), false);
  eq('emoji title', hit(vm(), 'نرنم بحبك يا يسوع'), ['v10!']);
  eq('cue from the previous sentence does not count', (() => { const m = vm(); m.process('هنرنم ترنيمة أنا عايز أشكرك', 1); return hit(m, 'ربنا موجود في كل ظروفنا'); })(), []);
  eq('cue with words between', hit(vm(), 'هنرنم مع بعض ربنا موجود'), ['v4!']);
}

// ---- real playlist titles, and what the speech engines actually wrote when they were announced
{
  const T = [
    ['a1', 'تفك الاسر - فيليب ويصا'], ['a2', 'ترنیمة ربي حلو - الحیاة الأفضل رایز | Rabbi Helw - Better Life Rise'],
    ['a3', 'ترنیمة حقك ده في أراضینا - الحیاة الأفضل | Ha\'ak Da Fe Aradeena - Better Life'], ['a4', 'ترنیمة بتحبني - الحیاة الأفضل رایز | Bethebeny - Better Life Rise'],
    ['a5', 'ترنيمة "سوف أدخل أبوابك " .. فريق التسبيح'], ['a6', 'أقـوياء    aqwiya2'], ['a7', 'ترنمية مفيش غيرك يشبع'],
    ['a8', 'ترنیمة یسوع أنت الملك - الحیاة الأفضل | Yasou Anta El Malek - Better Life'], ['a9', 'Way Maker - English & Arabic Cover by B Sharp Band (Live from Beirut after the explosion)'],
    ['a10', 'ترنيمة انت قائدنا يسوع البار - الحياة الأفضل | Enta Qaedna Yasou El Bar - Better Life'],
    ['b1', 'ترنيمة باقدم نفسي ذبيحة / موسيقى هادئة / Relaxing music'], ['b2', 'ترنيمة لا يكون ظلام / موسيقى هادئه / Relaxing music'],
    ['b3', 'ترنيمة يامفتاح قلبي الصغير / موسيقي هادئه / Meditation music / Relaxing music'], ['b4', 'ترنيمة لك ياسيدي / موسيقى هادئة / Relaxing music'],
    ['b5', 'ترنيمة انا في سلام / موسيقى هادئة / Meditation music / Relaxing music'], ['b6', 'ترنيمة بفضل نعمتك / موسيقي هادئه / Meditation music / Relaxing music'],
  ].map(([id, title]) => ({ id, title }));
  const hit = text => new VE.VideoMatcher(T).process(text, 1000).map(x => x.video.id + (x.sure ? '!' : ''));
  eq('Persian letters in titles are read', VE.normalize('ترنیمة ربي حلو - الحیاة'), 'ترنيمه ربي حلو الحياه');
  eq('misheard: «التفوق الأسر» after «ترنيمي»', hit('يلا مع بعضنا من النم ترنيمي التفوق الأسر.'), ['a1!']);
  eq('misheard: «تفوك الأسر»', hit('يلا نرنم ترنيمة تفوك الأسر.'), ['a1!']);
  eq('misheard: «بقدم نفس زبيحة»', hit('يولي مرنم ترنيمة بقدم نفس زبيحة.'), ['b1!']);
  eq('MSA «أقدم» for «باقدم»', hit('نرنم ترنيمة أقدم نفسي ذبيحة'), ['b1!']);
  eq('joined words: «لايكون ظلام»', hit('نرنم ترنيمة لايكون ظلام'), ['b2!']);
  eq('«ترنيمه لا يكون ظلام»', hit('هنرنم ترنيمه لا يكون ظلام'), ['b2!']);
  eq('«يامفتاح» in the title, «يا مفتاح» spoken', hit('نرنم ترنيمة يا مفتاح قلبي الصغير'), ['b3!']);
  // A hymn plays by itself ("!") only when we are invited to sing or hear it. Named, quoted or prayed, it makes a card.
  eq('«ترنيمة …» on its own names the hymn: a card', hit('ترنيمة يا مفتاح قلبي الصغير'), ['b3']);
  eq('a hymn quoted in a sermon: a card', hit('الأخ عنده ترنيمة جميلة بتقول باقدم نفسي ذبيحة'), ['b1']);
  eq('its first line said in a prayer: a card', hit('يا رب باقدم نفسي ذبيحة ليك النهارده'), ['b1']);
  eq('praise addressed to God is not an announcement', hit('عايزين نسبح اسمك يا رب باقدم نفسي ذبيحة'), ['b1']);
  eq('«خلونا نرنم مع بعض ترنيمة …»', hit('خلونا نرنم مع بعض ترنيمة باقدم نفسي ذبيحة'), ['b1!']);
  eq('«ونرنم مع بعض الترنيمة اللي بتقول …»', hit('وخلينا نيجي كلنا كده بانكسار قدام الرب ونرنم مع بعض الترنيمة اللي بتقول باقدم نفسي ذبيحة'), ['b1!']);
  eq('«تعالوا نرنم كده ونقول …»', hit('تعالوا نرنم كده ونقول باقدم نفسي ذبيحة'), ['b1!']);
  eq('«تعالوا نكمل تسبيح ونقول …»', hit('تعالوا نكمل تسبيح و نقول باقدم نفسي ذبيحة'), ['b1!']);
  eq('«نختم تسبيحتنا واحنا بنقول …»', hit('تعالوا نختم تسبيحتنا واحنا بنقول باقدم نفسي ذبيحة'), ['b1!']);
  eq('«قبل ما نسمع ترنيمة …»', hit('خلينا كلنا نصلي قبل ما نسمع ترنيمة اللي بتقول باقدم نفسي ذبيحة'), ['b1!']);
  eq('«شغلوا …» to the operator', hit('شغلوا لنا باقدم نفسي ذبيحة'), ['b1!']);
  eq('the title first, then «تعالوا نقف ونرنم الترنيمة دي»', hit('باقدم نفسي ذبيحة آمين تعالوا نقف ونرنم الترنيمة دي'), ['b1!']);
  eq('"let\'s sing …"; a short title said in passing is nothing', [hit("let's sing together way maker"), hit('way maker is a great song by the way')], [['a9!'], []]);
  eq('«ياسيدي» in the title', hit('نرنم ترنيمة لك يا سيدي'), ['b4!']);
  eq('song name inside quotes', hit('هنرنم ترنيمة سوف أدخل أبوابك'), ['a5!']);
  eq('Arabic + English run together', hit('نرنم ترنيمة أقوياء'), ['a6!']);
  eq('English cue', hit("let's sing way maker"), ['a9!']);
  eq('team name shared by many titles is not a title', hit('ترنيمة من الحياة الأفضل'), []);
  eq('heard note keeps the title spelling', new VE.VideoMatcher(T).process('نرنم ترنيمة لك يا سيدي', 1)[0].phrase, 'لك ياسيدي');
  eq('everyday: «انا في سلام» without a cue', hit('انا في سلام لأن ربنا معايا'), []);
  // 17 Nov: «يلا نرنم ترنيمة رب يسوع الغالي» was heard for the title «ربي يسوع الغالي» and nothing came up
  {
    const one = [{ id: 'gh', title: 'ترنيمة ربي يسوع الغالي- ترانيم كلمة ولحن' }, { id: 'x1', title: 'أيها الفخاري الأعظم-ترانيم كلمة ولحن' }, { id: 'x2', title: 'موسيقى يسوع بيدور' }];
    const said = text => new VE.VideoMatcher(one).process(text, 1000).map(x => x.video.id + (x.sure ? '!' : ''));
    eq('«رب» for «ربي» in an announced title', said('يلا نرنم ترنيمة رب يسوع الغالي'), ['gh!']);
    eq('… but not in everyday words', [said('يا رب ارحمنا كلنا'), said('ربنا يسوع المسيح معانا النهارده')], [[], []]);
  }
  eq('everyday: gap words do not make a title', (() => { const m = new VE.VideoMatcher(T); m.process('انت قائدنا يا رب', 1); return m.process('ربي يسوع حلو قوي', 2).map(x => x.video.id); })(), []);
  eq('everyday: «مفيش غيرك يا رب يشبع»', hit('مفيش غيرك يا رب يشبع قلوبنا'), []);
  eq('everyday: «بفضل النعمة احنا خلصنا»', hit('النهارده هنتكلم عن النعمة وبفضل النعمة احنا خلصنا'), []);
}

// ---- the song database (thousands of titles: asked only when a hymn is announced, and by the search box)
{
  const K = '- ترانيم كلمة ولحن', P = ' | توزيع بولس باسيلى';
  const titles = ['مالي سواك يا سيدي' + K, 'موسيقى ترنيمة مالى سواك (مع إعادات اضافية)' + P, 'مالي غيرك ألجأ ليه' + K, 'أيها الفخاري الأعظم' + K, 'علمني أنتظرك يا رب' + K,
    'ياراويني يايسوع بحنانك' + K, 'مستحق السجود (ياللي دفعت ثمن خطايانا)' + K, 'قلبه حنين' + K, 'يا رب يا واحة' + K, 'موسيقى ترنيمة أنا إتكالى عليك | طبقة1' + P,
    'موسيقى ترنيمة أنا إتكالى عليك | طبقة2' + P, 'سألوذ بحضنك من جهلي' + K, 'يا رب ارحم' + K, 'نشيد حمد في فمي' + K, 'مستحق كل المجد' + K,
    'قدوس قدوس قدوس' + K, 'قدوس قدوس قدوس هاصوت الملائكة ' + K, 'صوت الملايكة بيقول ايه' + K];
  for (let i = 0; i < 40; i++) titles.push('عنوان تاني رقم ' + i + K);          // (so that what the lists share stands out, as in the real ones)
  const db = () => new VE.SongIndex(titles.map((t, i) => ({ id: 's' + (i + 1), title: t })));
  const ids = r => (r ? r.matches.map(m => m.video.id) : null);
  eq('announced: every song that begins like that, the full title first', ids(db().process('خلونا نرنم مع بعض ترنيمة مالي سواك يا سيدي', 1)), ['s1', 's2']);
  eq('… said in part: the title that is just that first', ids(db().process('نرنم ترنيمة مالي سواك', 1)), ['s2', 's1']);
  eq('… it says whether we were invited to sing it', [db().process('خلونا نرنم مع بعض ترنيمة مالي سواك يا سيدي', 1).kind, db().process('فيه ترنيمة جميلة بتقول مالي سواك يا سيدي', 1).kind], ['invite', 'cue']);
  eq('«الترنيمة اللي بتقول …», a word misheard', ids(db().process('ونرنم مع بعض الترنيمة اللي بتقول أيها الفخار الأعظم أنا كالخزف بين يديك', 1)), ['s4']);
  eq('the same hymn in two keys: both', ids(db().process('تعالوا نرنم كده ونقول أنا اتكالي عليك', 1)), ['s10', 's11']);
  eq('a word or two before the title', ids(db().process('فيه ترنيمة جميلة بتقول قلبه حنين حبه يبين', 1)), ['s8']);
  eq('nothing by that name: said so, with the words heard', (r => [r.matches.length, r.heard, r.named])(db().process('خلونا نرنم ترنيمة عظيم هو الرب إلهنا', 1)), [0, 'عظيم هو الرب الهنا', true]);
  eq('a word spelled a little differently still begins the title', (r => [ids(r), r.close])(db().process('خلونا نرنم مع بعض ترنيمة سألوذ بحضنك من جهدي', 1)), [['s12'], false]);
  eq('a word of the title heard as another word: the nearest, marked as that', (r => [ids(r), r.close, r.heard])(db().process('طب خلونا نرنم مع بعض ترنيمة مستحق كل المادة يا يسوع', 1)), [['s15'], true, 'مستحق كل الماده يا يسوع']);
  eq('… it says when the hymn was only mentioned (the console then leaves a near match out), and the first word must be right', [(r => [r.kind, r.close])(db().process('فيه ترنيمة بتقول مستحق كل المادة يا يسوع', 1)), ids(db().process('خلونا نرنم ترنيمة عظيم كل المادة يا يسوع', 1))], [['cue', true], []]);
  eq('a word said twice where the title has it three times, and two words heard as one: both songs, the nearer first (18 Nov)', (r => [ids(r), r.close])(db().process('يلا نرنم ترنيمه قدوس قدوس هات صوت الملائ', 1)), [['s17', 's16'], true]);
  eq('… «قدوس» said once, as Soniox heard it: that hymn first, not «صوت الملايكة بيقول ايه» (18 Nov)', ids(db().process('آه، نرنم ترنيمة قدوس، ها صوت الملائكة.', 1))[0], 's17');
  eq('no announcement: the database is not asked', [db().process('مالي سواك يا سيدي يسوع', 1), db().process('يا راويني يا يسوع بحنانك حياتي', 1)], [null, null]);
  eq('«يا رب» alone begins a hundred titles: not enough', ids(db().process('نرنم ونقول يا رب احنا محتاجينك', 1)), []);
  eq('the title in the next sentence', (() => { const d = db(); const a = d.process('تعالوا نقف ونرنم الترنيمة دي', 1); return [a, ids(d.process('علمني أنتظرك يا رب', 2))]; })(), [null, ['s5']]);
  eq('one announcement, one answer', (() => { const d = db(); d.process('خلونا نرنم ترنيمة مالي سواك يا سيدي', 1); return d.process('انت يا رب فرحة قلبي', 2); })(), null);
  eq('announced again within minutes: marked as a repeat', (() => { const d = db(); d.process('نرنم ترنيمة مالي سواك يا سيدي', 1000); return d.process('يلا نرنم ترنيمة مالي سواك يا سيدي', 9000).repeat; })(), true);
  eq('search box: words anywhere in the title, spelling evened out', db().search('مالى سواك').map(v => v.id), ['s1', 's2']);
  eq('search box: a word that sounds the same', db().search('الفخار الاعظم').map(v => v.id), ['s4']);
  eq('search box: nothing', db().search('كلام مش موجود').length, 0);
  // 26 Nov, a family trying the hymns: «ترنيمة» heard as other words, and names heard a word or two off
  {
    const more = titles.concat(['باركي يا نفسي الرب' + K, 'ما تعولش الهم وما تخافش' + K, 'على ضرب الأوتار بالهُتاف والتهليل' + K, 'مالناش غيرك انت' + K]);
    const db2 = () => new VE.SongIndex(more.map((t, i) => ({ id: 's' + (i + 1), title: t })));
    const id = t => 's' + (more.indexOf(t + K) + 1);
    const first = r => (r && r.matches.length ? r.matches[0].video.id : null);
    eq('Soniox wrote «تقريباً» for «ترنيمة»: a name said as it is written after it is the hymn', first(db2().process('تقريباً ما لناش غيرك أنت يا لهنا.', 1)), id('مالناش غيرك انت'));
    eq('… «تقريباً» in everyday words, or before a name heard differently, is nothing', [db2().process('هو تقريباً ما بقاش فيه حد خالص', 1), db2().process('تقريباً ما تقعدش ليه', 1)], [null, null]);
    eq('«ترنيمت على …» (the ة said as ت), and «ترميمت» as the local model heard it', [first(db2().process('ترنيمت على درب الأوطان', 1)), first(db2().process('ماشي هنحاول ترميمت على درب الأوتار', 1))],
      [id('على ضرب الأوتار بالهُتاف والتهليل'), id('على ضرب الأوتار بالهُتاف والتهليل')]);
    eq('«ترنيمة» right before a name heard a little off: the nearest, and it says so (the console shows it)', (r => [first(r), r.close, r.titled])(db2().process('ترنيمة باركي يا نفس الراب', 1)), [id('باركي يا نفسي الرب'), true, true]);
    eq('… but not a hymn quoted in passing («فيه ترنيمة بتقول …»)', db2().process('فيه ترنيمة بتقول مستحق كل المادة يا يسوع', 1).titled, false);
    eq('«لهم» for «الهم» (the article\'s alef swallowed)', first(db2().process('ترنيمة ما تقعدش لهم وما تخافش', 1)), id('ما تعولش الهم وما تخافش'));
  }
}

// ---- quote matching with a couple of real Van Dyke verses planted in the fake Bible
{
  const fb = fakeBible();
  fb.books[42][2][15] = 'لأنه هكذا أحب الله العالم حتى بذل ابنه الوحيد، لكي لا يهلك كل من يؤمن به، بل تكون له الحياة الأبدية.';
  fb.books[18][22][0] = 'الرب راعي فلا يعوزني شيء.';
  const qi = new VE.QuoteIndex();
  qi.add([43, 3, 16, fb.books[42][2][15]]);
  qi.add([19, 23, 1, fb.books[18][22][0]]);
  qi.add([1, 1, 1, 'في البدء خلق الله السموات والارض.']);
  qi.ready = true;
  const d = new VE.Detector(fb);
  d.setQuoteIndex(qi);
  eq('planted quote John', d.processFinal('زي ما الكتاب بيقول لأنه هكذا أحب الله العالم حتى بذل', 1000).map(c => c.labelEn + '|' + c.source), ['John 3:16|quote']);
  eq('planted quote Psalm', d.processFinal('الرب راعي فلا يعوزني', 2000).map(c => c.labelEn), ['Psalms 23:1']);
  eq('planted no false', d.processFinal('الله بيحب العالم كله والناس كلها', 3000).length, 0);
}

// ---- English quotes (real KJV + a few World English Bible verses planted in a copy)
const kjvPath = path.join(__dirname, '..', 'data', 'en_kjv.json');
const arPath = path.join(__dirname, '..', 'data', 'ar_svd.json');
if (fs.existsSync(kjvPath) && fs.existsSync(arPath)) {
  const kjv = new VE.Bible(JSON.parse(fs.readFileSync(kjvPath, 'utf8').replace(/^﻿/, '')));
  const web = new VE.Bible(JSON.parse(fs.readFileSync(kjvPath, 'utf8').replace(/^﻿/, '')));
  const plant = (b, c, v, t) => { web.books[b - 1][c - 1][v - 1] = t; };
  plant(47, 5, 21, 'For him who knew no sin he made to be sin on our behalf; so that in him we might become the righteousness of God.');
  plant(43, 3, 16, 'For God so loved the world, that he gave his one and only Son, that whoever believes in him should not perish, but have eternal life.');
  plant(24, 29, 11, 'For I know the thoughts that I think toward you,” says Yahweh, “thoughts of peace, and not of evil, to give you hope and a future.');
  const arB = new VE.Bible(JSON.parse(fs.readFileSync(arPath, 'utf8').replace(/^﻿/, '')));
  const qEn = new VE.QuoteIndex({ tokenize: VE.enTokens });
  const qKjvOnly = new VE.QuoteIndex({ tokenize: VE.enTokens });
  const pending = Promise.all([qEn.build([kjv, web], 1e9), qKjvOnly.build(kjv, 1e9)]).then(() => {
    const say = (idx, lines) => {
      const d = new VE.Detector(arB, { quotes: true });
      d.setEnglishQuoteIndex(idx);
      let t = 1000; const out = [];
      for (const l of [].concat(lines)) { t += 3000; for (const c of d.processFinal(l, t)) out.push(`${c.labelEn}|${c.source}|${c.lang}`); }
      return out;
    };
    eq('EN quote: user example (modern wording)', say(qEn, 'he became sin for us so that we might become the righteousness of God'), ['2 Corinthians 5:21|quote|en']);
    eq('EN quote: KJV wording', say(qEn, 'for God so loved the world that he gave his only begotten son'), ['John 3:16|quote|en']);
    eq('EN quote: NIV-style wording', say(qEn, 'God so loved the world that he gave his one and only son'), ['John 3:16|quote|en']);
    eq('EN quote: Philippians 4:13', say(qEn, 'I can do all things through Christ who strengthens me'), ['Philippians 4:13|quote|en']);
    eq('EN quote: Romans 8:28', say(qEn, 'and we know that all things work together for good to them that love God'), ['Romans 8:28|quote|en']);
    eq('EN quote: Yahweh = the Lord', say(qEn, 'for I know the thoughts that I think toward you says the Lord thoughts of peace'), ['Jeremiah 29:11|quote|en']);
    eq('EN quote across two sentences', say(qEn, ['the Lord is my shepherd', 'I shall not want']), ['Psalms 23:1|quote|en']);
    eq('EN ordinary sermon talk', say(qEn, ['good morning church it is so good to see everyone today', "let's open our Bibles and pray together",
      'God loves you and he has a plan for your life', 'the love of God is amazing', 'we are going to talk about faith today',
      'in the name of the Father and of the Son and of the Holy Spirit amen']), []);
    eq('EN reference spoken in English is flagged English', say(qEn, 'turn to Romans 8 28'), ['Romans 8:28|reference|en']);
  });
  pendingTests.push(pending);
} else console.log('(skipping English quote tests: data/en_kjv.json or data/ar_svd.json not present)');

// ---- quote matching against the real Bible when available
const real = path.join(__dirname, '..', 'data', 'ar_svd.json');
if (fs.existsSync(real)) {
  const raw = JSON.parse(fs.readFileSync(real, 'utf8').replace(/^﻿/, ''));
  const rb = new VE.Bible(raw);
  eq('real John 3:16 exists', !!rb.verse(43, 3, 16), true);
  const qi = new VE.QuoteIndex();
  const t0 = Date.now();
  qi.build(rb, 1e9).then(() => {
    console.log(`quote index: ${qi.size} trigrams, built in ${Date.now() - t0} ms`);
    const d = new VE.Detector(rb);
    d.setQuoteIndex(qi);
    const r = d.processFinal('زي ما الكتاب بيقول لأنه هكذا أحب الله العالم حتى بذل ابنه الوحيد', 1000);
    eq('quote John 3:16', r.map(c => c.labelEn + '|' + c.source), ['John 3:16|quote']);
    const r2 = d.processFinal('الرب راعي فلا يعوزني شيء', 2000);
    eq('quote Psalm 23:1', r2.map(c => c.labelEn), ['Psalms 23:1']);
    const r3 = d.processFinal('النهارده الجو حلو والناس كلها جت الكنيسة بدري', 3000);
    eq('no false quote', r3.length, 0);
    done();
  });
} else { console.log('(skipping real-Bible quote tests: data/ar_svd.json not present)'); done(); }

function done() {
  if (pendingTests.length) { const p = pendingTests.splice(0); return Promise.all(p).then(done); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
