// Run: node test/detect.test.js
// Version 3 detection: what the local speech engine (Cohere Transcribe Arabic) actually writes, misheard
// book names / chapter words / numbers, forgiving quote matching, following the reading, hymn titles.
// Uses the real Bible in data\ when it is there (it is after the first start).
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
const refs = text => new VE.Detector(bible, { quotes: false }).processFinal(text, 1000).map(c => c.labelEn);

// ---- numbers as Egyptian speakers say them and speech engines write them
const num = s => { const r = VE.parseNumber(VE.tokenize(s), 0); return r && r.value; };
eq('استاشر = 16', num('استاشر'), 16);
eq('تناشر = 12', num('تناشر'), 12);
eq('تلاتاشر = 13', num('تلاتاشر'), 13);
eq('a sound added at the end: الخامسي', num('الخامسي'), 5);
eq('Arabic-Indic digits', refs('إنجيل يوحنا الإصحاح التالت والعدد ١٦'), ['John 3:16']);

// ---- book names and chapter words a little misheard
eq('يوحن (dropped alef)', refs('من إنجيل يوحن الإصحاح الثالث والعدد استاشر'), ['John 3:16']);
eq('يومية for رومية, after رسالة', refs('افتحوا معي رسالة يومية الإصحاح الثامن من عدد 28 لعدد 30'), ['Romans 8:28-30']);
eq('كوريثوس for كورنثوس', refs('في رسالة كوريثوس الأولى الاصحاح 13 عدد 4'), ['1 Corinthians 13:4']);
eq('كورينثوس', refs('في رسالة كورينثوس الأولى الإصحاحة تلتاشر عدد أربعة'), ['1 Corinthians 13:4']);
eq('الإرمياء', refs('وفي سفر الإرمياء إصحاح 29 عدد 11'), ['Jeremiah 29:11']);
eq('ارميه', refs('وفي سفر ارميه الاصحاح 29 عدد 11'), ['Jeremiah 29:11']);
eq('رسالة يوحن الأولى', refs('رسالة يوحن الأولى الإصحاح الأول عدد تسعة'), ['1 John 1:9']);
eq('chapter word misheard: الاسحاق', refs('سفر الأعمال الاسحاق التاني عدد 38'), ['Acts 2:38']);
eq('chapter word misheard: اصحاحا', refs('إنجيل لوقا اصحاحا خمسة عشر'), ['Luke 15']);
eq('verse word misheard: وعدده', refs('سفر الأعمال الاصحاح التاني وعدده 38'), ['Acts 2:38']);
// … but not when the words around it don't say it's a book
eq('«إنجيل مثل» is not Proverbs (a Gospel was said)', refs('إنجيل مثل الإصحاح الخامس من عدد ثلاثة'), []);
eq('everyday «يومية» is not Romans', refs('عايز اقولكم حاجة يومية بسيطة 3 مرات'), []);
eq('«يسوع قال الاصحاح» is not a reference', refs('يسوع قال الاصحاح ده'), []);
eq('Isaac is not «الأصحاح» in a sentence', refs('قصة اسحاق 3 مرات في الكتاب'), []);

// ---- book names with nothing around them to say so: believed only as far as what follows allows
const refsQ = (...texts) => { const d = new VE.Detector(bible, { quotes: false }); let t = 1000; const out = []; for (const x of texts) { for (const c of d.processFinal(x, t)) out.push(c.labelEn + (c.probable ? '?' : '')); t += 3000; } return out; };
eq('«شوية صفحة» is not Revelation', refsQ('سفري شوية صفحة ١٢'), []);
eq('«شوية الاصحاح التاني», then «العدد الخامس»: no Revelation 2:5', refsQ('عايز اتكلم شوية الاصحاح التاني', 'العدد الخامس بيقول كده'), []);
eq('but «رؤيا 3 20» is', refsQ('رؤيا 3 20'), ['Revelation 3:20']);
eq('«لحبقوك 3 17»: a joined-on ل, one letter out, chapter and verse at once', refsQ('ارجع معايا لحبقوك 3 17'), ['Habakkuk 3:17']);
eq('«حبقوق 317»: chapter and verse written as one number', refsQ('حبقوق 317'), ['Habakkuk 3:17']);
eq('«يوحنا 316»', refsQ('يوحنا 316'), ['John 3:16']);
eq('«مزمور 1191» = 119:1', refsQ('مزمور 1191'), ['Psalms 119:1']);
eq('«مزمور 911» can be read two ways: a guess', refsQ('مزمور 911'), ['Psalms 9:11?']);
eq('«نحوم واحد واحد»: Nahum, not Nehemiah', refsQ('نحوم واحد واحد'), ['Nahum 1:1']);
eq('«يومية 8 28» with chapter and verse at once', refsQ('يومية 8 28'), ['Romans 8:28']);
eq('«مضمون 46» (مزمور, as the model on this PC writes it): a guess', refsQ('يقول كده مضمون 46 الله أنا ملجأ'), ['Psalms 46?']);
eq('everyday «مضمون واحد» is nothing', refsQ('مضمون واحد على روايح'), []);
eq('«الصومين الأول إصحاح ٣ وعدد ١»: a numbered book, guessed', refsQ('في الصومين الأول إصحاح ثلاثة وعدد واحد'), ['1 Samuel 3:1?']);
eq('… and a verse number after a guess is a guess too', refsQ('في الصومين الأول إصحاح ثلاثة وعدد واحد', 'وهناخد بعد كدة عدد تلاتة'), ['1 Samuel 3:1?', '1 Samuel 3:3?']);
eq('«يوحان أسحاح أربعة»: John (same consonants), not Jonah', refsQ('من إنجليم يوحان أسحاح أربعة'), ['John 4?']);
eq('a guess does not take over the chapter being preached', refsQ('انجيل يوحنا الاصحاح 3', 'لما خرج الاصحاح 3 بيقول', 'عدد 5 بيقول'), ['John 3', 'Exodus 3?', 'John 3:5']);
for (const t of ['الساعه 6:00', 'نمره 2', 'يلا اول واحده', 'ذكر 3 4 حاجات', 'تكون 3 45', 'غلط 3 4', 'الجزء الاول الاصحاح 3', 'عايز اقولكم حاجة يومية بسيطة 3 مرات'])
  eq('not a reference: ' + t, refsQ(t), []);

// ---- ranges
eq('range end heard as a unit: لعدد ٣ after ٢٨ = ٣٠', refs('رومية الإصحاح ٨ من عدد ٢٨ لعدد ٣'), ['Romans 8:28-30']);
eq('a range end never becomes a reference of its own', refs('رومية ٨ من عدد ٢٨ لعدد ٢'), ['Romans 8:28']);

// ---- spoken navigation as speech engines write it
eq('«العدد لي بعده»', VE.detectNav('العدد لي بعده بيقول المحبة تتأنى'), 'next');

// ---- hymn titles from the church's playlist (real titles)
const vids = [
  ['c_jSr232q1U', 'سلامك فاق العقول- موسيقى وكلمات'], ['7UypfTv1IpQ', 'مالي سواك يا سيدي- ترانيم كلمة ولحن'],
  ['NMAKAAkUIqs', 'ترنيمة يسوع بيدور عليا _ CTV'], ['eVLmy6joMR8', 'موسيقى يسوع بيدور'], ['l9SNaHEz6BI', 'موسيقي كل يوم تحت صليبك.wmv'],
  ['Mj8Z_h0-UGs', 'ما يحسن في عينيك (يا شاريني بالدم الغالي)- ترانيم كلمة ولحن'], ['SA7BwrFk-WA', 'ترنيمة ربي يسوع الغالي- ترانيم كلمة ولحن'],
  ['MKSb9snLVyg', 'سألوذ بحضنك- ترانيم كلمة ولحن'], ['xJqHgQzzYws', 'ترنيمة  يا صاحب الحنان (موسيقي)'], ['-uDe9MUqMGM', 'دقي دقي يا اجراس (ليلة عيد)- ترانيم كلمة ولحن'],
].map(([id, title]) => ({ id, title }));
const hit = text => new VE.VideoMatcher(vids).process(text, 1000).map(m => m.video.id);
eq('title with "- موسيقى وكلمات" glued on', hit('يلا نرنم مع بعض ترنيمة سلامك فاق العقول'), ['c_jSr232q1U']);
eq('title with "- ترانيم كلمة ولحن"', hit('هنرنم دلوقتي ترنيمة مالي سواك يا سيدي'), ['7UypfTv1IpQ']);
eq('cue misheard: ترنيمت', hit('حين نمو دلوقتي ترنيمت مالي سواك يا سيدي'), ['7UypfTv1IpQ']);
eq('the full title wins over a shorter one inside it', hit('هنشوف فيديو ترنيمة يسوع بيدور عليا'), ['NMAKAAkUIqs']);
eq('file name used as a title (.wmv)', hit('تعالوا نسمع ترنيمة كل يوم تحت صليبك'), ['l9SNaHEz6BI']);
eq('the other name in brackets', hit('نرنم ترنيمة يا شاريني بالدم الغالي'), ['Mj8Z_h0-UGs']);
eq('short title still needs a cue word', hit('سألوذ بحضنك يا رب'), []);
eq('short title with a cue word', hit('نرنم سألوذ بحضنك'), ['MKSb9snLVyg']);
eq('"(موسيقي)" in brackets is not a title', new VE.VideoMatcher(vids).phrasesFor('xJqHgQzzYws'), ['يا صاحب الحنان']);

// ---- forgiving quote matching, and following the reading
(async () => {
  const fi = new VE.FuzzyQuoteIndex(); await fi.build(bible, 1e9);
  const qi = new VE.QuoteIndex(); await qi.build(bible, 1e9);
  const quote = text => { const d = new VE.Detector(bible); d.setQuoteIndex(qi); d.setFuzzyQuoteIndex(fi); return d.processFinal(text, 1000).map(c => c.labelEn); };
  eq('quote with misheard words (John 3:16)', quote('زي ما بيقول الكتاب في أنه هكذا أحبب له العالم حسب بدء ابنه الوحيد'), ['John 3:16']);
  eq('colloquial quote (Matthew 11:28)', quote('تعالوا الي يا جميع المتعبين والتقيلين الاحمال وانا اريحكو'), ['Matthew 11:28']);
  eq('quote of Romans 8:28 said loosely', quote('ونحن نعلم ان كل الاشيا تعمل مع للخير للي بيحبوا الله'), ['Romans 8:28']);
  const quoteCard = text => { const d = new VE.Detector(bible); d.setQuoteIndex(qi); d.setFuzzyQuoteIndex(fi); return d.processFinal(text, 1000)[0]; };
  eq('parallel passages: the best one, with the others offered', (c => !!c && c.source === 'quote' && (c.alsoIn || []).length > 0)(quoteCard('ثقي يا ابنتي ايمانك قد شفاك')), true);
  eq('... but the words that only one of them has decide it', quoteCard('ثقي يا ابنتي ايمانك قد شفاك اذهبي بسلام').labelEn, 'Luke 8:48');
  // ---- set prayers and formulas (Settings -> Set prayers): said every week, not quotations
  const said = (...texts) => { const d = new VE.Detector(bible); d.setQuoteIndex(qi); d.setFuzzyQuoteIndex(fi); d.setContext(43, 4, 0); let t = 1000; const out = [];
    for (const x of texts) { for (const c of d.processFinal(x, t)) out.push(c.labelEn + (c.source === 'phrase' ? (c.cardOnly ? ' [card]' : ' [show]') : '')); t += 3000; } return out; };
  eq('the Trinitarian formula is not Matthew 28:19', said('باسم الآب والابن والروح القدس الإله الواحد آمين'), []);
  eq('… misheard («اروح القدس»), after a reference', said('اربعه وعدد ثلاثه باسم الاب والابن اروح القدس الاله الواحد'), ['John 4:3']);
  eq('… «الروح القدوس»', said('باسم الآب والإبن والروح القدوس الإله الواحد آمين'), []);
  eq('… split over two sentences', said('انجيل يوحنا اصحاح اربعه وعدد ثلاثه باسم الاب والابن', 'والروح القدس الاله الواحد امين'), ['John 4:3']);
  eq('the doxology is not Jude 1:25', said('المجد للآب والابن والروح القدس الآن وكل أوان وإلى دهر الداهرين آمين'), []);
  eq('a real quote of the Great Commission is still found', said('يسوع قال لتلاميذه فاذهبوا وتلمذوا جميع الامم وعمدوهم باسم الاب والابن والروح القدس'), ['Matthew 28:19']);
  eq("the Lord's Prayer is its passage, not Luke 11:2", said('أبانا الذي في السماوات ليتقدس اسمك ليأت ملكوتك'), ['Matthew 6:9-13 [show]']);
  eq('the benediction: a card for its verse', said('نعمة ربنا يسوع المسيح ومحبة الله وشركة الروح القدس مع جميعكم آمين'), ['2 Corinthians 13:14 [card]']);
  eq('«قدوس قدوس قدوس رب الجنود»: a card for its verse', said('قدوس قدوس قدوس رب الجنود مجده ملء كل الارض'), ['Isaiah 6:3 [card]']);
  eq('the formula in English', said('in the name of the Father and of the Son and of the Holy Spirit amen'), []);
  eq('"in the name of the Lord" is not the formula', said('in the name of the Lord we pray today for all of the people'), []);
  const own = new VE.Detector(bible, { phrases: [{ text: 'الرب راعي فلا يعوزني شيء', action: 'ignore' }] }); own.setQuoteIndex(qi); own.setFuzzyQuoteIndex(fi);
  eq("a phrase of the church's own, set to Ignore", own.processFinal('الرب راعي فلا يعوزني شيء', 1000).map(c => c.labelEn), []);
  own.setPhrases([{ text: 'الرب راعي فلا يعوزني شيء', action: 'ignore', off: true }]);
  eq('… and turned off again', own.processFinal('الرب راعي فلا يعوزني شيء', 200000).map(c => c.labelEn), ['Psalms 23:1']);

  for (const t of ['النهارده هنتكلم عن موضوع مهم جدا في حياتنا كلنا وهو موضوع الايمان والثقه في ربنا',
    'احنا محتاجين نصلي اكتر ونقرا الكتاب المقدس كل يوم في البيت مع ولادنا',
    'خلونا نقف ونصلي مع بعض ونشكر ربنا على كل اللي عمله معانا الاسبوع ده',
    'كل سنه وانتم طيبين وعيد سعيد على الكنيسه كلها']) eq('no quote in ordinary talk: ' + t.slice(0, 30), quote(t), []);

  // the reader goes on from Romans 8:28 into 8:29
  const idf = t => Math.min(6, fi.idf(t));
  const spoken = VE.qtokens('لان الذين سبق فعرفهم سبق فعينهم ليكونوا مشابهين صورة ابنه');
  const next = VE.verseSimilarity(spoken, bible.verse(45, 8, 29), idf), cur = VE.verseSimilarity(spoken, bible.verse(45, 8, 28), idf);
  eq('reading the next verse is recognized', next.n >= 4 && next.startsAt <= 2 && next.score > cur.score * 1.15, true);
  const talk = VE.qtokens('يعني ربنا بيخلي كل حاجة تعمل للخير حتى الحاجات الصعبة');
  const t2 = VE.verseSimilarity(talk, bible.verse(45, 8, 29), idf);
  eq('talking about the verse is not reading the next one', t2.n >= 4 && t2.startsAt <= 2, false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
