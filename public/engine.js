/*
 * VerseEngine — Arabic Bible reference detection.
 * Works in the browser (window.VerseEngine) and in Node (require('./engine.js')).
 *
 * Pieces:
 *   normalize()/tokenize()  – Arabic text cleanup (tashkeel, hamza forms, digits, prefixes)
 *   parseNumber()           – Arabic number words (cardinal, ordinal, Egyptian colloquial) -> int
 *   findRefs()              – book + chapter + verse patterns, in both orders
 *   Bible                   – verse lookup
 *   QuoteIndex              – finds verses the speaker quotes without naming them
 *   Detector                – streaming wrapper: final/interim text in, de-duplicated candidates out
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VerseEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------
  // Normalization
  // ------------------------------------------------------------------
  const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
  const BIDI = /[​-‏‪-‮⁦-⁩﻿]/g;

  function normalize(s) {
    if (!s) return '';
    s = String(s).replace(BIDI, '');
    if (/[ﭐ-﷿ﹰ-﻾]/.test(s)) s = s.normalize('NFKC');   // Arabic presentation forms (ﻻ, ﷲ …)
    s = s.replace(DIACRITICS, '');
    s = s.replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
         .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
         .replace(/[یۍېێ]/g, 'ي').replace(/[کڪ]/g, 'ك').replace(/[ہەۀۃ]/g, 'ه');   // Persian/Urdu letter forms used in some titles
    s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
         .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));
    s = s.toLowerCase();
    s = s.replace(/(\d)\s*[-–—]\s*(\d)/g, '$1 الي $2');   // 16-18  -> 16 الي 18
    s = s.replace(/(\d)\s*[:：.٫]\s*(\d)/g, '$1 $2');       // 3:16   -> 3 16
    s = s.replace(/(\d)([^\d\s])/g, '$1 $2').replace(/([^\d\s])(\d)/g, '$1 $2');
    s = s.replace(/[^ء-يa-z0-9\s]/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  function cleanVerse(s) {
    return String(s || '').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  }

  // Remove harakat (tashkeel) but keep the letters and hamza forms; alef wasla -> alef.
  const HARAKAT = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g;
  function stripTashkeel(s) {
    return String(s || '').replace(HARAKAT, '').replace(/\u0671/g, 'ا');
  }

  // Known defects in some copies of the Van Dyke text.
  const VERSE_PATCHES = {
    '64:1:1': 'اَلشَّيْخُ، إِلَى غَايُسَ ٱلْحَبِيبِ ٱلَّذِي أَنَا أُحِبُّهُ بِٱلْحَقِّ.',
  };

  function toArabicDigits(n) {
    return String(n).replace(/\d/g, d => '٠١٢٣٤٥٦٧٨٩'[d]);
  }

  // ------------------------------------------------------------------
  // Numbers
  // ------------------------------------------------------------------
  const UNITS = {
    'واحد': 1, 'واحده': 1, 'احد': 1, 'احدي': 1, 'حادي': 1, 'حاديه': 1, 'اول': 1, 'اولي': 1,
    'اثنين': 2, 'اثنان': 2, 'اتنين': 2, 'اثنتين': 2, 'اثنتان': 2, 'اثنا': 2, 'اثني': 2, 'اثنتا': 2, 'اثنتي': 2,
    'ثاني': 2, 'ثانيه': 2, 'تاني': 2, 'تانيه': 2,
    'ثلاثه': 3, 'ثلاث': 3, 'تلاته': 3, 'تلات': 3, 'ثالث': 3, 'ثالثه': 3, 'تالت': 3, 'تالته': 3,
    'اربعه': 4, 'اربع': 4, 'رابع': 4, 'رابعه': 4,
    'خمسه': 5, 'خمس': 5, 'خامس': 5, 'خامسه': 5,
    'سته': 6, 'ست': 6, 'سادس': 6, 'سادسه': 6,
    'سبعه': 7, 'سبع': 7, 'سابع': 7, 'سابعه': 7,
    'ثمانيه': 8, 'ثماني': 8, 'ثمان': 8, 'تمانيه': 8, 'تمنيه': 8, 'تمان': 8, 'ثامن': 8, 'ثامنه': 8, 'تامن': 8, 'تامنه': 8,
    'تسعه': 9, 'تسع': 9, 'تاسع': 9, 'تاسعه': 9,
  };
  const TEN_WORDS = { 'عشره': 10, 'عشر': 10, 'عاشر': 10, 'عاشره': 10 };
  const TEENS = {
    'حداشر': 11, 'احداشر': 11, 'حدشر': 11, 'اتناشر': 12, 'اطناشر': 12, 'تناشر': 12, 'طناشر': 12, 'اتنشر': 12,
    'تلتاشر': 13, 'تلطاشر': 13, 'تلاتاشر': 13, 'تلاتطاشر': 13, 'تلتشر': 13,
    'اربعتاشر': 14, 'اربعطاشر': 14, 'اربعتشر': 14, 'خمستاشر': 15, 'خمسطاشر': 15, 'خمستشر': 15,
    'ستاشر': 16, 'سطاشر': 16, 'استاشر': 16, 'اسطاشر': 16, 'ستشر': 16,
    'سبعتاشر': 17, 'سبعطاشر': 17, 'سبعتشر': 17, 'تمنتاشر': 18, 'تمنطاشر': 18, 'تمانتاشر': 18, 'تمنتشر': 18,
    'تسعتاشر': 19, 'تسعطاشر': 19, 'تسعتشر': 19,
  };
  const TENS = {
    'عشرين': 20, 'عشرون': 20, 'ثلاثين': 30, 'ثلاثون': 30, 'تلاتين': 30,
    'اربعين': 40, 'اربعون': 40, 'خمسين': 50, 'خمسون': 50, 'ستين': 60, 'ستون': 60,
    'سبعين': 70, 'سبعون': 70, 'ثمانين': 80, 'ثمانون': 80, 'تمانين': 80, 'تسعين': 90, 'تسعون': 90,
  };
  const HUNDRED = new Set(['ميه', 'مايه']);

  function lex1(c) {
    if (c in UNITS) return { k: 'u', v: UNITS[c] };
    if (c in TEN_WORDS) return { k: 't10', v: 10 };
    if (c in TEENS) return { k: 'teen', v: TEENS[c] };
    if (c in TENS) return { k: 'tens', v: TENS[c] };
    if (HUNDRED.has(c)) return { k: 'h', v: 100 };
    return null;
  }
  function lex(tok) {
    if (tok == null) return null;
    if (/^\d+$/.test(tok)) return { k: 'd', v: parseInt(tok, 10) };
    const cands = tok.startsWith('ال') ? [tok, tok.slice(2)] : [tok];
    for (const c of cands) { const r = lex1(c); if (r) return r; }
    // speech engines add a sound at the end of a number now and then: "الخامسي", "ستاشره", "تلاتين"+"ا"
    for (const c of cands) {
      if (c.length >= 4 && /[يها]$/.test(c)) { const r = lex1(c.slice(0, -1)); if (r && r.k !== 'h' && !(r.k === 'u' && c.endsWith('ا'))) return r; }
    }
    return null;
  }

  function parseBelow100(t, i) {
    const a = lex(t[i]);
    if (!a || a.k === 'h' || a.k === 'd') return null;
    if (a.k !== 'u') return { value: a.v, end: i + 1 };
    const nx = t[i + 1] ? t[i + 1].replace(/^ال/, '') : '';
    if (nx === 'عشر' || nx === 'عشره') return { value: 10 + a.v, end: i + 2 };
    if (t[i + 1] === 'و' && t[i + 2]) {
      const b = lex(t[i + 2]);
      if (b && b.k === 'tens') return { value: a.v + b.v, end: i + 3 };
    }
    return { value: a.v, end: i + 1 };
  }

  // English: "sixteen", "twenty eight", "one hundred (and) nineteen", "third"
  const EN_UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
  const EN_TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
    sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19 };
  const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50 };
  function parseEnNumber(t, i) {
    let j = i, val = 0, any = false;
    if ((EN_UNITS[t[j]] || t[j] === 'a') && t[j + 1] === 'hundred') { val = (EN_UNITS[t[j]] || 1) * 100; j += 2; any = true; }
    else if (t[j] === 'hundred') { val = 100; j++; any = true; }
    if (any && t[j] === 'and' && (t[j + 1] in EN_UNITS || t[j + 1] in EN_TEENS || t[j + 1] in EN_TENS)) j++;
    if (t[j] in EN_TEENS) return { value: val + EN_TEENS[t[j]], end: j + 1 };
    if (t[j] in EN_TENS) {
      val += EN_TENS[t[j]]; j++;
      if (t[j] in EN_UNITS) { val += EN_UNITS[t[j]]; j++; }
      return { value: val, end: j };
    }
    if (t[j] in EN_UNITS) return { value: val + EN_UNITS[t[j]], end: j + 1 };
    return any ? { value: val, end: j } : null;
  }

  function parseNumber(t, i) {
    if (t[i] && /^[a-z]+$/.test(t[i])) return parseEnNumber(t, i);
    const a = lex(t[i]);
    if (!a) return null;
    if (a.k === 'd') return { value: a.v, end: i + 1 };
    if (a.k === 'h') {
      let val = 100, end = i + 1, j = end;
      if (t[j] === 'و') j++;
      const rest = parseBelow100(t, j);
      if (rest) { val += rest.value; end = rest.end; }
      return { value: val, end };
    }
    return parseBelow100(t, i);
  }

  // ------------------------------------------------------------------
  // Books
  // ------------------------------------------------------------------
  // [number, English name, Arabic display name, Arabic aliases, English aliases]
  const BOOK_DEFS = [
    [1, 'Genesis', 'التكوين', ['التكوين', 'تكوين'], ['genesis', 'gen']],
    [2, 'Exodus', 'الخروج', ['الخروج', 'خروج'], ['exodus', 'exod', 'exo']],
    [3, 'Leviticus', 'اللاويين', ['اللاويين', 'لاويين', 'اللاويون'], ['leviticus', 'lev']],
    [4, 'Numbers', 'العدد', ['سفر العدد'], ['numbers', 'num']],
    [5, 'Deuteronomy', 'التثنية', ['التثنية', 'تثنية'], ['deuteronomy', 'deut', 'dt']],
    [6, 'Joshua', 'يشوع', ['يشوع'], ['joshua', 'josh']],
    [7, 'Judges', 'القضاة', ['القضاة', 'قضاة'], ['judges', 'judg']],
    [8, 'Ruth', 'راعوث', ['راعوث'], ['ruth']],
    [9, '1 Samuel', 'صموئيل الأول', [], ['1 samuel', '1 sam']],
    [10, '2 Samuel', 'صموئيل الثاني', [], ['2 samuel', '2 sam']],
    [11, '1 Kings', 'الملوك الأول', [], ['1 kings', '1 kgs']],
    [12, '2 Kings', 'الملوك الثاني', [], ['2 kings', '2 kgs']],
    [13, '1 Chronicles', 'أخبار الأيام الأول', [], ['1 chronicles', '1 chron', '1 chr']],
    [14, '2 Chronicles', 'أخبار الأيام الثاني', [], ['2 chronicles', '2 chron', '2 chr']],
    [15, 'Ezra', 'عزرا', ['عزرا'], ['ezra']],
    [16, 'Nehemiah', 'نحميا', ['نحميا'], ['nehemiah', 'neh']],
    [17, 'Esther', 'أستير', ['أستير'], ['esther', 'esth']],
    [18, 'Job', 'أيوب', ['أيوب'], ['job']],
    [19, 'Psalms', 'المزامير', ['المزامير', 'مزامير', 'مزمور', 'المزمور'], ['psalms', 'psalm', 'psa', 'ps']],
    [20, 'Proverbs', 'الأمثال', ['الأمثال', 'أمثال'], ['proverbs', 'prov']],
    [21, 'Ecclesiastes', 'الجامعة', ['الجامعة', 'جامعة'], ['ecclesiastes', 'eccl', 'ecc']],
    [22, 'Song of Solomon', 'نشيد الأنشاد', ['نشيد الأنشاد'], ['song of solomon', 'song of songs', 'songs']],
    [23, 'Isaiah', 'إشعياء', ['إشعياء', 'إشعيا'], ['isaiah', 'isa']],
    [24, 'Jeremiah', 'إرميا', ['إرميا', 'إرمياء'], ['jeremiah', 'jer']],
    [25, 'Lamentations', 'مراثي إرميا', ['مراثي إرميا', 'مراثي', 'المراثي'], ['lamentations', 'lam']],
    [26, 'Ezekiel', 'حزقيال', ['حزقيال'], ['ezekiel', 'ezek']],
    [27, 'Daniel', 'دانيال', ['دانيال'], ['daniel', 'dan']],
    [28, 'Hosea', 'هوشع', ['هوشع'], ['hosea', 'hos']],
    [29, 'Joel', 'يوئيل', ['يوئيل'], ['joel']],
    [30, 'Amos', 'عاموس', ['عاموس'], ['amos']],
    [31, 'Obadiah', 'عوبديا', ['عوبديا'], ['obadiah', 'obad']],
    [32, 'Jonah', 'يونان', ['يونان'], ['jonah']],
    [33, 'Micah', 'ميخا', ['ميخا'], ['micah', 'mic']],
    [34, 'Nahum', 'ناحوم', ['ناحوم'], ['nahum', 'nah']],
    [35, 'Habakkuk', 'حبقوق', ['حبقوق'], ['habakkuk', 'hab']],
    [36, 'Zephaniah', 'صفنيا', ['صفنيا'], ['zephaniah', 'zeph']],
    [37, 'Haggai', 'حجي', ['حجي'], ['haggai', 'hag']],
    [38, 'Zechariah', 'زكريا', ['زكريا'], ['zechariah', 'zech']],
    [39, 'Malachi', 'ملاخي', ['ملاخي'], ['malachi', 'mal']],
    [40, 'Matthew', 'متى', ['متى'], ['matthew', 'matt', 'mt']],
    [41, 'Mark', 'مرقس', ['مرقس', 'مرقص'], ['mark', 'mk']],
    [42, 'Luke', 'لوقا', ['لوقا'], ['luke', 'lk']],
    [43, 'John', 'يوحنا', [], ['john', 'jn', 'jean']],          // ("Jean 3:15": Soniox's spelling of "John")
    [44, 'Acts', 'أعمال الرسل', ['أعمال الرسل', 'سفر الأعمال', 'الأعمال', 'أعمال'], ['acts']],
    [45, 'Romans', 'رومية', ['رومية', 'رومة'], ['romans', 'rom']],
    [46, '1 Corinthians', 'كورنثوس الأولى', [], ['1 corinthians', '1 cor']],
    [47, '2 Corinthians', 'كورنثوس الثانية', [], ['2 corinthians', '2 cor']],
    [48, 'Galatians', 'غلاطية', ['غلاطية'], ['galatians', 'gal']],
    [49, 'Ephesians', 'أفسس', ['أفسس'], ['ephesians', 'eph']],
    [50, 'Philippians', 'فيلبي', ['فيلبي', 'فيليبي', 'فلبي', 'فليبي', 'فليب', 'فيليب'], ['philippians', 'phil']],   // («فليب ٤»: as it is often heard)
    [51, 'Colossians', 'كولوسي', ['كولوسي'], ['colossians', 'col']],
    [52, '1 Thessalonians', 'تسالونيكي الأولى', [], ['1 thessalonians', '1 thess']],
    [53, '2 Thessalonians', 'تسالونيكي الثانية', [], ['2 thessalonians', '2 thess']],
    [54, '1 Timothy', 'تيموثاوس الأولى', [], ['1 timothy', '1 tim']],
    [55, '2 Timothy', 'تيموثاوس الثانية', [], ['2 timothy', '2 tim']],
    [56, 'Titus', 'تيطس', ['تيطس'], ['titus']],
    [57, 'Philemon', 'فليمون', ['فليمون'], ['philemon', 'phlm']],
    [58, 'Hebrews', 'العبرانيين', ['العبرانيين', 'عبرانيين'], ['hebrews', 'heb']],
    [59, 'James', 'يعقوب', ['يعقوب'], ['james', 'jas']],
    [60, '1 Peter', 'بطرس الأولى', [], ['1 peter', '1 pet']],
    [61, '2 Peter', 'بطرس الثانية', [], ['2 peter', '2 pet']],
    [62, '1 John', 'يوحنا الأولى', [], ['1 john', '1 jn']],
    [63, '2 John', 'يوحنا الثانية', [], ['2 john', '2 jn']],
    [64, '3 John', 'يوحنا الثالثة', [], ['3 john', '3 jn']],
    [65, 'Jude', 'يهوذا', ['يهوذا'], ['jude']],
    [66, 'Revelation', 'الرؤيا', ['الرؤيا', 'رؤيا', 'سفر الرؤيا', 'رؤيا يوحنا', 'الرؤية', 'سفر الرؤية'], ['revelation', 'revelations', 'rev']],
  ];

  // Books that share a base name and need "first/second/third" to tell apart.
  const NUMBERED = [
    { base: ['صموئيل'], map: { 1: 9, 2: 10 } },
    { base: ['الملوك', 'ملوك'], map: { 1: 11, 2: 12 } },
    { base: ['أخبار الأيام', 'أخبار أيام'], map: { 1: 13, 2: 14 } },
    { base: ['كورنثوس', 'كورنتوس', 'كورونثوس'], map: { 1: 46, 2: 47 } },
    { base: ['تسالونيكي'], map: { 1: 52, 2: 53 } },
    { base: ['تيموثاوس', 'تيموثاوث', 'تيموثيئوس'], map: { 1: 54, 2: 55 } },
    { base: ['بطرس'], map: { 1: 60, 2: 61 } },
    { base: ['يوحنا'], map: { 1: 62, 2: 63, 3: 64 }, fallback: 43 },
  ];

  const SINGLE_CHAPTER = new Set([31, 57, 63, 64, 65]);

  const ORDINAL_WORDS = {
    'اول': 1, 'الاول': 1, 'اولي': 1, 'الاولي': 1,
    'ثاني': 2, 'الثاني': 2, 'ثانيه': 2, 'الثانيه': 2, 'تاني': 2, 'التاني': 2, 'تانيه': 2, 'التانيه': 2,
    'ثالث': 3, 'الثالث': 3, 'ثالثه': 3, 'الثالثه': 3, 'تالت': 3, 'التالت': 3, 'تالته': 3, 'التالته': 3,
  };

  const CH_KW = new Set(['اصحاح', 'الاصحاح', 'اصحاحات', 'الاصحاحات', 'صحاح', 'الصحاح', 'فصل', 'الفصل', 'chapter', 'chapters', 'ch']);
  const V_KW = new Set(['عدد', 'العدد', 'اعداد', 'الاعداد', 'ايه', 'الايه', 'ايات', 'الايات', 'العددين', 'عددين', 'الايتين', 'verse', 'verses', 'v', 'vv']);
  // Words that come just before a book name ("سفر إرميا", "رسالة رومية", "إنجيل يوحنا"): with one of them, a
  // slightly misheard book name still counts.
  const BOOK_CUES = new Set(['سفر', 'رساله', 'انجيل', 'مزمور', 'المزمور', 'نبوه', 'نبوات', 'رسالته', 'بسفر', 'برساله', 'وسفر', 'ورساله']);
  const RANGE_KW = new Set(['الي', 'لحد', 'حتي', 'لغايه', 'ل', 'لعند', 'to', 'through', 'thru']);
  const FILLER = new Set(['من', 'في', 'رقم', 'و', 'ف', 'ب', 'علي', 'عند', 'ال', 'and', 'of']);
  // "لآخر الأصحاح" / "لحد نهاية الأصحاح": range to the last verse of the chapter
  const END_WORDS = new Set(['اخر', 'الاخر', 'نهايه', 'النهايه', 'end']);
  const END = -1;
  const BEFORE_FILLER = new Set(['رساله', 'الرساله', 'بولس', 'الرسول', 'الي', 'اهل', 'سفر', 'ل', 'في', 'من', 'و', 'انجيل', 'رسالته',
    'of', 'the', 'in', 'book', 'gospel']);
  // English book names that are also everyday words ("my job 2 years ago") need chapter AND verse
  const EN_RISKY = new Set([18, 41, 44, 4]);   // Job, Mark, Acts, Numbers

  // Build alias index: first token -> [{toks, book|numbered}]
  const aliasIndex = new Map();
  const bookFirstWords = new Set();
  function addAlias(str, target) {
    const toks = normalize(str).split(' ').filter(Boolean);
    if (!toks.length) return;
    if (!aliasIndex.has(toks[0])) aliasIndex.set(toks[0], []);
    aliasIndex.get(toks[0]).push({ toks, target });
    bookFirstWords.add(toks[0]);
  }
  for (const [num, , , ar, en] of BOOK_DEFS) {
    for (const a of ar) addAlias(a, { book: num });
    for (const a of en) addAlias(a, { book: num });
  }
  for (const g of NUMBERED) for (const b of g.base) addAlias(b, { numbered: g });
  for (const list of aliasIndex.values()) list.sort((a, b) => b.toks.length - a.toks.length);

  const BOOKS = BOOK_DEFS.map(([num, en, ar]) => ({ num, en, ar }));

  // ------------------------------------------------------------------
  // Tokenizing (with Arabic prefix splitting: و ل ب ف لل)
  // ------------------------------------------------------------------
  function isKnown(w) {
    return !!lex(w) || CH_KW.has(w) || V_KW.has(w) || RANGE_KW.has(w) || END_WORDS.has(w) || bookFirstWords.has(w) || (w in ORDINAL_WORDS);
  }
  function splitLBF(w) {
    if (w.length > 3 && w.startsWith('لل') && isKnown('ال' + w.slice(2))) return ['ل', 'ال' + w.slice(2)];
    for (const p of ['ل', 'ب', 'ف']) {
      if (w.length > 2 && w[0] === p && isKnown(w.slice(1))) return [p, w.slice(1)];
    }
    return null;
  }
  function splitPrefix(w) {
    if (isKnown(w)) return [w];
    if (w.length > 4 && w.startsWith('ال') && bookFirstWords.has(w.slice(2))) return [w.slice(2)];
    if (w.length > 2 && w[0] === 'و') {
      const r = w.slice(1);
      if (isKnown(r)) return ['و', r];
      const r2 = splitLBF(r);
      if (r2) return ['و', ...r2];
    }
    return splitLBF(w) || [w];
  }
  const EN_ORD = { first: '1', second: '2', third: '3', i: '1', ii: '2', iii: '3' };
  const EN_NUMBERED = new Set(['samuel', 'kings', 'chronicles', 'corinthians', 'thessalonians', 'timothy', 'peter', 'john']);
  // «إيه» / «ايه» is Egyptian for "what"; a verse is written «آية» («الآية», «اية», «آيه»). Once the spelling is evened
  // out both are «ايه», and "شكله ايه؟ … واحد" would be "verse one": so "what" is taken out first.
  const WHAT = /(^|[^ء-ي])[وفب]?[إأا]يه(?![ء-ي])/g;
  function tokenize(text) {
    const out = [];
    text = String(text || '').replace(DIACRITICS, '').replace(WHAT, '$1 ');
    for (const w of normalize(text).split(' ')) if (w) out.push(...splitPrefix(w));
    for (let i = 0; i < out.length; i++) {
      if (/^\d+$/.test(out[i]) && /^(st|nd|rd|th)$/.test(out[i + 1] || '')) out.splice(i + 1, 1);   // 1st -> 1
      if (EN_ORD[out[i]] && EN_NUMBERED.has(out[i + 1])) out[i] = EN_ORD[out[i]];                      // first john -> 1 john
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Reference parsing
  // ------------------------------------------------------------------
  function skip(t, j, set, max) {
    let n = 0;
    while (j < t.length && set.has(t[j]) && n < max) { j++; n++; }
    return j;
  }

  function ordinalValue(tok) {
    if (tok in ORDINAL_WORDS) return ORDINAL_WORDS[tok];
    if (tok === '1' || tok === '2' || tok === '3') return parseInt(tok, 10);
    return null;
  }

  // Try to match a book name starting at i. minIdx = first index not yet consumed.
  function matchBookAt(t, i, minIdx) {
    const list = aliasIndex.get(t[i]);
    if (!list) return null;
    for (const al of list) {
      let ok = true;
      for (let k = 0; k < al.toks.length; k++) if (t[i + k] !== al.toks[k]) { ok = false; break; }
      if (!ok) continue;
      const end = i + al.toks.length;
      if (al.target.book) {
        // English numbered aliases already include the digit ("1 john").
        return { book: al.target.book, start: i, end };
      }
      const g = al.target.numbered;
      // ordinal right after: "كورنثوس الاولى", "صموئيل الاول"
      const after = t[end] in ORDINAL_WORDS ? ORDINAL_WORDS[t[end]] : null;
      if (after && g.map[after]) return { book: g.map[after], start: i, end: end + 1 };
      // ordinal before: "الرسالة الاولى الى اهل كورنثوس", "١ كورنثوس", "اول صموئيل"
      // (not across the word «إنجيل»: "… عدد ٣. إنجيل يوحنا" is the Gospel, not 3 John)
      let j = i - 1, steps = 0, gospel = false;
      while (j >= minIdx && steps < 5 && BEFORE_FILLER.has(t[j])) { if (t[j] === 'انجيل' || t[j] === 'gospel') gospel = true; j--; steps++; }
      if (j >= minIdx && !gospel) {
        const ov = ordinalValue(t[j]);
        const prev = t[j - 1];
        if (ov && g.map[ov] && !(prev && (CH_KW.has(prev) || V_KW.has(prev)))) {
          return { book: g.map[ov], start: j, end };
        }
      }
      if (g.fallback) return { book: g.fallback, start: i, end };
      return null;
    }
    return null;
  }

  // A book name the speech engine spelled a little wrong: "يوحن", "كورينثوس", "ارميه", "يومية" (رومية).
  // How much is believed depends on what is around it, so everyday words don't turn into references:
  //   a book word before it ("سفر", "رسالة", "إنجيل")        -> a loose match is enough, then a chapter number
  //   no book word, one letter out in a name of 5+ letters    -> the chapter word after it ("حبقوك الاصحاح 3"),
  //                                                              or chapter and verse at once ("لحبقوك 3 17")
  //   no book word, the same consonants only ("نحوم")         -> chapter and verse at once, and that verse must exist
  // («شوية» is one letter from «الرؤية»: a 4-letter name, so it is not believed without a book word.)
  let fuzzyBooks = null;
  // «مزمور» as the speech model on this PC often writes it; believed only with the psalm's number straight after.
  // «جون» is "John" said the English way: with chapter and verse straight after ("جون 3:14") it is the Gospel for
  // certain (the third value); with a chapter alone it is a guess like the others.
  // «في فيلبي ٤ عدد ١» has been written «في ليبيا 4 عدد واحد»: with chapter and verse straight after, it is the letter.
  // «فليمون ١: ٥» has been written «في لمون 1:5» (18 Nov 2026): the same way, only with chapter and verse straight after.
  const HEARD_AS = [['مضمون', 19], ['جون', 43, true], ['ليبيا', 50, true], ['لمون', 57, true]];
  function buildFuzzyBooks() {
    fuzzyBooks = [];
    for (const [num, , disp, ar] of BOOK_DEFS) {
      const seen = new Set();
      for (const a of ar.concat([disp])) {
        const toks = normalize(a).split(' ').filter(Boolean);
        if (!toks.length || seen.has(toks.join(' '))) continue;
        seen.add(toks.join(' '));
        if (NUMBERED.some(g => g.map[1] === num || g.map[2] === num || g.map[3] === num)) continue;   // via NUMBERED below
        fuzzyBooks.push({ toks, target: { book: num } });
      }
    }
    for (const g of NUMBERED) for (const b of g.base) fuzzyBooks.push({ toks: normalize(b).split(' '), target: { numbered: g } });
    for (const [w, num, plain] of HEARD_AS) fuzzyBooks.push({ toks: [w], target: { book: num }, heard: true, plain: !!plain });
  }
  const unAl = w => w.replace(/^(?:و|ف|ب|ل)?(?:ال|لل)(?=...)/, '');
  // "لحبقوق", "بيوحنا", "والرؤيا": the name without a joined-on و / ف / ب / ل and «ال»
  const bareName = w => w.replace(/^[وفبل]?(?:ال|لل)?(?=....)/, '');
  function editDist(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function fuzzyTokEq(a, b) {
    if (a === b) return true;
    const x = unAl(a), y = unAl(b);
    if (x === y && x.length >= 3) return true;
    if (y.length >= 4 && lev1(x, y)) return true;
    const sx = skel(x), sy = skel(y);
    return sy.length >= 3 && (sx === sy || (sy.length >= 4 && lev1(sx, sy)));
  }
  const NOT_BOOK = new Set(['من', 'في', 'علي', 'الي', 'عن', 'مع', 'ده', 'دي', 'هو', 'هي', 'انا', 'احنا', 'انت', 'كان', 'يا', 'اللي', 'الله', 'الرب', 'يسوع', 'المسيح']);
  function fuzzyBookAt(t, i, minIdx) {
    const w = t[i];
    if (!w || w.length < 3 || !/^[ء-ي]+$/.test(w) || NOT_BOOK.has(w) || lex(w) || CH_KW.has(w) || V_KW.has(w) ||
        RANGE_KW.has(w) || FILLER.has(w) || BOOK_CUES.has(w) || END_WORDS.has(w) || (w in ORDINAL_WORDS)) return null;
    if (!fuzzyBooks) buildFuzzyBooks();
    let p = i - 1;
    while (p >= minIdx && (FILLER.has(t[p]) || t[p] === 'ال')) p--;
    const cue = p >= minIdx ? [t[p], unAl(t[p]), 'ال' + unAl(t[p])].find(x => BOOK_CUES.has(x)) : null;
    const cued = !!cue;
    // the word before says what kind of book it is: a misheard name must fit it
    const kind = !cue ? null : /انجيل/.test(cue) ? 'gospel' : /رسال/.test(cue) ? 'epistle' : /مزمور/.test(cue) ? 'psalm' : /سفر|نبو/.test(cue) ? 'book' : null;
    const fits = b => !kind || (kind === 'gospel' ? b >= 40 && b <= 43 : kind === 'epistle' ? b >= 45 && b <= 65
      : kind === 'psalm' ? b === 19 : !(b >= 40 && b <= 43) && !(b >= 45 && b <= 65));
    let best = null;
    for (const fb of fuzzyBooks) {
      const n = fb.toks.length;
      const g0 = fb.target.numbered;
      const books = fb.target.book ? [fb.target.book] : Object.values(g0.map).concat(g0.fallback ? [g0.fallback] : []);
      if (!books.some(fits)) continue;
      let ok = true, sure = !fb.heard, same = true;      // sure: the letters fit; same: the consonants are the same
      for (let k = 0; k < n; k++) {
        const a0 = t[i + k], b = fb.toks[k];
        if (!a0) { ok = false; break; }
        const a1 = bareName(a0);
        if (fb.heard) { if (a0 !== b && a1 !== b) ok = false; continue; }
        const a = fuzzyTokEq(a0, b) ? a0 : fuzzyTokEq(a1, b) ? a1 : null;
        if (!a) { ok = false; break; }
        const x = unAl(a), y = unAl(b);
        const sk = skel(y).length >= 3 && skel(a1) === skel(y);
        if (!sk && a !== b) same = false;
        if (cued || a === b) continue;
        if ((y.length >= 4 && x === y) || (y.length >= 5 && lev1(x, y))) continue;
        if (n === 1 && sk && Math.abs(a1.length - y.length) <= 1) { sure = false; continue; }
        ok = false; break;
      }
      if (!ok) continue;
      // several names fit: the longest; then the one with the same consonants ("يوحان" is يوحنا, not يونان); then a
      // numbered book (it reads the «الأولى» after it); then the nearest spelling ("نحوم": ناحوم, not نحميا)
      const numbered = !!fb.target.numbered;
      const dist = editDist(bareName(unAl(t[i])), unAl(fb.toks[0]));
      const rank = [n, same ? 1 : 0, numbered ? 1 : 0, -dist];
      let better = !best;
      for (let k = 0; best && k < rank.length; k++) { if (rank[k] !== best.rank[k]) { better = rank[k] > best.rank[k]; break; } }
      if (better) best = { fb, n, rank, sure };
    }
    if (!best) {
      // "الصومين الأول إصحاح ٣": sounds like one of the numbered books, then its number and the chapter word.
      // A guess: it makes a card to check, never goes on screen by itself.
      const ord = t[i + 1] in ORDINAL_WORDS ? ORDINAL_WORDS[t[i + 1]] : null;
      if (cued || !ord || !isChapterWord(t[i + 2]) || !parseNumber(t, skip(t, i + 3, FILLER, 1))) return null;
      const s = skel(bareName(w));
      for (const g of NUMBERED) {
        if (!g.map[ord]) continue;
        for (const b of g.base) {
          const bt = normalize(b).split(' ');
          const sb = bt.length === 1 ? skel(bt[0]) : '';
          if (sb.length >= 3 && s[0] === sb[0] && (s === sb || lev1(s, sb))) return { book: g.map[ord], start: i, end: i + 2, cued: false, fuzzy: true, sure: true, probable: true };
        }
      }
      return null;
    }
    const end = i + best.n;
    const tg = best.fb.target;
    const res = (book, start, e, c) => (fits(book) ? { book, start, end: e, cued: c, fuzzy: true, sure: best.sure, heard: !!best.fb.heard, plain: !!best.fb.plain } : null);
    if (tg.book) return res(tg.book, i, end, cued);
    const g = tg.numbered;
    const after = t[end] in ORDINAL_WORDS ? ORDINAL_WORDS[t[end]] : null;
    if (after && g.map[after]) return res(g.map[after], i, end + 1, cued);
    let j = i - 1, steps = 0, gospel = false;
    while (j >= minIdx && steps < 5 && BEFORE_FILLER.has(t[j])) { if (t[j] === 'انجيل' || t[j] === 'gospel') gospel = true; j--; steps++; }
    if (j >= minIdx && !gospel) { const ov = ordinalValue(t[j]); if (ov && g.map[ov]) return res(g.map[ov], j, end, true); }
    if (g.fallback) return res(g.fallback, i, end, cued);
    return null;
  }
  // "الأصحاح" as speech engines write it: "الإصحاحة", "اصحاحا", "الاصحاف", "الاسحاق"
  const CH_SKEL = 'اسحح';
  function isChapterWord(w) {
    if (!w) return false;
    if (CH_KW.has(w)) return true;
    if (w.length < 4 || !/^[ء-ي]+$/.test(w)) return false;
    const x = unAl(w);
    if (w === 'الاصح') return true;       // «الأصحاح الرابع» said fast is written «الأصح رابع» (every caller wants a number after it)
    if (x === 'اصحاح' || x === 'اصحاحات' || x === 'صفحه' || (x.length >= 4 && lev1(x, 'اصحاح'))) return true;
    const s = skel(x);
    return s.length >= 4 && (s === CH_SKEL || lev1(s, CH_SKEL));
  }
  // "العدد" as speech engines write it: "عدده", "اعدد", "العدده" (only used when a number follows)
  function isVerseWordLoose(w) {
    if (!w || V_KW.has(w)) return !!w;
    if (w.length > 7 || !/^[ء-ي]+$/.test(w)) return false;
    const x = unAl(w).replace(/^[وبل](?=..)/, '');
    return /^ا?عدد[اهو]?$/.test(x);
  }

  function parseRange(t, k) {
    if (t[k] === 'و') {
      // "عدد ١٦ و ١٧" -> 16-17 (only when the second number follows directly)
      const n = parseNumber(t, k + 1);
      return n ? { value: n.value, end: n.end, consecutiveOnly: true } : null;
    }
    if (!RANGE_KW.has(t[k])) return null;
    let j = k + 1;
    if (t[j] === 'ال') j++;
    if (END_WORDS.has(t[j])) {
      let end = j + 1;
      if (CH_KW.has(t[end])) end++;
      return { value: END, end };
    }
    if (V_KW.has(t[j])) j++;
    const n = parseNumber(t, j);
    return n ? n : null;
  }
  function rangeOk(rg, verse) {
    if (!rg) return false;
    if (rg.value === END) return true;
    if (rg.consecutiveOnly) return rg.value === verse + 1;
    return rg.value > verse;
  }

  // chapter/verse after the book name. opts.fuzzy: the book name was misheard, so the chapter word (or a book
  // word before the name, opts.cued) is required.
  function parseAfter(t, j, book, opts) {
    const single = SINGLE_CHAPTER.has(book);
    j = skip(t, j, FILLER, 2);
    let chapKw = false, strict = false, guess = false;
    if (isChapterWord(t[j])) {
      if (opts && opts.fuzzy && !opts.cued && !opts.sure) guess = true;   // the same consonants and the chapter word: a guess
      chapKw = true; j = skip(t, j + 1, FILLER, 1);
    } else if (opts && opts.fuzzy && !opts.cued) {
      // no book word before, no chapter word after: chapter and verse must follow at once ("لحبقوك 3 17",
      // "ليبيا 4 عدد واحد"), or, for a psalm, its number ("مزمون 46"). The caller then checks that the verse exists.
      const a = parseNumber(t, j);
      const kv = a ? skip(t, a.end, FILLER, 2) : -1;
      if (!a || !(book === 19 || parseNumber(t, a.end) || (V_KW.has(t[kv]) && parseNumber(t, skip(t, kv + 1, FILLER, 1))))) return null;
      if (opts.heard && !opts.plain && a.value === 1) return null;        // «مضمون واحد» is said every day
      strict = true;
    } else if (V_KW.has(t[j]) && single) {
      const n = parseNumber(t, skip(t, j + 1, FILLER, 1));
      if (!n) return null;
      const r = { chapter: 1, verse: n.value, verseEnd: null, end: n.end };
      takeRange(t, r);
      return r;
    } else if (V_KW.has(t[j])) {
      // «يوحنا الآية 3:16», "John verse 3:16": the verse word said loosely before chapter and verse (both numbers needed;
      // else «الآية 3» was taken as verse 3 of the chapter on the screen)
      const a = parseNumber(t, skip(t, j + 1, FILLER, 1)), b = a && parseNumber(t, a.end);
      if (!b) return null;
      const r = { chapter: a.value, verse: b.value, verseEnd: null, end: b.end };
      takeRange(t, r);
      return r;
    }
    const n1 = parseNumber(t, j);
    if (!n1) return null;
    const r = { chapter: n1.value, verse: null, verseEnd: null, end: n1.end };
    let k = n1.end;
    const k2 = skip(t, k, FILLER, 2);
    if (V_KW.has(t[k2])) {
      const n2 = parseNumber(t, skip(t, k2 + 1, FILLER, 1));
      if (n2) { r.verse = n2.value; r.end = n2.end; if (t[k2 - 1] === 'من') r.from = true; }
    } else {
      const n2 = parseNumber(t, k);   // direct: "يوحنا 3 16", "رومية ثمانية ثمانية وعشرين"
      if (n2) { r.verse = n2.value; r.end = n2.end; }
      else if (t[k] === 'من' || (t[k] === 'و' && t[k + 1] === 'من')) {
        // "يوحنا واحد من واحد لغايه 24" / "يوحنا 3 من 16 الى 18" / "من الاول لغاية 10"
        const j = t[k] === 'من' ? k + 1 : k + 2;
        const n3 = parseNumber(t, j);
        if (n3) { r.verse = n3.value; r.end = n3.end; r.from = true; }
      } else if (isVerseWordLoose(t[k2])) {
        // "العدد" misheard ("عدده", "اعدد") — believable only because a number follows straight away
        const n3 = parseNumber(t, k2 + 1);
        if (n3) { r.verse = n3.value; r.end = n3.end; }
      }
    }
    if (r.verse != null) takeRange(t, r);
    if (r.verseEnd != null) r.from = false;       // ("من ٣ إلى ١٧" is a passage with an end; "من عدد ٣" alone a reading from there)
    if (single && !chapKw && r.verse == null) { r.verse = r.chapter; r.chapter = 1; }
    if (strict) r.strict = true;
    if (guess) r.guess = true;
    return r;
  }
  // "... لعدد ٣٠": a range end. A range end smaller than the start ("من عدد ٢٨ لعدد ٣") was misheard —
  // usually a tens word heard as a unit (تلاتين -> تلاتة) — so it becomes ٣٠, and its words are used up
  // either way (they must not turn into a separate reference).
  function takeRange(t, r) {
    const rg = parseRange(t, r.end);
    if (!rg) return;
    if (rangeOk(rg, r.verse)) { r.verseEnd = rg.value; r.end = rg.end; return; }
    if (rg.consecutiveOnly || bookFirstWords.has(t[rg.end])) return;
    r.end = rg.end;
    if (rg.value > 0 && rg.value < 10 && rg.value * 10 > r.verse) r.verseEnd = rg.value * 10;
  }

  // verse/chapter BEFORE the book: "العدد ١٦ من الاصحاح الثالث من انجيل يوحنا"
  function parseBefore(t, bookStart, minIdx, book) {
    const lo = Math.max(minIdx, bookStart - 12);
    const reachesBook = (idx) => skip(t, idx, BEFORE_FILLER, 4) === bookStart;
    for (let c = bookStart - 2; c >= lo; c--) {
      if (!CH_KW.has(t[c])) continue;
      const n = parseNumber(t, t[c + 1] === 'of' ? c + 2 : c + 1);         // ("chapter 37 of Ezekiel", "the chapter of 37 Ezekiel")
      if (!n || !reachesBook(n.end)) continue;
      const r = { chapter: n.value, verse: null, verseEnd: null, start: c };
      for (let v = c - 2; v >= lo; v--) {
        if (!V_KW.has(t[v])) continue;
        const n2 = parseNumber(t, v + 1);
        if (n2 && skip(t, n2.end, FILLER, 2) === c) { r.verse = n2.value; r.start = v; }
        break;
      }
      return r;
    }
    if (SINGLE_CHAPTER.has(book)) {
      for (let v = bookStart - 2; v >= lo; v--) {
        if (!V_KW.has(t[v])) continue;
        const n = parseNumber(t, v + 1);
        if (n && reachesBook(n.end)) return { chapter: 1, verse: n.value, verseEnd: null, start: v };
      }
    }
    return null;
  }

  // Context-only references (no book named): "الاصحاح الخامس عدد ٣", "عدد ٢٨"
  function parseContextAt(t, i) {
    if (isChapterWord(t[i]) && (CH_KW.has(t[i]) || /^\d+$/.test(t[i + 1] || '') || lex(t[i + 1]))) {
      const n = parseNumber(t, i + 1);
      if (!n) return null;
      const r = { chapter: n.value, verse: null, verseEnd: null, start: i, end: n.end };
      const k = skip(t, n.end, FILLER, 2);
      if (V_KW.has(t[k])) {
        const n2 = parseNumber(t, k + 1);
        if (n2) { r.verse = n2.value; r.end = n2.end; }
      }
      return r.verse != null ? r : null;   // chapter alone is too vague without a book
    }
    if (V_KW.has(t[i])) {
      const n = parseNumber(t, i + 1);
      if (!n) return null;
      const r = { chapter: null, verse: n.value, verseEnd: null, start: i, end: n.end };
      const rg = parseRange(t, n.end);
      if (rangeOk(rg, r.verse)) { r.verseEnd = rg.value; r.end = rg.end; }
      else if (t[i - 1] === 'من') r.from = true;      // "هنقرأ من عدد ٣": a reading that starts there
      // «103 عدد 3» with no book named: only the Psalms have a chapter 103 (the word «مزمور» was missed)
      const before = /^\d{2,3}$/.test(t[i - 1] || '') ? +t[i - 1] : 0;
      if (before > 66 && before <= 150) { r.psalm = before; r.start = i - 1; }
      return r;
    }
    return null;
  }

  /**
   * Find references in a token array.
   * Returns [{book|null, chapter|null, verse|null, verseEnd|null, start, end, kind:'reference'|'context'}]
   */
  function findRefs(t) {
    const refs = [];
    let consumed = 0;
    const occupied = [];
    for (let i = 0; i < t.length; i++) {
      if (i < consumed) continue;
      let m = matchBookAt(t, i, consumed);
      if (!m) m = fuzzyBookAt(t, i, consumed);
      if (!m) continue;
      let r = parseAfter(t, m.end, m.book, m.fuzzy ? m : null);
      if (r && EN_RISKY.has(m.book) && /^[a-z]/.test(t[m.start]) && r.verse == null) r = null;
      if (r && r.strict && r.verse == null && m.book !== 19) r = null;
      if (r) {
        const ref = { book: m.book, chapter: r.chapter, verse: r.verse, verseEnd: r.verseEnd, start: m.start, end: r.end, kind: 'reference' };
        if (r.from && r.verse != null) ref.from = true;                          // (a reading that starts at this verse)
        if (r.strict) ref.strict = true;                                         // (the verse must exist)
        if (m.probable || (m.heard && !(m.plain && r.verse != null)) || r.guess || (r.strict && r.verse == null)) ref.probable = true;   // (a guess: a card to check)
        refs.push(ref);
        consumed = r.end; occupied.push([m.start, r.end]); i = r.end - 1;
        continue;
      }
      const b = m.fuzzy ? null : parseBefore(t, m.start, consumed, m.book);
      if (b) {
        refs.push({ book: m.book, chapter: b.chapter, verse: b.verse, verseEnd: null, start: b.start, end: m.end, kind: 'reference' });
        consumed = m.end; occupied.push([b.start, m.end]); i = m.end - 1;
        continue;
      }
      i = m.end - 1;
    }
    // context refs in the gaps
    const inOcc = (s, e) => occupied.some(([a, b]) => s < b && e > a);
    for (let i = 0; i < t.length; i++) {
      const r = parseContextAt(t, i);
      if (!r || inOcc(r.start, r.end)) continue;
      const ref = { book: null, chapter: r.chapter, verse: r.verse, verseEnd: r.verseEnd, start: r.start, end: r.end, kind: 'context' };
      if (r.from) ref.from = true;
      // (a guess: a card to check, unless the Psalms are what is being read: see Detector._accept)
      if (r.psalm) Object.assign(ref, { book: 19, chapter: r.psalm, kind: 'reference', strict: true, psalmGuess: true, from: false });
      refs.push(ref);
      occupied.push([r.start, r.end]);
      i = r.end - 1;
    }
    refs.sort((a, b) => a.start - b.start);
    return refs;
  }

  // ------------------------------------------------------------------
  // Bible
  // ------------------------------------------------------------------
  class Bible {
    // raw: [{abbrev, chapters:[[verse,...],...]}, ...] in canonical 66-book order
    constructor(raw) {
      if (!Array.isArray(raw) || raw.length < 66) throw new Error('Bible data must have 66 books');
      this.books = raw.slice(0, 66).map(b => (b.chapters || b).map(ch => ch.map(cleanVerse)));
      for (const [k, text] of Object.entries(VERSE_PATCHES)) {
        const [b, c, v] = k.split(':').map(Number);
        const ch = (this.books[b - 1] || [])[c - 1];
        if (ch && ch[v - 1] != null && normalize(ch[v - 1]).length < 3) ch[v - 1] = text;
      }
      // does this copy carry tashkeel? (sample a few verses)
      const sample = [this.verse(1, 1, 1), this.verse(43, 3, 16), this.verse(19, 23, 1)].join(' ');
      const marks = (sample.match(/[\u064B-\u0652]/g) || []).length;
      const letters = (sample.match(/[\u0621-\u064A\u0671]/g) || []).length || 1;
      this.hasTashkeel = marks / letters > 0.2;
    }
    chapterCount(b) { return (this.books[b - 1] || []).length; }
    verseCount(b, c) { return ((this.books[b - 1] || [])[c - 1] || []).length; }
    verse(b, c, v) { const ch = (this.books[b - 1] || [])[c - 1]; return ch && ch[v - 1] != null ? ch[v - 1] : null; }
    valid(b, c, v) { return c >= 1 && c <= this.chapterCount(b) && (v == null || (v >= 1 && v <= this.verseCount(b, c))); }
    next(b, c, v) {
      if (v < this.verseCount(b, c)) return { book: b, chapter: c, verse: v + 1 };
      if (c < this.chapterCount(b)) return { book: b, chapter: c + 1, verse: 1 };
      if (b < 66) return { book: b + 1, chapter: 1, verse: 1 };
      return null;
    }
    prev(b, c, v) {
      if (v > 1) return { book: b, chapter: c, verse: v - 1 };
      if (c > 1) return { book: b, chapter: c - 1, verse: this.verseCount(b, c - 1) };
      if (b > 1) { const pc = this.chapterCount(b - 1); return { book: b - 1, chapter: pc, verse: this.verseCount(b - 1, pc) }; }
      return null;
    }
  }

  function refLabel(ref, opts) {
    opts = opts || {};
    const book = BOOKS[ref.book - 1];
    if (opts.lang === 'en') {
      let s = `${book.en} ${ref.chapter}`;
      if (ref.verse != null) s += `:${ref.verse}${ref.verseEnd ? '-' + ref.verseEnd : ''}`;
      return s;
    }
    const d = opts.westernDigits ? String : toArabicDigits;
    const name = ref.book === 19 && ref.verse != null ? 'مزمور' : book.ar;
    let s = `${name} ${d(ref.chapter)}`;
    if (ref.verse != null) s += `: ${d(ref.verse)}${ref.verseEnd ? '-' + d(ref.verseEnd) : ''}`;
    return s;
  }

  // ------------------------------------------------------------------
  // Quote matching (word trigrams) — Arabic and English
  // ------------------------------------------------------------------
  const STOP_LIMIT = 60;  // 3-word sequences found in more verses than this are ignored (too common)
  // "و" / "ف" before "ال" come and go when people quote ("والرب راعي…" for «الرب راعي…»), so they don't count
  function qtokens(text) { return normalize(text).split(' ').filter(w => w && !/^\d+$/.test(w)).map(w => w.replace(/^[وف](?=ال..)/, '')); }

  // English: old wording -> modern, plus light word-ending normalization, so that
  // "believeth" / "believes" / "believe" and "hath" / "has" count as the same word.
  const EN_OLD = { thee: 'you', thou: 'you', ye: 'you', thy: 'your', thine: 'your', hath: 'has', hast: 'have', doth: 'does',
    dost: 'do', art: 'are', shalt: 'shall', wilt: 'will', unto: 'to', saith: 'says', spake: 'spoke', yea: 'yes', nay: 'no',
    whosoever: 'whoever', whatsoever: 'whatever', brethren: 'brothers', yahweh: 'the lord', jehovah: 'the lord' };
  function enStem(w) {
    if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 5 && (w.endsWith('eth') || w.endsWith('est') || w.endsWith('ing'))) w = w.slice(0, -3);
    else if (w.length > 4 && (w.endsWith('ed') || w.endsWith('es'))) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    return w;
  }
  function enTokens(text) {
    const out = [];
    for (const w of String(text || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ')) {
      if (!w || /^\d+$/.test(w)) continue;
      const m = EN_OLD[w];
      if (m) { for (const x of m.split(' ')) out.push(enStem(x)); } else out.push(enStem(w));
    }
    return out;
  }
  // Is this sentence (mostly) English?
  function isEnglish(text) {
    const s = String(text || '');
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    const arabic = (s.match(/[؀-ۿ]/g) || []).length;
    return latin >= 8 && latin > arabic * 2;
  }
  function strHash(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h | 0;
  }

  // A compact index: each 3-word sequence is a number; the postings (which verses contain it)
  // are packed into typed arrays. Several translations can be added: they are joined by
  // book:chapter:verse, so a quote in any of their wordings finds the verse.
  class QuoteIndex {
    constructor(opts) {
      this.tokenize = (opts && opts.tokenize) || qtokens;
      this.vocab = new Map();
      this.building = new Map();   // key -> verse ids (while building)
      this.idOf = new Map();
      this.ids = [];
      this.sets = [];
      this.fp1 = []; this.fp2 = [];
      this.keys = null;
      this.ready = false;
    }
    get size() { return this.keys ? this.keys.length : this.building.size; }
    _wid(w, create) {
      let i = this.vocab.get(w);
      if (i === undefined && create) { i = this.vocab.size; this.vocab.set(w, i); }
      return i;
    }
    static key(a, b, c) { return (a * 131072 + b) * 131072 + c; }
    // Add one translation, in chunks so pages stay responsive. Returns a Promise.
    addBible(bible, chunk) {
      chunk = chunk || 3000;
      const list = [];
      bible.books.forEach((chs, bi) => chs.forEach((vs, ci) => vs.forEach((txt, vi) => list.push([bi + 1, ci + 1, vi + 1, txt]))));
      let pos = 0;
      return new Promise(resolve => {
        const step = () => {
          const end = Math.min(list.length, pos + chunk);
          for (; pos < end; pos++) this.add(list[pos]);
          if (pos < list.length) setTimeout(step, 0); else resolve(this);
        };
        step();
      });
    }
    // bibles: a Bible, or an array of Bibles (translations of the same text)
    build(bibles, chunk) {
      return [].concat(bibles).filter(Boolean)
        .reduce((p, b) => p.then(() => this.addBible(b, chunk)), Promise.resolve())
        .then(() => { this.finalize(); this.ready = true; return this; });
    }
    add(b, c, v, txt) {
      if (Array.isArray(b)) [b, c, v, txt] = b;
      const k = b + ':' + c + ':' + v;
      let id = this.idOf.get(k);
      if (id === undefined) {
        id = this.ids.length;
        this.idOf.set(k, id);
        this.ids.push([b, c, v]);
        this.sets.push(new Set());
      }
      const w = this.tokenize(txt);
      if (this.fp1[id] === undefined) { const j = w.join(' '); this.fp1[id] = strHash(j, 2166136261); this.fp2[id] = strHash(j, 5381); }
      const seen = this.sets[id];
      for (let i = 0; i + 2 < w.length; i++) {
        const key = QuoteIndex.key(this._wid(w[i], true), this._wid(w[i + 1], true), this._wid(w[i + 2], true));
        if (seen.has(key)) continue;
        seen.add(key);
        let arr = this.building.get(key);
        if (!arr) { arr = []; this.building.set(key, arr); }
        if (arr.length <= STOP_LIMIT) arr.push(id);
      }
      this.keys = null;
    }
    // Pack everything into sorted typed arrays (binary search at query time).
    finalize() {
      if (this.keys) return;
      const keys = Float64Array.from(this.building.keys()).sort();
      const offsets = new Int32Array(keys.length + 1);
      let total = 0;
      for (let i = 0; i < keys.length; i++) { offsets[i] = total; total += this.building.get(keys[i]).length; }
      offsets[keys.length] = total;
      const data = new Int32Array(total);
      for (let i = 0; i < keys.length; i++) data.set(this.building.get(keys[i]), offsets[i]);
      this.counts = Uint16Array.from(this.sets.map(x => Math.min(65535, x.size)));
      this.f1 = Int32Array.from(this.fp1); this.f2 = Int32Array.from(this.fp2);
      this.keys = keys; this.offsets = offsets; this.data = data;
      this.building = new Map(); this.sets = []; this.fp1 = []; this.fp2 = [];
    }
    _find(key) {
      const k = this.keys;
      let lo = 0, hi = k.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (k[mid] < key) lo = mid + 1; else if (k[mid] > key) hi = mid - 1; else return mid;
      }
      return -1;
    }
    sameText(a, b) { return this.f1[a] === this.f1[b] && this.f2[a] === this.f2[b]; }
    // words: tokenized words of what was just said. Returns the best verse or null.
    // Each matching 3-word sequence counts more when it is rare in the Bible, so a short,
    // slightly misheard quote of a distinctive verse still matches, while refrains that
    // appear in dozens of verses ("لأن إلى الأبد رحمته") don't trigger a guess.
    query(words) {
      if (!this.ready || words.length < 3) return null;
      this.finalize();
      const tally = new Map();   // id -> {hits, weight}
      const seen = new Set();
      for (let i = 0; i + 2 < words.length; i++) {
        const a = this._wid(words[i]), b = this._wid(words[i + 1]), c = this._wid(words[i + 2]);
        if (a === undefined || b === undefined || c === undefined) continue;
        const key = QuoteIndex.key(a, b, c);
        if (seen.has(key)) continue;
        seen.add(key);
        const idx = this._find(key);
        if (idx < 0) continue;
        const s = this.offsets[idx], e = this.offsets[idx + 1];
        if (e - s > STOP_LIMIT) continue;
        const w = 1 / Math.sqrt(e - s);
        for (let j = s; j < e; j++) {
          const id = this.data[j];
          const t = tally.get(id);
          if (t) { t.hits++; t.weight += w; } else tally.set(id, { hits: 1, weight: w });
        }
      }
      let best = null, bestScore = 0;
      const scored = [];
      for (const [id, t] of tally) {
        const total = this.counts[id] || 1;
        const cov = t.hits / total;
        const ok = (t.hits >= 4 && t.weight >= 1.6) ||
                   (t.hits >= 3 && t.weight >= 2.2) ||                 // 3 rare sequences
                   (t.hits >= 3 && cov >= 0.5 && t.weight >= 1.2) ||   // most of a short verse
                   (t.hits >= 2 && total <= 3 && cov >= 0.66 && t.weight >= 1.4);
        if (!ok) continue;
        const score = t.weight + 0.5 * cov;
        scored.push([id, score]);
        if (score > bestScore) { best = id; bestScore = score; }
      }
      if (best == null) return null;
      // Ambiguous: several different verses fit equally well (common refrains, parallel passages)
      let ties = 0;
      for (const [id, sc] of scored) {
        if (id === best || bestScore - sc > 0.25) continue;
        if (this.sameText(id, best)) continue;   // identical wording elsewhere is fine
        ties++;
      }
      if (ties >= 2) return null;
      const [b, c, v] = this.ids[best];
      const t = tally.get(best);
      // other verses with exactly the same wording (e.g. Psalm 118:1 and 136:1)
      const alsoIn = [];
      for (const [id] of scored) {
        if (id !== best && this.sameText(id, best) && alsoIn.length < 4) {
          const [b2, c2, v2] = this.ids[id];
          alsoIn.push({ book: b2, chapter: c2, verse: v2 });
        }
      }
      alsoIn.sort((x, y) => x.book - y.book || x.chapter - y.chapter || x.verse - y.verse);
      return { book: b, chapter: c, verse: v, hits: t.hits, weight: t.weight, coverage: t.hits / (this.counts[best] || 1), ties, alsoIn };
    }
  }

  // ------------------------------------------------------------------
  // Forgiving quote matching: finds the verse even when the speech engine got several words wrong
  // ("أنه هكذا أحبب له العالم حسب بدء ابنه الوحيد" -> John 3:16). Rare words that the spoken words and a
  // verse share pick the candidates; then the words are lined up in order, allowing small spelling slips.
  // ------------------------------------------------------------------
  const softCache = new Map();
  function soft(w) {
    let k = softCache.get(w);
    if (k !== undefined) return k;
    k = w.replace(/^[وف](?=ال..)/, '').replace(/^(ال|لل)(?=..)/, '');
    if (/^[ء-ي]{2,}$/.test(k)) {
      k = k.replace(/[ثص]/g, 'س').replace(/[ذظ]/g, 'ز').replace(/ض/g, 'د').replace(/ط/g, 'ت').replace(/ق/g, 'ك').replace(/ء/g, '');
      if (k.length > 3) k = k.replace(/[اهي]$/, '');
      if (k) k = k[0] + k.slice(1).replace(/[اوي]/g, '');
    }
    if (softCache.size > 60000) softCache.clear();
    softCache.set(w, k);
    return k;
  }
  const softEq = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && lev1(a, b)) ||
    (a.length === 3 && b.length === 3 && a[0] === b[0] && lev1(a, b));
  // Lines up spoken words w with verse words v (both soft), each match worth the word's rarity.
  // Returns {score, n (words matched), w0, w1 (span in the spoken words), v0, v1 (span in the verse)}.
  function alignWords(w, v, weight, newFrom) {
    const W = w.length, V = v.length;
    const dp = new Float64Array((W + 1) * (V + 1)), cnt = new Int16Array((W + 1) * (V + 1));
    const at = (i, j) => i * (V + 1) + j;
    for (let i = 1; i <= W; i++) {
      for (let j = 1; j <= V; j++) {
        let best = dp[at(i - 1, j)], c = cnt[at(i - 1, j)];
        if (dp[at(i, j - 1)] > best) { best = dp[at(i, j - 1)]; c = cnt[at(i, j - 1)]; }
        if (softEq(w[i - 1], v[j - 1])) {
          const x = dp[at(i - 1, j - 1)] + weight(v[j - 1]);
          if (x > best) { best = x; c = cnt[at(i - 1, j - 1)] + 1; }
        }
        dp[at(i, j)] = best; cnt[at(i, j)] = c;
      }
    }
    let i = W, j = V, w0 = W, w1 = -1, v0 = V, v1 = -1, fresh = 0;   // walk back to find where the matched words are
    while (i > 0 && j > 0) {
      if (dp[at(i, j)] === dp[at(i - 1, j)]) i--;
      else if (dp[at(i, j)] === dp[at(i, j - 1)]) j--;
      else { w0 = i - 1; v0 = j - 1; if (w1 < 0) { w1 = i - 1; v1 = j - 1; } if (i - 1 >= (newFrom || 0)) fresh++; i--; j--; }
    }
    return { score: dp[at(W, V)], n: cnt[at(W, V)], w0, w1, v0, v1, fresh };
  }

  class FuzzyQuoteIndex {
    constructor() { this.ids = []; this.toks = []; this.post = new Map(); this.ready = false; this.N = 0; }
    get size() { return this.ids.length; }
    build(bible, chunk) {
      chunk = chunk || 3000;
      const list = [];
      bible.books.forEach((chs, bi) => chs.forEach((vs, ci) => vs.forEach((txt, vi) => list.push([bi + 1, ci + 1, vi + 1, txt]))));
      let pos = 0;
      return new Promise(resolve => {
        const step = () => {
          const end = Math.min(list.length, pos + chunk);
          for (; pos < end; pos++) {
            const [b, c, v, txt] = list[pos];
            const toks = qtokens(txt).map(soft).filter(Boolean);
            const id = this.ids.length;
            this.ids.push([b, c, v]); this.toks.push(toks);
            for (const t of new Set(toks)) { let a = this.post.get(t); if (!a) { a = []; this.post.set(t, a); } a.push(id); }
          }
          if (pos < list.length) setTimeout(step, 0);
          else {
            this.N = this.ids.length;
            for (const [k, a] of this.post) this.post.set(k, Int32Array.from(a));
            this.ready = true;
            resolve(this);
          }
        };
        step();
      });
    }
    idf(t) { const p = this.post.get(t); return p ? Math.log(this.N / p.length) : Math.log(this.N); }
    // words: qtokens of what was just said. Returns the best verse or null.
    query(words, newFrom, prefer) {
      if (!this.ready || words.length < 4) return null;
      const w = words.map(soft);
      newFrom = newFrom || 0;
      const score = new Map(), seen = new Set();
      for (const t of w) {
        if (seen.has(t) || t.length < 2) continue;
        seen.add(t);
        const p = this.post.get(t);
        if (!p || p.length > 2500) continue;          // too common to tell verses apart
        const f = Math.log(this.N / p.length);
        for (let k = 0; k < p.length; k++) score.set(p[k], (score.get(p[k]) || 0) + f);
      }
      const cands = [...score].filter(([, sc]) => sc >= this.minCand).sort((a, b) => b[1] - a[1]).slice(0, 40);
      const weight = t => Math.min(6, this.idf(t));
      const found = [];
      for (const [id] of cands) {
        const v = this.toks[id];
        const a = alignWords(w, v, weight, newFrom);
        if (a.n < this.minWords || a.fresh < 3) continue;       // most of it must come from what was just said
        const dense = a.n / (a.w1 - a.w0 + 1);              // the spoken words that matched are close together
        const vdense = a.n / (a.v1 - a.v0 + 1);             // ... and so are the verse words they matched
        const cover = a.n / v.length;                       // how much of the verse was said
        const strong = a.score >= this.minScore || (cover >= 0.65 && a.score >= this.minScore * 0.72);
        if (dense < this.minDense || vdense < 0.5 || !strong) continue;
        const [cb, cc] = this.ids[id];
        const bonus = prefer && prefer.book === cb ? (prefer.chapter === cc ? 1.25 : 1.1) : 1;   // the chapter being preached
        found.push({ id, score: a.score * bonus, n: a.n, cover, fresh: a.fresh });
      }
      if (!found.length) return null;
      found.sort((x, y) => y.score - x.score);
      const best = found[0];
      // the same saying in other places (the Gospels often tell one story twice or three times)
      const alsoIn = found.slice(1).filter(r => r.score > best.score * 0.92).slice(0, 3)
        .map(r => ({ book: this.ids[r.id][0], chapter: this.ids[r.id][1], verse: this.ids[r.id][2] }));
      const [b, c, v] = this.ids[best.id];
      return { book: b, chapter: c, verse: v, hits: best.n, fresh: best.fresh, weight: best.score, coverage: best.cover, fuzzy: true, alsoIn, ambiguous: alsoIn.length > 0 };
    }
  }
  FuzzyQuoteIndex.prototype.minCand = 9;
  FuzzyQuoteIndex.prototype.minWords = 4;
  FuzzyQuoteIndex.prototype.minDense = 0.5;
  FuzzyQuoteIndex.prototype.minScore = 15;
  // How much of a verse's text was just said (used to follow the reader into the next verse).
  function verseSimilarity(words, verseText, idfOf) {
    const w = words.map(soft).filter(Boolean), v = qtokens(verseText).map(soft).filter(Boolean);
    if (!w.length || !v.length) return { n: 0, cover: 0, score: 0, startsAt: -1, endsAt: -1, dense: 0 };
    const a = alignWords(w, v, idfOf || (() => 1));
    return { n: a.n, cover: a.n / v.length, score: a.score, startsAt: a.n ? a.v0 : -1, endsAt: a.n ? a.v1 : -1, dense: a.n ? a.n / (a.w1 - a.w0 + 1) : 0, len: v.length };
  }

  // ------------------------------------------------------------------
  // Set prayers and formulas (Settings -> Set prayers; kept in data/phrases.json). Words said in every service
  // are not a quotation: «باسم الآب والابن والروح القدس» is not Matthew 28:19, and the Lord's Prayer is not Luke 11:2.
  //   ignore -> the phrase's words are left out when quotes are looked for
  //   card   -> a card for the phrase's verse, never on the screen by itself
  //   show   -> a card for the phrase's passage, on the screen like a clear quote (the Lord's Prayer -> Matthew 6:9-13)
  // A phrase is known by its first five words (little words like «في» / "of" not counted), small spelling slips
  // allowed ("اروح القدس", "الروح القدوس"): all five, or four of them when the phrase then goes on as written.
  // ------------------------------------------------------------------
  const DEFAULT_PHRASES = [
    { text: 'باسم الآب والابن والروح القدس الإله الواحد آمين', action: 'ignore' },
    { text: 'المجد للآب والابن والروح القدس الآن وكل أوان وإلى دهر الداهرين آمين', action: 'ignore' },
    { text: 'in the name of the Father and of the Son and of the Holy Spirit', action: 'ignore' },
    { text: 'glory be to the Father and to the Son and to the Holy Spirit', action: 'ignore' },
    { text: 'نعمة ربنا يسوع المسيح ومحبة الله وشركة الروح القدس مع جميعكم', action: 'card', ref: '2 Corinthians 13:14' },
    { text: 'أبانا الذي في السماوات ليتقدس اسمك ليأت ملكوتك لتكن مشيئتك', action: 'show', ref: 'Matthew 6:9-13' },
    { text: 'قدوس قدوس قدوس رب الجنود مجده ملء كل الأرض', action: 'card', ref: 'Isaiah 6:3' },
  ];
  const PHRASE_STOP = new Set(['من', 'في', 'علي', 'الي', 'عن', 'مع', 'ما', 'لا', 'يا', 'و', 'ان', 'او',
    'the', 'of', 'and', 'in', 'to', 'a', 'an', 'be', 'is', 'for', 'with', 'by', 'at', 'on', 'as']);
  const one = () => 1;
  class Phrases {
    constructor(list, bible) {
      this.items = [];
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || p.off || typeof p.text !== 'string') continue;
        const en = !/[\u0600-\u06FF]/.test(p.text);
        const toks = this._content(en ? enTokens(p.text) : qtokens(p.text), en).map(x => x.w);
        if (toks.length < 3) continue;
        const action = p.action === 'show' || p.action === 'card' ? p.action : 'ignore';
        let ref = null;
        if (action !== 'ignore') {
          ref = typeof p.ref === 'string' ? parseQuery(p.ref, bible) : p.ref;
          if (!ref || ref.verse == null || (bible && !bible.valid(ref.book, ref.chapter, ref.verse))) continue;
        }
        const head = toks.slice(0, 5);
        this.items.push({ en, head, tail: toks.slice(5), need: Math.max(3, head.length - 1), action, ref, text: p.text });
      }
    }
    // the words that count, each with its place in the list it came from
    _content(words, en) {
      const out = [];
      words.forEach((w, i) => { if (PHRASE_STOP.has(w)) return; const k = en ? w : soft(w.replace(/^[وف](?=.{3})/, '')); if (k) out.push({ w: k, i }); });
      return out;
    }
    // words: what was just said (qtokens, or enTokens for English). -> { keep: one true/false per word, hits: the phrases found }
    scan(words, en) {
      const keep = words.map(() => true), hits = [];
      if (!this.items.some(it => it.en === en)) return { keep, hits };
      const c = this._content(words, en);
      for (const it of this.items) {
        if (it.en !== en) continue;
        for (let p = 0; p + it.need <= c.length; p++) {
          if (!keep[c[p].i]) continue;
          const win = c.slice(p, p + it.head.length + 2);
          const a = alignWords(win.map(x => x.w), it.head, one);
          if (a.n < it.need || a.w0 !== 0) continue;
          let last = p + a.w1, more = 0;
          if (it.tail.length) {                       // the rest of the phrase, as far as it was said
            const rest = c.slice(last + 1, last + 1 + it.tail.length + 2);
            const b = alignWords(rest.map(x => x.w), it.tail, one);
            if (b.n && b.w0 <= 1 && b.n / (b.w1 - b.w0 + 1) >= 0.6) { last += 1 + b.w1; more = b.n; }
          }
          // one of the five was missed: then the phrase must go on as written («نعمة ربنا يسوع المسيح» alone is not the benediction)
          if (a.n < it.head.length && it.tail.length && more < Math.min(2, it.tail.length)) continue;
          for (let k = c[p].i; k <= c[last].i; k++) keep[k] = false;
          hits.push(it);
          p = last;
        }
      }
      return { keep, hits };
    }
  }

  // ------------------------------------------------------------------
  // Detector: streaming + dedup + context
  // ------------------------------------------------------------------
  const SEEN = {};      // _quote: the verse these words belong to was found or shown a moment ago
  class Detector {
    constructor(bible, opts) {
      this.bible = bible;
      this.opts = Object.assign({ dedupMs: 90000, contextMs: 240000, tailTokens: 10, quoteWindow: 22, partMs: 15000, quotes: true }, opts || {});
      this.recent = new Map();  // what was found or shown lately: key -> time
      this.guessed = new Map(); // the same for guesses (cards to check)
      this.context = null;      // {book, chapter, time}
      this.guess = null;        // the same, from a book name that was only guessed: used when there is no other context
      this.tail = [];
      this.quoteWords = [];
      this.enQuoteWords = [];
      this.part = { ar: null, en: null };   // the words that found a verse a moment ago: the next sentence may be the rest of it
      this.quoteIndex = null;      // Arabic
      this.enQuoteIndex = null;    // English (one or more translations)
      this.seq = 0;
      this.setPhrases(this.opts.phrases || DEFAULT_PHRASES);
    }
    setPhrases(list) { this.phrases = new Phrases(list, this.bible); }
    setQuoteIndex(qi) { this.quoteIndex = qi; }
    setFuzzyQuoteIndex(fi) { this.fuzzyIndex = fi; }
    setEnglishQuoteIndex(qi) { this.enQuoteIndex = qi; }
    // The operator put something on screen: later "عدد ٥" means that chapter.
    setContext(book, chapter, now) { this.context = { book, chapter, time: now || Date.now() }; this.guess = null; }
    reset() { this.recent.clear(); this.guessed.clear(); this.context = null; this.guess = null; this.tail = []; this.quoteWords = []; this.enQuoteWords = []; this.part = { ar: null, en: null }; }

    _key(r) { return `${r.book}:${r.chapter}:${r.verse || 0}${r.verseEnd ? '-' + r.verseEnd : ''}`; }

    // "حبقوق 317": the speech engine wrote chapter and verse as one number
    _splitJoined(r) {
      const s = String(r.chapter), ok = [];
      if (r.verse != null || !/^\d{3,4}$/.test(s)) return null;
      for (let k = 1; k < s.length; k++) {
        const c = +s.slice(0, k), v = +s.slice(k);
        if (s[k] !== '0' && this.bible.valid(r.book, c, v)) ok.push([c, v]);
      }
      if (!ok.length) return null;
      return Object.assign({}, r, { chapter: ok[0][0], verse: ok[0][1], probable: r.probable || ok.length > 1 });   // two ways to read it: a guess
    }

    _accept(r, source, now, again) {
      // «103 عدد 3», taken for a psalm by its number alone: for certain only while the Psalms are being read
      if (r.psalmGuess && !(this.context && now - this.context.time <= this.opts.contextMs && this.context.book === 19)) r = Object.assign({}, r, { probable: true });
      // resolve context refs
      if (r.book == null) {
        const fresh = x => x && now - x.time <= this.opts.contextMs;
        const ctx = fresh(this.context) ? this.context : fresh(this.guess) ? this.guess : null;
        if (!ctx) return null;
        r = Object.assign({}, r, { book: ctx.book, chapter: r.chapter != null ? r.chapter : ctx.chapter });
        if (ctx === this.guess) r.probable = true;     // the chapter itself was a guess, so this is one too
        if (r.chapter == null) return null;
      } else if (!this.bible.valid(r.book, r.chapter, null)) {
        r = this._splitJoined(r);
        if (!r) return null;
      }
      if (!this.bible.valid(r.book, r.chapter, null)) return null;
      if (r.verse != null && !this.bible.valid(r.book, r.chapter, r.verse)) {
        if (r.strict) return null;                                   // a misheard book name with a verse that isn't there: not a reference
        r = Object.assign({}, r, { verse: null, verseEnd: null });   // misheard verse: keep chapter
      }
      if (r.verseEnd === -1 && r.verse != null) r = Object.assign({}, r, { verseEnd: this.bible.verseCount(r.book, r.chapter) });
      // "مزمور واحد من واحد لعشرة" (the psalm has six verses): to the end of the chapter
      if (r.verseEnd != null && r.verse != null && r.verseEnd > this.bible.verseCount(r.book, r.chapter)) r = Object.assign({}, r, { verseEnd: this.bible.verseCount(r.book, r.chapter) });
      if (r.verseEnd != null && (r.verseEnd <= r.verse || !this.bible.valid(r.book, r.chapter, r.verseEnd))) r = Object.assign({}, r, { verseEnd: null });
      const key = this._key(r);
      // found a moment ago: nothing new. (A guess is kept apart: it must not stop the verse being found for certain,
      // by its words or its reference, a moment later.)
      // (A reference that is said again is meant: "can you bring that back up? Matthew 28:19". Only the same words
      //  heard twice within a few seconds, as a preview and then as the finished sentence, are one mention.)
      // (again: a quote of a verse found a moment ago, passed on all the same: see _quote)
      const said = (source === 'reference' || source === 'context') && r.verse != null && !r.probable;
      const seen = m => { const last = m.get(key); return last && now - last < (said && m === this.recent ? 8000 : this.opts.dedupMs); };
      if (!again && (seen(this.recent) || (r.probable && seen(this.guessed)))) return null;
      // a chapter-only hit right after the same chapter+verse was found adds nothing
      if (r.verse == null) {
        for (const m of r.probable ? [this.recent, this.guessed] : [this.recent])
          for (const [k, tm] of m) if (k.startsWith(`${r.book}:${r.chapter}:`) && now - tm < this.opts.dedupMs) return null;
      }
      (r.probable ? this.guessed : this.recent).set(key, now);
      // a guess must not decide what a later «عدد ٥» means while a chapter that was heard clearly is being preached
      if (r.probable) this.guess = { book: r.book, chapter: r.chapter, time: now };
      else { this.context = { book: r.book, chapter: r.chapter, time: now }; this.guess = null; }
      const c = {
        id: ++this.seq, key, source,
        book: r.book, chapter: r.chapter, verse: r.verse, verseEnd: r.verseEnd || null,
        label: refLabel(r), labelEn: refLabel(r, { lang: 'en' }),
        text: r.verse != null ? this.bible.verse(r.book, r.chapter, r.verse) : null,
        time: now,
      };
      if (r.probable) c.probable = true;
      if (r.from && c.verse != null && !c.verseEnd) c.from = true;
      return c;
    }

    processFinal(text, now) {
      now = now || Date.now();
      this.interimRefs = [];
      const english = isEnglish(text);
      const lang = english ? 'en' : 'ar';
      const toks = tokenize(text);
      const all = this.tail.concat(toks);
      const offset = this.tail.length;
      const out = [];
      for (const r of findRefs(all)) {
        if (r.end <= offset) continue;
        const c = this._accept(r, r.kind, now);
        if (c) { c.lang = lang; out.push(c); }
      }
      this.tail = all.slice(-this.opts.tailTokens);
      const index = english ? this.enQuoteIndex : this.quoteIndex;
      if (!this.opts.quotes || !index || !index.ready) return out;
      const L = this._look(text, english, now);
      for (const it of L.hits) { const c = it.ref && this._phrase(it, now, lang); if (c) out.push(c); }
      if (L.used) this.part[lang] = null;
      let words = L.words;
      const c = L.q ? this._take(L.q, now, L.grown) : null;
      if (c) { if (c !== SEEN) { c.lang = lang; out.push(c); } this.part[lang] = { words, q: L.q, added: L.added, time: now }; words = []; }
      if (english) this.enQuoteWords = words; else this.quoteWords = words;
      return out;
    }

    // The words to look for a quote in (the last few said and this text, without the set prayers and formulas among
    // them) and the verse found in them. Changes nothing: processFinal acts on what it returns, quoteLive only looks.
    _look(text, english, now) {
      const lang = english ? 'en' : 'ar';
      const fresh = english ? enTokens(text) : qtokens(text);
      let words = (english ? this.enQuoteWords : this.quoteWords).concat(fresh), added = fresh.length;
      const { keep, hits } = this.phrases.scan(words, english);
      if (hits.length) {
        added = keep.slice(words.length - fresh.length).filter(Boolean).length;
        words = words.filter((w, k) => keep[k]);
      }
      words = words.slice(-this.opts.quoteWindow);
      const newFrom = Math.max(0, words.length - added);
      // A verse said in pieces («لأنه هكذا أحب الله العالم» … «حتى بذل ابنه الوحيد»): the first piece found the verse, which
      // uses its words up, and the next piece alone is too short to find it. So the piece before is looked at together
      // with this sentence first: more of the same verse than before is the verse being said in full (grown).
      let q = null, grown = false;
      const part = this.part[lang], used = !!(part && added >= 2);
      if (used && now - part.time <= this.opts.partMs) {
        const joined = part.words.concat(words.slice(newFrom)).slice(-this.opts.quoteWindow);
        const j = this._find(joined, Math.max(0, joined.length - added - part.added), english, now);
        if (j && j.book === part.q.book && j.chapter === part.q.chapter && j.verse === part.q.verse && (!!j.fuzzy !== !!part.q.fuzzy || j.hits > part.q.hits)) {
          q = j; grown = true; words = joined; added = Math.min(joined.length, added + part.added);
        }
      }
      if (!q) q = this._find(words, newFrom, english, now);
      return { q, grown, words, added, hits, used };
    }
    // Words still being said: the verse they quote, if any -> { q, grown, lang }. Nothing is changed (the sentence is
    // looked at afresh when it is finished); take() makes the card when the screen rules want it now.
    quoteLive(text, now) {
      const english = isEnglish(text), index = english ? this.enQuoteIndex : this.quoteIndex;
      if (!this.opts.quotes || !index || !index.ready) return null;
      const L = this._look(text, english, now || Date.now());
      return L.q ? { q: L.q, grown: L.grown, lang: english ? 'en' : 'ar' } : null;
    }
    take(found, now) {
      const key = `${found.q.book}:${found.q.chapter}:${found.q.verse}`, before = { key, recent: this.recent.get(key), guess: this.guess };
      const c = this._take(found.q, now || Date.now(), found.grown);
      if (!c || c === SEEN) return null;
      c.lang = found.lang;
      c.undo = before;
      return c;
    }
    // … and given back: the screen rules did not want it yet, so it is as if it had not been looked at
    untake(c) {
      const u = c && c.undo;
      if (!u) return;
      if (u.recent === undefined) this.recent.delete(u.key); else this.recent.set(u.key, u.recent);
      this.guess = u.guess;
    }

    // a set prayer was said: the card for its verse or passage
    _phrase(it, now, lang) {
      const context = this.context, guess = this.guess;
      const c = this._accept({ book: it.ref.book, chapter: it.ref.chapter, verse: it.ref.verse, verseEnd: it.ref.verseEnd }, 'phrase', now);
      if (!c) return null;
      if (it.action === 'card') { c.cardOnly = true; this.context = context; this.guess = guess; }
      c.lang = lang; c.phrase = it.text;
      return c;
    }

    // The verse these words are from: word for word, or (Arabic) with a few words heard differently. Changes nothing.
    _find(words, newFrom, english, now) {
      const index = english ? this.enQuoteIndex : this.quoteIndex;
      const fuzzy = !english && this.fuzzyIndex && this.fuzzyIndex.ready ? this.fuzzyIndex : null;
      const prefer = this.context && now - this.context.time < this.opts.contextMs ? this.context : null;
      const q = index.query(words, newFrom, prefer) || (fuzzy && fuzzy.query(words, newFrom, prefer)) || null;
      // A few words in a row are a verse's, word for word: more of that same verse may have been said with a word or
      // two different («الرب راعي فلا يعوزني شيئا»: «شيء»). That fuller match is kept beside the first one (match.more).
      if (q && !q.fuzzy && q.hits < 4 && fuzzy) {
        const f = fuzzy.query(words, newFrom, prefer);
        if (f && f.book === q.book && f.chapter === q.chapter && f.verse === q.verse && f.hits >= 5) q.more = { hits: f.hits, coverage: f.coverage, fresh: f.fresh, one: !(f.alsoIn && f.alsoIn.length) };
      }
      return q;
    }
    // … and its card. (grown: the rest of a verse whose first words were found a moment ago.)
    _take(q, now, grown) {
      const ctx = this.context;
      const last = this.recent.get(`${q.book}:${q.chapter}:${q.verse}`);
      // found or shown a moment ago: no new card, and its words are used up. The screen rules ask to be told all the
      // same (opts.again): the verse may have left the screen since, and saying it again then brings it back.
      const again = !!(last && now - last < this.opts.dedupMs);
      if (again && !this.opts.again) return SEEN;
      const c = this._accept({ book: q.book, chapter: q.chapter, verse: q.verse }, 'quote', now, again);
      if (!c) return again ? SEEN : null;
      if (again) c.again = true;
      if (again && grown) c.grown = true;
      c.match = { hits: q.hits, coverage: q.coverage, fuzzy: !!q.fuzzy, fresh: q.fresh, weight: q.weight };
      if (q.more) c.match.more = q.more;
      this.context = ctx;                      // quoted words do not decide what a later «عدد ٩» means: the last reference, or the verse on screen, does
      c.alsoIn = (q.alsoIn || []).map(r => Object.assign({}, r, { label: refLabel(r), labelEn: refLabel(r, { lang: 'en' }) }));
      return c;
    }

    // Interim text changes as the recognizer refines it, so only accept complete
    // book+chapter+verse references that are not at the very end of the text.
    processInterim(text, now) {
      now = now || Date.now();
      const all = this.tail.concat(tokenize(text));
      const offset = this.tail.length;
      const out = [];
      const lang = isEnglish(text) ? 'en' : 'ar';
      // The last word of a preview is often a guess at a word cut in half («يوحنا ثلاثة ستة عام» on the way to
      // «ستة عشر»): a reference counts once two previews in a row have it.
      const before = this.interimRefs || [], now_ = [];
      for (const r of findRefs(all)) {
        if (r.end <= offset || r.end >= all.length || r.kind !== 'reference' || r.verse == null) continue;
        const k = `${r.book}:${r.chapter}:${r.verse}:${r.verseEnd || 0}`;
        now_.push(k);
        if (!before.includes(k)) continue;
        const c = this._accept(r, 'reference', now);
        if (c) { c.lang = lang; out.push(c); }
      }
      this.interimRefs = now_;
      return out;
    }
  }

  // Spoken navigation: "العدد اللي بعده" / "الآية التالية" -> 'next', "العدد اللي قبله" -> 'prev'.
  // Needs a verse word (عدد / آية) so ordinary "اللي بعده" in a sentence doesn't trigger it.
  const NAV_VERSE = '[وفب]?(?:لل|ل)?(?:العدد|عدد|الايه|الاعداد|اعداد|الايات)';
  const NAV_REL = '(?:\\s+(?:اللي|الي|الذي|التي|اللى|لي|الل))?';
  const NAV_NEXT = new RegExp(`(?:^|\\s)${NAV_VERSE}${NAV_REL}\\s+(?:بعده|بعدها|بعديه|بعديها|بعد كده|بعد كدا|بعد ده|التالي|التاليه|الجاي|الجايه|اللي جاي)(?=\\s|$)|\\b(next|following) verse\\b|\\bverse after (that|this)\\b`);
  const NAV_PREV = new RegExp(`(?:^|\\s)${NAV_VERSE}${NAV_REL}\\s+(?:قبله|قبلها|قبليه|قبليها|قبل كده|قبل كدا|السابق|السابقه|فات|اللي فات|الي فات)(?=\\s|$)|\\b(previous|preceding) verse\\b|\\bverse before (that|this)\\b`);
  // "اللي بعده" / "اللي قبله" on their own. Everyday speech uses them too ("اليوم اللي بعده" = the
  // next day, "واللي بعده جه" = the one after him came), so they only count when they end the
  // sentence or come before a reading word ("اللي بعده بيقول"), and not after an ordinary noun.
  const NAV_BARE_REL = new Set(['اللي', 'الي', 'واللي', 'والي', 'فاللي', 'فالي', 'للي', 'وللي']);
  const NAV_BARE_NEXT = new Set(['بعده', 'بعدها', 'بعديه', 'بعديها']);
  const NAV_BARE_PREV = new Set(['قبله', 'قبلها', 'قبليه', 'قبليها']);
  const NAV_READ_NOUNS = new Set(['العدد', 'الايه', 'الاعداد', 'الايات', 'الكلام', 'الجزء', 'المقطع', 'السطر', 'الشاهد']);
  const NAV_READ_AFTER = new Set(['بيقول', 'يقول', 'بتقول', 'تقول', 'بيكمل', 'كمان', 'برضه', 'برضو', 'بقي', 'ايضا', 'يا', 'علي', 'نقراه', 'نقراها']);
  const NAV_NARRATIVE = new Set(['جه', 'جاء', 'جا', 'جت', 'جات', 'قال', 'قالت', 'كان', 'كانت', 'عمل', 'عملت', 'راح', 'راحت', 'مات', 'ماتت',
    'ملك', 'حكم', 'دخل', 'خرج', 'طلع', 'نزل', 'اتكلم', 'اتولد', 'اتولدت', 'جاب', 'شاف', 'عاش', 'بقي_']);
  // "لما اقول اللي بعده بيجي اللي بعده": someone is describing what the screen does, not asking for it
  const NAV_COMES = new Set(['بيجي', 'بييجي', 'ييجي', 'يجي', 'هييجي', 'هيجي', 'بيجيب', 'يجيب', 'هيجيب', 'بيظهر', 'يظهر', 'هيظهر', 'بيطلع', 'يطلع', 'هيطلع']);
  // "مش في اللي بعديها": it is not in the one after it
  const NAV_NOT = new Set(['مش', 'ومش', 'مو', 'ليس', 'وليس']);
  function detectBareNav(text) {
    const w = normalize(text).split(' ').filter(Boolean);
    let res = null;
    for (let i = 0; i + 1 < w.length; i++) {
      if (!NAV_BARE_REL.has(w[i])) continue;
      const dir = NAV_BARE_NEXT.has(w[i + 1]) ? 'next' : NAV_BARE_PREV.has(w[i + 1]) ? 'prev' : null;
      if (!dir) continue;
      const before = (w[i - 1] || '').replace(/^[وفب](?=ال)/, ''), after = w[i + 2];
      if (before.startsWith('ال') && !NAV_READ_NOUNS.has(before)) continue;              // "(و)اليوم اللي بعده"
      if (NAV_COMES.has(w[i - 1])) continue;                                             // "بيجي اللي بعده"
      if (NAV_NOT.has(w[i - 1]) || NAV_NOT.has(w[i - 2])) continue;                      // "مش (في) اللي بعده"
      if (after && NAV_NARRATIVE.has(after)) continue;                                   // "واللي بعده جه"
      if (after && !NAV_READ_AFTER.has(after)) continue;                                 // must end the sentence or go on reading
      res = { dir, at: i };
    }
    return res;
  }
  // -> { dir: 'next' | 'prev', bare: true when only "اللي بعده" / "اللي قبله" was said } or null
  function detectNavDetail(text) {
    const n = normalize(text);
    const mn = n.search(NAV_NEXT), mp = n.search(NAV_PREV);
    if (mn >= 0 || mp >= 0) {
      const dir = mp < 0 ? 'next' : mn < 0 ? 'prev' : (mn > mp ? 'next' : 'prev');   // whichever was said last
      return { dir, bare: false };
    }
    // the one word, and nothing else: "Next." / «التالي» ("Next verse." after an Arabic verse is often written «التالي»)
    if (/^(?:التالي|التاليه|next|next one)$/.test(n)) return { dir: 'next', bare: true };
    if (/^(?:السابق|السابقه|previous|previous one)$/.test(n)) return { dir: 'prev', bare: true };
    // what Google writes for "next verse" when it mishears it, as all that was said: "next word", "Nexus 1", «اكس بوكس», «نكسبر»
    if (/^(?:the )?next (?:verses|words?|first|birth|purse|worse|nurse)$|^nexus(?: (?:1|one|1 st|first))?$/.test(n)
      || /^(?:ال)?اكس بوكس$|^نكست(?: ?(?:فيرس|فرس|فيرز|بيرس))?$|^نكس ?(?:بر|فيرس|فرس|فيرز|بيرس)$|^نيكست(?: ?فيرس)?$/.test(n)) return { dir: 'next', bare: true };
    const b = detectBareNav(text);
    // «واللي بعدها؟» as a question is asked of the people listening (what comes next in a list, who reads on), not of
    // the screen; a reading that goes on is followed anyway
    if (b && /(?:[وفب]?ال{1,2}[يى]|و?لل[يى])\s+(?:بعد|قبل)(?:ه|ها|يه|يها)\s*[؟?]/.test(text)) return null;
    return b ? { dir: b.dir, bare: true } : null;
  }
  function detectNav(text) {
    const d = detectNavDetail(text);
    return d ? d.dir : null;
  }

  // ------------------------------------------------------------------
  // Video titles (YouTube playlists): notice when the speaker says a title
  // ------------------------------------------------------------------
  // Words that describe a video rather than name it; trimmed from the ends of title phrases.
  const VIDEO_GENERIC = new Set(['موسيقي', 'الموسيقي', 'ترنيمه', 'الترنيمه', 'ترانيم', 'توزيع', 'عزف', 'بيانو', 'كاريوكي',
    'لحن', 'كلمات', 'الكلمات', 'بالكلمات', 'كلمه', 'فيديو', 'الفيديو', 'كليب', 'اغنيه', 'اغاني', 'حصري', 'حصريا', 'جديد', 'جديده', 'كامله',
    'مع', 'اطفال', 'للاطفال', 'قصيده', 'هادئه', 'هاديه', 'مترجمه', 'مترجم', 'بالعربي',
    'official', 'video', 'audio', 'music', 'lyrics', 'lyric', 'instrumental', 'karaoke', 'piano', 'cover', 'hd', '4k',
    'live', 'full', 'version', 'new', 'hymn', 'song', 'worship', 'ctv', 'sat7', 'wmv', 'mp4', 'mp3', 'avi', 'mov', 'flv']);
  const isGeneric = w => VIDEO_GENERIC.has(w) || (w.length > 3 && /^[وب]/.test(w) && VIDEO_GENERIC.has(w.slice(1)));
  // Words that announce a song/video ("هنرنم ترنيمة …", "نشوف فيديو …"): needed before short titles.
  const VIDEO_CUES = new Set(['ترنيمه', 'الترنيمه', 'ترنيمة', 'نرنم', 'هنرنم', 'رنموا', 'نرنملك', 'نسبح', 'هنسبح', 'فيديو', 'الفيديو',
    'نشوف', 'هنشوف', 'نسمع', 'هنسمع', 'اغنيه', 'موسيقي', 'تشغيل', 'شغل', 'شغلوا', 'شغلي', 'نشغل', 'ترنيمتنا', 'ترانيم', 'لحن',
    'sing', 'song', 'hymn', 'play', 'video']);
  const stripAl = w => w.replace(/^و(?=..)/, '').replace(/^(ال|لل)(?=..)/, '');
  // Speech engines spell sung titles loosely: "تفوك" / "التفوق" for «تفك», "زبيحة" for «ذبيحة», "نفس" for
  // «نفسي». The skeleton keeps the consonants (no long vowels, no final vowel) and merges letters that
  // sound alike in Egyptian Arabic (ق/ك, ذ/ظ/ز, ث/ص/س, ط/ت, ض/د).
  const skelCache = new Map();
  function skel(w) {
    let k = skelCache.get(w);
    if (k !== undefined) return k;
    k = stripAl(w);
    if (/^[ء-ي]{2,}$/.test(k)) {
      if (k.length > 3) k = k.replace(/[اهي]$/, '');
      k = (k[0] + k.slice(1).replace(/[اوي]/g, ''))
        .replace(/ق/g, 'ك').replace(/[ذظ]/g, 'ز').replace(/[ثص]/g, 'س').replace(/ط/g, 'ت').replace(/ض/g, 'د');
    }
    if (skelCache.size > 20000) skelCache.clear();
    skelCache.set(w, k);
    return k;
  }
  // "ياسيدي" / "يا سيدي", "يامفتاح" / "يا مفتاح": titles and speech engines write the vocative both ways
  const NOT_YA = new Set(['ياسمين', 'ياسر', 'يارا', 'ياكل', 'ياخد', 'يافا', 'ياقوت', 'يابس', 'يانصيب']);
  const splitYa = toks => toks.flatMap(w => (/^يا[ء-ي]{2,}$/.test(w) && !NOT_YA.has(w) ? ['يا', w.slice(2)] : [w]));
  function lev1(a, b) {          // true when edit distance <= 1
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  function tokEq(a, b) {
    if (a === b) return true;
    const x = stripAl(a), y = stripAl(b);
    if (x === y && x.length >= 2) return true;
    return Math.min(x.length, y.length) >= 4 && lev1(x, y);    // عايز / عايزه
  }
  // How well a spoken word matches a title word: 1 = same word, 0.8 = same skeleton ("تفوك" / «تفك»),
  // 0.6 = skeletons one letter apart ("اقدم" / «باقدم»), 0 = different.
  function tokSim(a, b) {
    if (tokEq(a, b)) return 1;
    // «رب» / «ربي», «قلب» / «قلبي»: the "my" at the end comes and goes when a title is said, and when it is heard
    if ((a === b + 'ي' || b === a + 'ي') && Math.min(a.length, b.length) >= 2) return 0.8;
    // «لهم» for «الهم»: the article's alef swallowed, as Soniox wrote it (26 Nov)
    if ((b === 'ا' + a || a === 'ا' + b) && /^ال/.test(a.length > b.length ? a : b) && Math.min(a.length, b.length) >= 3) return 0.8;
    const x = skel(a), y = skel(b);
    if (x.length < 3 || y.length < 3) return 0;
    if (x === y) return 0.8;
    return lev1(x, y) ? 0.6 : 0;
  }
  // Lines up a title phrase p with spoken words w (in order, gaps allowed), scoring each word with
  // tokSim. Two title words the speech engine wrote as one ("لايكون" for «لا يكون») or one title word
  // it split in two still count. Returns [score, number of spoken words used].
  // How many letters must change for a to become the beginning of b (b may go on after it).
  function prefixDist(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return Math.min(...prev);
  }
  function align(p, w) {
    const n = p.length, L = w.length;
    const GAP = 0.25;              // each extra spoken word inside the title costs a little
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Float64Array(L + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= L; j++) {
        let v = Math.max(dp[i - 1][j], dp[i][j - 1] - (i < n ? GAP : 0), dp[i - 1][j - 1] + tokSim(p[i - 1], w[j - 1]));
        if (i >= 2) { const x = tokSim(p[i - 2] + p[i - 1], w[j - 1]); if (x) v = Math.max(v, dp[i - 2][j - 1] + 2 * x); }
        if (j >= 2) { const x = tokSim(p[i - 1], w[j - 2] + w[j - 1]); if (x) v = Math.max(v, dp[i - 1][j - 2] + x); }
        dp[i][j] = v;
      }
    }
    const best = dp[n][L];
    let used = L;
    while (used > 0 && dp[n][used - 1] >= best - 1e-9) used--;
    return [best, used];
  }
  // a cue word, also when misheard ("ترنيمي" for «ترنيمة»)
  const CUE_SKELS = new Set(['ترنيمه', 'نرنم', 'هنرنم', 'رنموا', 'نرنملك', 'هنرنملك', 'ترنيمتنا', 'ترانيم', 'ترنيمت', 'ترنيمات'].map(skel));
  const CUE_LONG = [...CUE_SKELS].filter(k => k.length >= 4);
  const isCue = w => VIDEO_CUES.has(w) || VIDEO_CUES.has(stripAl(w)) || CUE_SKELS.has(skel(w)) ||
    (w.length >= 5 && /^[ء-ي]+$/.test(w) && skel(w).includes('رنم') && CUE_LONG.some(k => lev1(skel(w), k)));

  // ---- Was the hymn announced? -------------------------------------------------------------------------------------
  // A hymn starts by itself only when the speaker says that we are about to sing, hear or play it: «خلونا نرنم مع بعض
  // ترنيمة …», «تعالوا نسبح ونقول …», «نكمل تسبيح ونقول …», «نسمع ترنيمة …», «شغلوا …», "let's sing …" (how worship
  // leaders say it in the recorded services). A first line said in a prayer, a title on its own, or a hymn quoted in a
  // sermon («فيه ترنيمة جميلة بتقول …») makes a card, and Play is one click.
  // (17 Nov 2026: «يا راويني يا يسوع بحنانك», said to try it out, started the video. "So anyone who stands up and says
  //  that sets it off?")
  // we sing / we praise / (to the operator) play
  const WE_SING = new Set(['نرنم', 'هنرنم', 'حنرنم', 'بنرنم', 'نرتل', 'هنرتل', 'حنرتل', 'نسبح', 'هنسبح', 'حنسبح', 'بنسبح', 'نغني', 'هنغني', 'حنغني',
    'نشغل', 'هنشغل', 'شغل', 'شغلوا', 'شغلي']);
  const WE_SING_SKELS = new Set(['نرنم', 'هنرنم', 'حنرنم'].map(skel));
  // "we" and "let us" beside a word for a hymn («نسمع ترنيمة», «تعالوا … الترنيمة دي», "let's … song")
  const WE_OTHER = new Set(['نسمع', 'هنسمع', 'حنسمع', 'نشوف', 'هنشوف', 'حنشوف', 'نقول', 'هنقول', 'بنقول', 'نكمل', 'هنكمل', 'نختم', 'هنختم', 'نبدا', 'هنبدا', 'نبتدي',
    'نقف', 'نرجع', 'تعالوا', 'تعالو', 'تعالي', 'تعال', 'خلونا', 'خلينا', 'يلا', 'يالا', 'ياللا', 'هيا', 'let', 'lets', 'we', 'well', 'will', 'gonna', 'together', 'everybody', 'everyone', 'please']);
  // a hymn, a song, a video ("sing" and "play" too: in English they need the "let's" as much as the noun does)
  const SING_NOUN = new Set(['ترنيمه', 'ترنيمتنا', 'ترانيم', 'تسبيح', 'تسبيحنا', 'تسبيحتنا', 'تسبحه', 'تسبيحه', 'فيديو', 'اغنيه', 'song', 'hymn', 'video', 'chorus', 'sing', 'play']);
  // words that stand between the announcement and the title («الترنيمة اللي بتقول …», «نرنم مع بعض …», «نرنم للرب ونقول …»)
  const CONNECT = new Set(['اللي', 'الي', 'التي', 'الذي', 'بتقول', 'تقول', 'بيقول', 'يقول', 'نقول', 'بنقول', 'هنقول', 'احنا', 'مع', 'بعض', 'بعضنا', 'كده', 'كدا', 'دي', 'ده', 'ديه', 'هذه', 'هذا',
    'كلنا', 'سوا', 'معا', 'بعنوان', 'اسمها', 'اسمه', 'للرب', 'رب', 'ربنا', 'يا', 'جماعه', 'في', 'و', 'كمان', 'دلوقتي', 'الان', 'النهارده', 'بقي', 'تاني',
    'called', 'titled', 'the', 'this', 'that', 'together', 'now', 'of', 'a', 'an', 'our', 'next', 'with', 'me', 'us', 'to', 's', 'all']);
  // … of those, the ones that never begin a title: skipped when looking for where the title starts («يا» and «رب»
  // begin a hundred titles, so they are not skipped there)
  const AFTER_CUE = new Set(['اللي', 'الي', 'التي', 'الذي', 'بتقول', 'تقول', 'بيقول', 'يقول', 'نقول', 'بنقول', 'هنقول', 'احنا', 'مع', 'بعض', 'بعضنا', 'كده', 'كدا', 'دي', 'ده', 'ديه', 'هذه', 'هذا',
    'كلنا', 'سوا', 'معا', 'بعنوان', 'اسمها', 'اسمه', 'للرب', 'و', 'كمان', 'دلوقتي', 'الان', 'النهارده', 'بقي', 'تاني',
    'called', 'titled', 'the', 'this', 'that', 'together', 'now', 'a', 'an', 'our', 'next', 'with', 'me', 'us', 'to', 's']);
  const isAfterCue = w => AFTER_CUE.has(w) || AFTER_CUE.has(w.replace(/^و(?=..)/, ''));
  // said to God, not to the congregation: «نسبح اسمك», «نرنم لك»
  const TO_GOD = new Set(['اسمك', 'لاسمك', 'لك', 'ليك', 'لشخصك', 'شخصك', 'بيك', 'فيك']);
  const bare = w => w.replace(/^[وف](?=...)/, '');
  const isWeSing = w => { const k = bare(w); return WE_SING.has(k) || (k.length >= 4 && /^[ء-ي]+$/.test(k) && !/^(ال|لل)/.test(k) && WE_SING_SKELS.has(skel(k))); };
  const HYMN_SKEL = skel('ترنيمه');
  const isHymnNoun = w => {
    const k = stripAl(w), k2 = k.replace(/^[بفل](?=...)/, '');
    // («ترنيمت على ضرب الأوتار»: the ة said as ت before the name that follows it, and written so)
    const k3 = /^[ء-ي]{4,}ت$/.test(k2) ? k2.slice(0, -1) + 'ه' : '';
    return SING_NOUN.has(k) || SING_NOUN.has(k2) || (!!k3 && SING_NOUN.has(k3)) ||
      (/^[ء-ي]{5,}$/.test(k) && (skel(k) === HYMN_SKEL || skel(k2) === HYMN_SKEL));       // ("ترنيمي" for «ترنيمة»)
  };
  // «ترنيمة» as the speech engines heard it in a family's test on 26 Nov: Soniox wrote «تقريباً» every time (nine times),
  // the local model «ترميمت» and «الترميم». They are words of their own too, so a hymn's name has to follow them as it is
  // written for them to count.
  const HYMN_MISHEARD = new Set(['تقريبا', 'التقريب', 'ترميم', 'الترميم', 'ترميمه', 'الترميمه', 'ترميمت']);
  const isMisheardHymn = w => HYMN_MISHEARD.has(w) || HYMN_MISHEARD.has(w.replace(/^و(?=...)/, ''));
  const isConnect = w => CONNECT.has(w) || CONNECT.has(stripAl(w));
  // «مرنم ترنيمة», «النم ترنيمي»: «نرنم» misheard, believed only right beside the word for a hymn
  const nearWeSing = w => { const k = bare(w); return k.length >= 3 && k.length <= 6 && /^[ء-ي]+$/.test(k) && [...WE_SING_SKELS].some(x => lev1(skel(k), x)); };
  // What announces the title that starts at words[s]? 'invite': we are about to sing or hear it. 'cue': a word for a
  // hymn or for singing is there, but not that. null: nothing. Looks back over the connecting words and up to two others.
  function herald(words, s) {
    let others = 0;
    for (let i = s - 1, n = 0; i >= 0 && n < 10; i--, n++) {
      const w = words[i];
      if (isWeSing(w)) return TO_GOD.has(words[i + 1]) ? 'cue' : 'invite';
      if (isHymnNoun(w)) {
        // "we" somewhere in the words before it («وخلينا نيجي كلنا كده بانكسار قدام الرب ونرنم مع بعض الترنيمة …»: the
        // «ونرنم» is often misheard, the «خلينا» ten words back is not), or «مع بعض» right before it
        if (!/^ترانيم$/.test(stripAl(w)) && words[i - 2] === 'مع' && /^بعض(نا)?$/.test(words[i - 1] || '')) return 'invite';
        for (let j = i - 1, m = 0; j >= 0 && m < 11; j--, m++) {
          const x = words[j];
          if ((isWeSing(x) && !TO_GOD.has(words[j + 1])) || WE_OTHER.has(bare(x)) || WE_OTHER.has(x) || (m < 2 && nearWeSing(x))) return 'invite';
        }
        return 'cue';
      }
      if (isCue(w)) return 'cue';
      if (!isConnect(w) && ++others > 2) return null;
    }
    return null;
  }
  // A hymn is named or announced in these words («ترنيمة …», «نرنم …»): words of a verse in them are the hymn's name
  // («ترنيمة باركي يا نفسي الرب» is not Psalm 104:35 said, 26 Nov), so they do not go up as the verse while being said.
  const saysHymn = text => splitYa(normalize(text).split(' ').filter(Boolean)).some(w => isHymnNoun(w) || isWeSing(w));
  // … or the title comes first: «أجمل من كل الناس. آمين، تعالوا نقف ونرنم الترنيمة دي»
  function heraldAfter(words, e) {
    let we = false;
    for (let i = e, n = 0; i < words.length && n < 8; i++, n++) {
      const w = words[i];
      if (isWeSing(w) || WE_OTHER.has(bare(w))) we = true;
      if (we && isHymnNoun(w) && /^(دي|ديه|ده|هذه)$/.test(words[i + 1] || '')) return 'invite';
    }
    return null;
  }

  // "(Official Video)" / "(موسيقي)" in brackets says nothing about the song; other words in brackets are its other name
  const BRACKET_JUNK = /^(official|video|audio|lyrics?|hd|4k|live|cover|instrumental|karaoke|music|موسيقي|موسيقى|كلمات|كلمات ولحن|كلمة ولحن|كلمه ولحن|بالكلمات|مترجمة|مترجمه|مترجم|حصري|حصريا|فيديو|كاريوكي)( .*)?$/i;
  function splitTitle(title) {
    let t = String(title || '')
      .replace(/\.(wmv|mp4|mp3|avi|mov|flv|mkv|webm)\b/gi, ' ')      // file names used as titles
      .replace(/[«»“”„"]/g, ' ')                                      // ترنيمة "سوف أدخل أبوابك": the quotes hold the song's name, keep it
      .replace(/#[^\s#]+/g, ' ')
      .replace(/[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F]/gu, ' ');    // emoji
    const extra = [];
    t = t.replace(/[([{【]([^)\]}】]*)[)\]}】]/g, (m, inner) => {
      const x = inner.trim();
      if (x && !BRACKET_JUNK.test(x)) extra.push(x);
      return ' | ';
    });
    // " - ", "- " and "-" between Arabic words ("سلامك فاق العقول- موسيقى وكلمات"), "_", "|", "/", "+", ".."
    return t.split(/\s+[-–—:_]\s*|\s*[-–—_]\s+|(?<=[\u0600-\u06FF])[-–—_](?=[\u0600-\u06FF])|\s*\.\.+\s*|[|｜•·/\+]+/)
      .concat(extra)
      // Arabic and English run together ("أقـوياء aqwiya2", "homghalabouh هم غلبوه"): two names
      .flatMap(x => (x || '').split(/(?<=[\u0600-\u06FF])\s+(?=[A-Za-z])|(?<=[A-Za-z0-9])\s+(?=[\u0600-\u06FF])/))
      .map(x => x.trim()).filter(Boolean);
  }

  // words every prayer is full of; a title made only of them can't be told apart from praying
  const TITLE_COMMON = new Set(['يا', 'رب', 'يارب', 'ربي', 'ربنا', 'الرب', 'انت', 'انا', 'احنا', 'في', 'من', 'علي', 'الي', 'لك', 'ليك', 'ليا', 'معايا',
    'يسوع', 'ايسوع', 'المسيح', 'الله', 'ابويا', 'سيدي', 'كل', 'مع', 'و', 'هو', 'هي', 'ده', 'دي', 'اللي', 'ما', 'لا']);

  class VideoMatcher {
    // videos: [{id, title, playlist}]
    constructor(videos, opts) {
      this.opts = Object.assign({ dedupMs: 5 * 60 * 1000, tailTokens: 24 }, opts || {});
      this.videos = videos || [];
      this.tail = [];
      this.recent = new Map();
      // boilerplate: title parts / words shared by many titles in the list ("توزيع بولس باسيلى")
      const partCount = new Map(), laterCount = new Map(), wordCount = new Map();
      const parts = this.videos.map(v => splitTitle(v.title).map(p => normalize(p)).filter(Boolean));
      for (const ps of parts) {
        for (const p of new Set(ps)) partCount.set(p, (partCount.get(p) || 0) + 1);
        for (const p of new Set(ps.slice(1))) laterCount.set(p, (laterCount.get(p) || 0) + 1);
        for (const w of new Set(ps.join(' ').split(' '))) wordCount.set(w, (wordCount.get(w) || 0) + 1);
      }
      const n = this.videos.length;
      // ... and singer / team / album names that follow the song's name in 3 or more titles
      // ("ترنيمة … - الحياة الأفضل"): saying them can't tell which video is meant
      const boiler = new Set([...partCount].filter(([p, c]) => (n >= 3 && c >= Math.max(3, n * 0.25)) || (laterCount.get(p) || 0) >= 3).map(([p]) => p));
      const HYMN = skel('ترنيمه');   // also misspelled in titles: "ترنمية"
      const commonWord = w => isGeneric(w) || skel(w) === HYMN || (n >= 4 && (wordCount.get(w) || 0) >= n * 0.6);
      this.entries = this.videos.map((v, i) => {
        const phrases = [];
        const seen = new Set();
        for (const part of parts[i]) {
          if (boiler.has(part)) continue;
          const toks = part.split(' ').filter(Boolean);
          while (toks.length && commonWord(toks[0])) toks.shift();
          while (toks.length && commonWord(toks[toks.length - 1])) toks.pop();
          const key = toks.join(' ');
          if (!toks.length || seen.has(key)) continue;
          const letters = key.replace(/ /g, '').length;
          if (letters < 4) continue;
          seen.add(key);
          const p = splitYa(toks);
          p.text = key;                 // as written in the title, for the "Heard: …" note
          // the words that make this title itself: «يا رب يا واحة» is «واحة», not «يا رب»
          p.content = p.filter(w => !TITLE_COMMON.has(stripAl(w)) && !TITLE_COMMON.has(w));
          phrases.push(p);
        }
        return { video: v, phrases };
      });
    }
    // Strong phrases match on their own; short or common ones need a cue word just before them.
    // ("ربنا موجود", "يا رب ارحم" are everyday phrases; "انا عايز اشكرك" is clearly a title)
    static needsCue(p) {
      return p.length <= 2 || p.join('').length < 10;
    }
    match(words, from) {
      const out = [];
      const pairs = words.map((w, i) => w + (words[i + 1] || ''));
      for (const e of this.entries) {
        let best = null;
        for (const p of e.phrases) {
          const n = p.length, p01 = n >= 2 ? p[0] + p[1] : null;
          for (let s = 0; s < words.length; s++) {
            const w0 = words[s];
            if (!(tokSim(w0, p[0]) || (p01 && tokSim(w0, p01)) || (s + 1 < words.length && tokSim(pairs[s], p[0])) ||
                  (n >= 4 && tokSim(w0, p[1])))) continue;
            const how = herald(words, s);
            const cued = !!how;
            if (!cued && VideoMatcher.needsCue(p)) continue;
            const [m, used] = align(p, words.slice(s, s + n + 2));
            const win = words.slice(s, s + Math.max(used, 1));
            if (p.content && p.content.length && !p.content.every(cw => win.some(w => tokSim(w, cw) >= 0.8 ||
              (cw.length >= 3 && w.length > cw.length && (w.endsWith(cw) || w.startsWith(cw)))))) continue;   // «لايكون» = «لا يكون»
            // announced titles may be misheard a little; unannounced ones must be said (almost) exactly
            const need = n >= 4 ? Math.ceil(n * 0.75) : n * (cued ? 0.75 : 0.9);
            if (m < need - 1e-9) continue;
            const end = s + used;
            if (end <= from) continue;                        // already handled earlier
            const q = Math.min(1, m / n);
            const score = q + n * 0.08 + (cued ? 0.1 : 0);
            // "sure" = safe to play by itself: we were invited to sing or hear it, and its title was heard clearly
            const invited = how === 'invite' || heraldAfter(words, end) === 'invite';
            if (!best || score > best.score) best = { score, phrase: p.text || p.join(' '), start: s, end, cued, invited, sure: invited && q >= 0.85 };
          }
        }
        if (best) out.push(Object.assign({ video: e.video }, best));
      }
      return out.sort((a, b) => b.score - a.score);
    }
    // Feed finished sentences; returns the videos mentioned. A video already mentioned in the last few
    // minutes comes back with repeat: true (highlight its card again, don't add or play it again).
    process(text, now) {
      now = now || Date.now();
      const toks = splitYa(normalize(text).split(' ').filter(Boolean));
      const words = this.tail.concat(toks);
      const found = this.match(words, this.tail.length);
      this.tail = words.slice(-this.opts.tailTokens);
      // several videos matched the same words: keep only the best one
      const kept = found.length > 1 ? found.filter((f, i) => i === 0 || f.score >= found[0].score - 0.001 && f.phrase !== found[0].phrase) : found;
      for (const f of kept) {
        const last = this.recent.get(f.video.id);
        f.repeat = !!(last && now - last < this.opts.dedupMs);
        this.recent.set(f.video.id, now);
      }
      return kept;
    }
    reset() { this.tail = []; this.recent.clear(); }
    phrasesFor(id) { const e = this.entries.find(x => x.video.id === id); return e ? e.phrases.map(p => p.text || p.join(' ')) : []; }
  }

  // ------------------------------------------------------------------
  // The song database: the titles of whole playlists and channels (thousands of hymns, data\songs.json). Too many to
  // listen for all the time, and nothing in it plays by itself. It is asked
  //   - when a hymn is announced or named («نرنم مع بعض ترنيمة …», «الترنيمة اللي بتقول …») and the service's own
  //     playlists do not have it: every song whose title begins with what was said, for a card to pick from;
  //   - when the operator types in the Videos tab's search box.
  // ------------------------------------------------------------------
  class SongIndex {
    // videos: [{ id, title, source }]
    constructor(videos) {
      this.videos = videos || [];
      this.entries = new VideoMatcher(this.videos).entries;       // each title's own words, without what many titles share
      this.norm = this.videos.map(v => normalize(v.title));
      this.own = this.entries.map(e => [...new Set(e.phrases.flatMap(p => [...p]))]);     // (the words of each song's own name)
      this.tail = []; this.base = 0; this.done = new Set(); this.recent = new Map();
    }
    get size() { return this.videos.length; }
    // The songs whose title begins with the words q (what was said after the announcement; the first one or two may be
    // other words). Best first: the same hymn in other keys and versions, and hymns that begin alike, all come.
    // close: one of the title's first three or more words may have been heard as another word («مستحق كل المادة» for
    // «مستحق كل المجد»), when the first word is right. Asked for when nothing begins exactly like the words.
    lookup(q, limit, close) {
      q = splitYa(q).slice(0, 10);
      const found = new Map();
      for (let off = 0; off <= (close ? 0 : 2) && off + 2 <= q.length; off++) {
        const w = q.slice(off, off + 8);
        for (const e of this.entries) {
          let best = 0, said = '', whole = false;
          for (const p of e.phrases) {
            const K = Math.min(p.length, w.length, 6);
            if (K < 2) continue;
            // the title starts where the words start (two words written as one, or one as two, still count)
            if (!(tokSim(w[0], p[0]) || tokSim(w[0], p[0] + p[1]) || tokSim(w[0] + w[1], p[0]))) continue;
            const [m, used] = align(p.slice(0, K), w.slice(0, K + 1));
            if (close ? !(K >= 3 && m >= K - 1 - 1e-9 && tokSim(w[0], p[0]) === 1) : m < K * 0.75 - 1e-9) continue;
            // … and holds a word that is the song's own («يا رب» begins a hundred titles)
            const win = w.slice(0, Math.max(used, 1));
            const own = (p.content || p).filter(cw => p.indexOf(cw) < K);
            if (!own.some(cw => win.some(x => tokSim(x, cw) >= 0.8 || (cw.length >= 3 && x.length > cw.length && (x.endsWith(cw) || x.startsWith(cw)))))) continue;
            const score = m + (K === p.length ? 0.5 : 0) + 0.3 * m / K - 0.02 * (p.length - K) - 0.4 * off;
            if (score > best) { best = score; said = win.join(' '); whole = K === p.length && m >= K - 0.25; }
          }
          const had = found.get(e.video.id);
          if (best && (!had || best > had.score)) found.set(e.video.id, { video: e.video, score: best, said, whole });
        }
      }
      const out = [...found.values()].sort((a, b) => b.score - a.score);
      const top = out.length ? out[0].score : 0;
      // (a shorter title that was said whole is the same hymn under a shorter name: «مالي سواك» beside «مالي سواك يا سيدي»)
      return out.filter(x => x.whole || x.score >= Math.max(top - 1.3, top * 0.6)).slice(0, limit || 12);
    }
    // Titles that sound like the words when the words are run together: a word said once or twice where the title has it
    // three times, two words heard as one or one as two, the end of a word cut off («قدوس قدوس هات صوت الملائ» and «قدوس،
    // ها صوت الملائكة» for «قدوس قدوس قدوس هاصوت الملائكة»). The first word must be the title's; then most of the letters,
    // in order, a word said again and again counted once. Best first.
    near(q, limit, min) {
      const once = ws => ws.filter((w, i) => i === 0 || w !== ws[i - 1]);
      const said = once(q.slice(0, 8)).join('');
      if (said.length < 10) return [];
      const out = [];
      for (const e of this.entries) {
        let best = 0;
        for (const p of e.phrases) {
          if (!p.length || tokSim(q[0], p[0]) !== 1) continue;
          const sim = 1 - prefixDist(said, once(p).join('').slice(0, said.length + 8)) / said.length;
          if (sim > best) best = sim;
        }
        if (best >= (min || 0.7)) out.push({ video: e.video, score: 5 * best, said: q.slice(0, 5).join(' '), whole: false });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, limit || 6);
    }
    // The words typed in the search box: every one of them must be in the title, as typed, or as a word of the song's
    // own name that sounds the same («الفخار» / «الفخاري», «اتكالي» / «إتكالى»). Titles that begin with them first.
    search(text, limit) {
      const q = normalize(text).split(' ').filter(Boolean);
      if (!q.length) return [];
      const out = [];
      for (let i = 0; i < this.videos.length; i++) {
        const t = this.norm[i];
        let score = 0;
        for (const w of q) {
          const at = t.indexOf(w);
          if (at >= 0) { score += 2 - Math.min(1, at / 80); continue; }
          if (w.length >= 3 && this.own[i].some(x => tokSim(x, w) >= 0.8)) { score += 1; continue; }
          score = 0; break;
        }
        if (score > 0) out.push({ video: this.videos[i], score });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, limit || 60).map(x => x.video);
    }
    // Feed finished sentences. When a hymn is announced or named in this one, gives
    //   { kind: 'invite' | 'cue', heard: the words after the announcement, matches: [{ video, score, said }], repeat,
    //     close: nothing begins exactly like that, these are the nearest (a word of the title was heard differently),
    //     named: it was called a hymn («ترنيمة …») and we were invited to sing it, and words of its own followed,
    //     titled: the word for a hymn came right before them («ترنيمة باركي يا نفسي الرب»): they are its name }
    // (matches may be empty: nothing in the database begins like that; when it was "named", a search elsewhere is
    //  worth offering). Otherwise null.
    process(text, now) {
      now = now || Date.now();
      const toks = splitYa(normalize(text).split(' ').filter(Boolean));
      const words = this.tail.concat(toks), from = this.tail.length;
      let res = null;
      // the last word that announces a hymn: in this sentence, or at the very end of the one before («… ونرنم الترنيمة دي»)
      for (let c = words.length - 1; c >= Math.max(0, from - 4) && !res; c--) {
        const weak = !(isWeSing(words[c]) || isHymnNoun(words[c]));          // («ترنيمة» misheard, perhaps)
        if (weak && !isMisheardHymn(words[c])) continue;
        if (this.done.has(this.base + c)) break;
        let q0 = c + 1;
        while (q0 < words.length && (isAfterCue(words[q0]) || isWeSing(words[q0]) || isHymnNoun(words[q0]) || isMisheardHymn(words[q0]) || WE_OTHER.has(bare(words[q0])))) q0++;
        const q = words.slice(q0, q0 + 10);
        if (q.length < 2 || q0 + 2 <= from) continue;          // its title is not here yet, or it was all in the sentence before
        if (q.slice(0, 3).some(x => isHymnNoun(x) || isWeSing(x))) continue;      // («نسبح مع بعض في الترنيمة دي»: no title there)
        let matches = this.lookup(q), close = false;
        if (weak && !matches.length) continue;
        this.done.add(this.base + c);
        // «ترنيمة» right before the words: they are a hymn's name, so a title they come near is worth showing (not after
        // «فيه ترنيمة بتقول …», where a hymn's line may be quoted)
        const titled = !weak && isHymnNoun(words[q0 - 1]);
        const near = weak ? [] : this.near(q, 6, titled ? 0.62 : 0.7);   // (the titles that sound like the words run together: always offered)
        if (!matches.length) { matches = this.lookup(q, 6, true); close = matches.length + near.length > 0; }
        const ids = new Set();
        matches = matches.concat(near).filter(m => !ids.has(m.video.id) && ids.add(m.video.id)).sort((a, b) => b.score - a.score).slice(0, 12);
        const kind = herald(words, q0) === 'invite' ? 'invite' : 'cue';
        const heard = (matches.length && !close ? matches[0].said : q.slice(0, 5).join(' '));
        const k = stripAl(words[c]).replace(/^[بفل](?=...)/, '');
        const own = q.slice(0, 5).filter(x => x.length >= 3 && !TITLE_COMMON.has(x) && !TITLE_COMMON.has(stripAl(x)) && !isConnect(x) && !WE_OTHER.has(bare(x))).length;
        const named = kind === 'invite' && own >= 2 && (skel(k) === HYMN_SKEL || ['ترنيمه', 'ترنيمتنا', 'اغنيه', 'فيديو', 'song', 'hymn', 'video'].includes(k));
        const key = matches.length ? matches[0].video.id : heard;
        const last = this.recent.get(key);
        this.recent.set(key, now);
        res = { kind, heard, matches, close, named, titled, repeat: !!(last && now - last < 5 * 60 * 1000) };
      }
      const keep = 24, drop = Math.max(0, words.length - keep);
      this.tail = words.slice(drop);
      this.base += drop;
      if (this.done.size > 200) this.done = new Set([...this.done].filter(x => x >= this.base));
      return res;
    }
    reset() { this.tail = []; this.base = 0; this.done.clear(); this.recent.clear(); }
  }

  // Manual search box: "يوحنا 3 16", "John 3:16", "1 cor 13 4-7"
  function parseQuery(text, bible) {
    const refs = findRefs(tokenize(text)).filter(r => r.book != null);
    const r = refs[0];
    if (!r) return null;
    if (bible && !bible.valid(r.book, r.chapter, null)) return null;
    let verseEnd = r.verseEnd;
    if (verseEnd === -1) verseEnd = bible && r.verse != null ? bible.verseCount(r.book, r.chapter) : null;
    return { book: r.book, chapter: r.chapter, verse: r.verse, verseEnd };
  }

  // ------------------------------------------------------------------
  // Director: decides what goes on the screen by itself (auto-show, following a reading, spoken "next verse").
  // The console (public/app.js) draws the cards and sends the screen to the display; the replay test
  // (test/replay.test.js) runs these same rules over recorded transcripts.
  //   opts.settings()         -> the current settings
  //   opts.now()              -> the time in ms (the tests bring their own clock)
  //   opts.card(c, info)      a detection for the operator's list (info.partial: from words still being said)
  //   opts.show(ref, why)     put this verse (or short range) on the screen
  // Everything shown goes through show(), the operator's clicks too, so the rules know what is on the screen.
  // why: 'operator' (a click, the arrows, the plan, the phone …), or the rule that did it:
  //   auto-reference / auto-context / auto-quote / auto-phrase   a detection, shown by itself
  //   auto-quote+          a quote two or three verses on in the chapter being read: shown with the verses skipped
  //   spoken-next / spoken-prev                                  "العدد اللي بعده"
  //   read-along           the reader went on into the next verse
  //   read-on              … and the same sentence ran into the one after it: both are up
  //   end-of-verse         in a reading, the last words of the verse on screen were said: the next one goes up
  //   reading-stopped      … but the reader did not go on, so the screen went back to the verse he ended on
  //   chapter-opening      a chapter was announced, then the opening words of one of its first verses were heard
  // ------------------------------------------------------------------
  const isLongRef = r => r.verseEnd != null && r.verseEnd - r.verse + 1 > 3;   // more than 3 verses: one at a time
  const refKey = r => (r ? `${r.book}:${r.chapter}:${r.verse}-${r.verseEnd || r.verse}` : '');
  const FOLLOWING = new Set(['read-along', 'read-on', 'end-of-verse', 'chapter-opening', 'auto-quote+']);
  const BY_ITSELF = /^(auto-|spoken-|read-|end-of-verse|reading-stopped|chapter-opening)/;
  // English words too common to tell where a reader is
  const EN_COMMON = new Set(('the of and to in a an that is was he she it his her for with as be on not but they them their him i you your we ' +
    'our shall will are were by at from this which who whom have has had my me all so no nor or if then there what when do did does into upon out up').split(' ').map(enStem));
  const enEq = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev1(a, b));
  // A sentence can hold two languages one after the other: an English pastor and, straight after him, his interpreter
  // (the speech engine does not always cut between the two, and then writes "English sentence. جملة عربية"). Each run of
  // one language is a sentence of its own. A few words of the other language inside a sentence («الـ grace بتاعة ربنا»,
  // "John 3:16" in an Arabic one) are not a run: an English run needs four words, an Arabic one three.
  function langRuns(text) {
    let runs = [];                   // { en, words, n: how many words are in the run's own script }
    for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
      const ar = /[\u0600-\u06FF]/.test(w), la = /[A-Za-z]/.test(w);
      const en = ar ? false : la ? true : null;                      // null: a number or a mark, which goes with what is around it
      const last = runs[runs.length - 1];
      if (last && (en == null || last.en == null || last.en === en)) { last.words.push(w); if (en != null) { last.n++; last.en = en; } }
      else runs.push({ en, words: [w], n: en == null ? 0 : 1 });
    }
    const big = r => r.n >= (r.en ? 4 : 3);
    for (let again = true; again && runs.length > 1;) {
      again = false;
      const i = runs.findIndex(r => !big(r));
      if (i >= 0) {                                                  // a short run goes into the one before it (the first: into the next)
        const j = i > 0 ? i - 1 : 1, a = Math.min(i, j), b = Math.max(i, j);
        runs[a] = { en: runs[j].en, words: runs[a].words.concat(runs[b].words), n: runs[j].n };
        runs.splice(b, 1);
        again = true;
      }
      for (let k = runs.length - 1; k > 0; k--) {                    // neighbours in one language are one run
        if (runs[k].en !== runs[k - 1].en) continue;
        runs[k - 1] = { en: runs[k].en, words: runs[k - 1].words.concat(runs[k].words), n: runs[k - 1].n + runs[k].n };
        runs.splice(k, 1);
        again = true;
      }
    }
    return runs.map(r => r.words.join(' '));
  }
  // Lines up spoken words w with verse words v (like alignWords) and gives the matched pairs [spoken index, verse index],
  // in order. Of the equally good ways to line them up it takes the earliest in the verse: words that could belong to the
  // verse on screen or to the one after it count for the one on screen, and a phrase a verse has twice is its first.
  function alignPairs(w, v, weight, eq) {
    const W = w.length, V = v.length, dp = new Float64Array((W + 1) * (V + 1)), at = (i, j) => i * (V + 1) + j;
    for (let i = 1; i <= W; i++) {
      for (let j = 1; j <= V; j++) {
        let best = dp[at(i - 1, j)];
        if (dp[at(i, j - 1)] > best) best = dp[at(i, j - 1)];
        if (eq(w[i - 1], v[j - 1])) { const x = dp[at(i - 1, j - 1)] + weight(v[j - 1]); if (x > best) best = x; }
        dp[at(i, j)] = best;
      }
    }
    const pairs = [];
    let i = W, j = V;
    while (i > 0 && j > 0) {
      if (dp[at(i, j)] === dp[at(i - 1, j)]) i--;
      else if (dp[at(i, j)] === dp[at(i, j - 1)]) j--;
      else { pairs.push([i - 1, j - 1]); i--; j--; }
    }
    return pairs.reverse();
  }
  // What the pairs say about one verse of those lined up (its words are v[lo..hi-1]): how many of its words were said
  // (n) and what they are worth, where in the verse the first and the last of them are, how close together they were
  // said (dense) and how close together they stand in the verse (tight), and where they are in the spoken words (w0..w1).
  function seg(pairs, lo, hi, v, weight) {
    const p = pairs.filter(x => x[1] >= lo && x[1] < hi);
    if (!p.length) return { n: 0, score: 0, first: -1, last: -1, dense: 0, tight: 0, w0: -1, w1: -1, len: hi - lo };
    let score = 0;
    for (const x of p) score += weight(v[x[1]]);
    const a = p[0], b = p[p.length - 1];
    return { n: p.length, score, first: a[1] - lo, last: b[1] - lo, dense: p.length / (b[0] - a[0] + 1), tight: p.length / (b[1] - a[1] + 1), w0: a[0], w1: b[0], len: hi - lo };
  }

  class Director {
    constructor(bible, detector, opts) {
      this.bible = bible; this.detector = detector; this.opts = opts || {};
      this.now = this.opts.now || (() => Date.now());
      this.current = null;            // the verse (or short range) on the screen, or the last one that was
      this.screenType = 'clear';      // 'show' | 'video' | 'message' | 'clear'
      this.hold = false;              // Hold: cards still come, but nothing changes the screen by itself
      this.lastVerseAt = -1e15;       // when a verse was last found or shown
      this.lastCard = null;           // the newest card with a verse
      this.readTail = ''; this.readTailAt = -1e15; this.readTailEn = false;
      this.shows = [];                // the last few things shown: { ref, t, why }
      this.mine = [];                 // what these rules or this console put up lately (their echo from the server is no news)
      this.lastFollowAt = -1e15;      // when the screen last moved on with the reading
      this.armed = null;              // a chapter announced without a verse: { book, chapter, t }
      this.passage = null;            // a long passage being read a verse at a time: { book, chapter, start, end }
      this.undone = null;             // the verse the operator took off with Back: { book, chapter, verse, t }
      this.eov = null;                // moved on at the end of a verse, the next one not heard yet: { prev, to, t, en }
      // The words said since the verse on screen went up: { key, t, finals: [{ text, skip, en }], open, head, paid, seq, read }
      //   finals  the finished sentences since (skip: how many of a sentence's first words came before the verse went up)
      //   open    the same for the sentence being said now
      //   head    how many of the verse's words had already been said when it went up
      //   paid    the time (ms) the words of finished sentences that came along with it took to say
      //   read    the languages the verse has been read to its end in: { ar, en }
      this.track = null;
      this.both = null;               // the reading is in two languages, a verse at a time: { t }
      this.noEov = null;              // a reading with talk between the verses: no moving on at a verse's end in { book, chapter, t }
      this.langHist = [];             // the language of the last finished sentences: { en, t } (an interpreter makes them alternate)
      this.runsDone = null;           // a sentence in two languages: how many of its runs were already taken as finished { seg, n }
      this.textSeq = 0;               // counts the texts given to final() / interim()
      this.inText = null;             // the text being worked on: { final, text, en, len }
      this.cursorText = ''; this.cursorAt = -1e15; this.cursorToks = null; this.cursorEn = false; this.cursorSeg = null;   // the sentence being said (its newest preview)
      this.vcache = new Map();
      this.gone = [];                 // the last verses that went off the screen: { ref, t }
      this.liveQ = null;              // a quote found in the words still being said: { key, seg, n: previews in a row that had it }
      this.liveDone = null;           // … and the one that was acted on: { key, seg } (once a sentence)
      if (detector && detector.opts) detector.opts.again = true;      // a verse quoted again a moment later: these rules decide (see _card)
    }
    // a verse went off the screen (words of it may still arrive: they were said while it was up)
    _left(ref, T) { this.gone.push({ ref, t: T }); if (this.gone.length > 4) this.gone.shift(); }
    _wentOff(c, T, ms) {
      return this.gone.some(g => T - g.t < ms && g.ref.book === c.book && g.ref.chapter === c.chapter && c.verse >= g.ref.verse && c.verse <= (g.ref.verseEnd || g.ref.verse));
    }
    get settings() { return (this.opts.settings && this.opts.settings()) || {}; }
    _ref(r, extra) {
      return Object.assign({ book: r.book, chapter: r.chapter, verse: r.verse, verseEnd: null, label: refLabel(r), labelEn: refLabel(r, { lang: 'en' }), time: this.now() }, extra);
    }
    // ---- words, in the form they are compared in: Arabic (soft spellings) or English (endings evened out)
    _toks(text, en) { return en ? enTokens(text) : qtokens(text).map(soft).filter(Boolean); }
    _weight(en) {
      if (en) return t => (EN_COMMON.has(t) ? 0.8 : 3.5);
      const fi = this.detector.fuzzyIndex;
      return fi && fi.ready ? t => Math.min(6, fi.idf(t)) : () => 2;
    }
    // A verse's words. Arabic has one wording; English has one per translation on this PC (opts.english()), in a fixed
    // order, so the same place in two verses' lists is the same translation. A wording that is not there is [].
    _wordings(r, en) {
      const key = `${en ? 'e' : 'a'}${r.book}:${r.chapter}:${r.verse}`;
      let out = this.vcache.get(key);
      if (out) return out;
      if (!en) { const t = this.bible.verse(r.book, r.chapter, r.verse); out = [t ? this._toks(t, false) : []]; }
      else out = ((this.opts.english && this.opts.english()) || []).map(b => { const t = b && b.verse(r.book, r.chapter, r.verse); return t ? enTokens(t) : []; });
      if (out.some(v => v.length)) { if (this.vcache.size > 300) this.vcache.clear(); this.vcache.set(key, out); }
      return out;
    }
    // the words said since the verse on screen went up, in one language -> { words, base: how many are of finished sentences }
    _since(text, en) {
      const k = this.track, words = [];
      if (!k) return { words, base: 0 };
      for (const f of k.finals) if (f.en === en) for (const w of this._toks(f.text, en).slice(f.skip)) words.push(w);
      const base = words.length;
      if (text != null && isEnglish(text) === en) for (const w of this._toks(text, en).slice(k.open)) words.push(w);
      return { words, base };
    }

    _note(r, why) {
      const T = this.now();
      this.current = r; this.screenType = 'show'; this.lastVerseAt = T;
      this.detector.setContext(r.book, r.chapter, T);
      // what is on the screen needs no card of its own a moment later
      for (let v = r.verse; v <= (r.verseEnd || r.verse); v++) this.detector.recent.set(`${r.book}:${r.chapter}:${v}`, T);
      this.shows.push({ ref: r, t: T, why });
      if (this.shows.length > 8) this.shows.shift();
      if (FOLLOWING.has(why)) this.lastFollowAt = T;
      if (why !== 'end-of-verse') this.eov = null;
      if (this.armed && this.armed.book === r.book && this.armed.chapter === r.chapter) this.armed = null;
      // from now on the words said belong to this verse
      const c = this._carry, x = this.inText;
      const k = { key: refKey(r), t: T, finals: [], open: 0, head: 0, paid: 0, seq: 0, read: {} };
      const left = f => Math.max(0, this._toks(f.text, f.en).length - f.skip);
      if (c) {                        // these rules moved the screen in the middle of a sentence: its words from there on are the new verse's
        k.head = c.head || 0;
        if (c.pre) { k.finals.push(c.pre); k.paid += left(c.pre) * 250; }
        if (c.final) { const f = { text: c.text, skip: c.skip, en: c.en }; k.finals.push(f); k.seq = this.textSeq; k.paid += left(f) * 250; } else k.open = c.skip;
      } else if (x) {                 // found in this very sentence: what it said so far came before
        if (x.final) k.seq = this.textSeq; else k.open = x.len;
      } else if (this.cursorText && T - this.cursorAt < 3000) k.open = this._toks(this.cursorText, isEnglish(this.cursorText)).length;   // a click while someone speaks
      this.track = k;
    }

    // Put a verse on the screen.
    show(ref, why) {
      if (!ref || ref.verse == null) return null;
      const r = { book: ref.book, chapter: ref.chapter, verse: ref.verse, verseEnd: ref.verseEnd && ref.verseEnd > ref.verse ? ref.verseEnd : null };
      const p = this.passage;
      // a long passage ("يوحنا ٤ من ٣ إلى ٣٠") goes up a verse at a time; where it ends is remembered while it is being read
      if (isLongRef(r) || ref.from) this.noEov = null;             // (a passage is announced: a reading from the start again)
      if (isLongRef(r)) { this.passage = { book: r.book, chapter: r.chapter, start: r.verse, end: r.verseEnd }; r.verseEnd = null; }
      // "هنقرأ من عدد ٣": a reading that starts there and ends where the reader stops
      else if (ref.from && !r.verseEnd) this.passage = { book: r.book, chapter: r.chapter, start: r.verse, end: this.bible.verseCount(r.book, r.chapter), open: true };
      // a short range that was announced or picked ("يوحنا ٣: ١٤-١٦") ends where it says, whatever was announced before
      else if (r.verseEnd && !FOLLOWING.has(why || 'operator')) this.passage = null;
      else if (p && !(p.book === r.book && p.chapter === r.chapter && r.verse >= p.start && r.verse <= p.end + 1)) this.passage = null;
      r.lang = ref.lang;
      why = why || 'operator';
      const u = this.undone;      // the operator just took this verse off with Back: these rules don't put it straight back
      if (u && BY_ITSELF.test(why) && this.now() - u.t < 60000 && u.book === r.book && u.chapter === r.chapter && u.verse >= r.verse && u.verse <= (r.verseEnd || r.verse)) return null;
      if (this.screenType === 'show' && this.current && refKey(this.current) !== refKey(r)) this._left(this.current, this.now());
      this._note(r, why);
      this.mine.push({ key: refKey(r), t: this.now() });
      if (this.mine.length > 6) this.mine.shift();
      if (this.opts.show) this.opts.show(r, why);
      return r;
    }
    // The screen changed, whoever changed it (this console, another one, the phone, a video ending).
    // back: the operator pressed Back, so this is the screen from before (and what it replaced is not put up again
    // by these rules for a minute).
    onScreen(type, ref, back) {
      const T = this.now(), was = this.screenType === 'show' ? this.current : null;
      this.screenType = type;
      if (back && was) this.undone = { book: was.book, chapter: was.chapter, verse: was.verse, t: T };
      if (type !== 'show') { if (was) this._left(was, T); this.eov = null; return; }
      this.lastVerseAt = T;
      if (!ref || ref.verse == null) return;
      const key = refKey(ref);
      if (!back && (key === refKey(this.current) || this.mine.some(m => m.key === key && T - m.t < 15000))) return;   // our own, coming back
      if (was && refKey(was) !== key) this._left(was, T);
      this._note({ book: ref.book, chapter: ref.chapter, verse: ref.verse, verseEnd: ref.verseEnd || null, lang: ref.lang }, back ? 'back' : 'operator');
    }
    // a card was added to the operator's list (found by the detector, or made by a search or the phone)
    noteCard(c) {
      if (c.verse != null || c.chapter != null) this.lastVerseAt = this.now();
      if (c.verse != null) this.lastCard = c;
    }

    // a finished sentence -> { found: the detector's cards, followed: the screen moved on with the reading }
    // late: it was heard a while ago (the speech model was loading meanwhile): cards for it, but nothing on the screen
    // seg: the engine's number for the sentence (its previews carry the same one)
    // o.hymn: a hymn was named in it and found (the console's song lists): its verse-like words are the hymn's name, not a
    //   quote («ترنيمة باركي يا نفسي الرب»), so they make no verse card
    final(text, late, seg, o) {
      const runs = langRuns((text || '').trim());
      const rd = this.runsDone && seg != null && this.runsDone.seg === seg ? this.runsDone : null;
      this.runsDone = null;
      if (runs.length < 2 && !rd) return this._final1(text, late, seg, o);
      // two languages in one sentence: each run in turn (not the ones already taken while it was being said)
      const out = { found: [], followed: false };
      for (let i = rd ? Math.min(rd.n, runs.length - 1) : 0; i < runs.length; i++) {
        const r = this._final1(runs[i], late, seg == null ? null : seg + (i + 1) / 64, o);
        out.found.push(...r.found);
        out.followed = out.followed || r.followed;
      }
      return out;
    }
    // words still being said
    interim(text, seg) {
      const runs = langRuns((text || '').trim());
      const rd = this.runsDone && seg != null && this.runsDone.seg === seg ? this.runsDone : null;
      if (!rd) this.runsDone = null;
      if (runs.length < 2 && !rd) return this._interim1(text, seg);
      if (seg == null) return this._interim1(runs[runs.length - 1], seg);     // (no sentence numbers: the last run only, until the sentence is finished)
      const n = rd ? rd.n : 0, last = Math.max(n, runs.length - 1);
      for (let i = n; i < runs.length - 1; i++) this._final1(runs[i], false, seg + (i + 1) / 64);    // the other language has begun: these runs are finished
      this.runsDone = { seg, n: last };
      this._interim1(runs[runs.length - 1], seg + (last + 1) / 64);
    }
    _final1(text, late, seg, o) {
      text = (text || '').trim();
      if (!text) return { found: [], followed: false };
      const T = this.now();
      const notHymn = c => !(o && o.hymn && c.source === 'quote');
      if (late) {
        const found = this.detector.processFinal(text, T).filter(notHymn);
        for (const c of found) this._card(c, { noAuto: true }, false);
        return { found, followed: false };
      }
      const en = isEnglish(text), len = this._toks(text, en).length;
      this.textSeq++;
      if (seg != null && this.cursorSeg != null && seg > this.cursorSeg) this._newSentence(text, en, seg, true);   // (the sentence before this one was never finished)
      this.cursorText = ''; this.cursorToks = null; this.cursorSeg = null;
      this._screenContext(T);
      this.inText = { final: true, text, en, len };
      this._arm(text, true);
      this._opening(text);
      this._stopped(text, true);
      const followed = this._readAlong(text, true);
      const found = this.detector.processFinal(text, T).filter(notHymn).filter(c => this._card(c, followed ? { noAuto: true } : null, false) !== false);
      const cur = this.current;
      if (followed && cur && !cur.verseEnd && this.screenType === 'show') {
        // the same sentence was also found as a quote of the verse after it: the reader ran on, so both stay up
        const n = cur.verse + 1;
        if (found.some(c => c.source === 'quote' && !c.probable && c.book === cur.book && c.chapter === cur.chapter && c.verse === n))
          this.show({ book: cur.book, chapter: cur.chapter, verse: cur.verse, verseEnd: n, lang: cur.lang }, 'read-on');
      }
      const nav = found.some(c => c.source === 'reference') || followed ? null : detectNavDetail(text);
      if (nav) this._nav(nav.dir, en ? 'en' : 'ar', nav.bare);
      this.inText = null;
      // the sentence is finished: what it said since the verse went up is kept (for where the reader is in the verse)
      const k = this.track;
      if (k) {
        if (k.seq !== this.textSeq) { k.finals.push({ text, skip: k.open, en }); if (k.finals.length > 10) k.finals.shift(); }
        k.open = 0;
      }
      if (len >= 2) { this.langHist.push({ en, t: T }); if (this.langHist.length > 12) this.langHist.shift(); }
      return { found, followed };
    }
    // «عدد ٩» with nothing else said means the chapter on the screen, however long it has been up (the detector forgets a
    // reference after four minutes; a verse still on the screen is not forgotten).
    _screenContext(T) {
      const cur = this.screenType === 'show' ? this.current : null, c = this.detector.context;
      if (cur && !(c && T - c.time < this.detector.opts.contextMs)) this.detector.setContext(cur.book, cur.chapter, T);
    }
    // Is the service in two languages, sentence by sentence (an interpreter)? The last few sentences keep changing language.
    _interp() {
      const T = this.now(), h = this.langHist.filter(x => T - x.t < 150000).slice(-8);
      let n = 0;
      for (let i = 1; i < h.length; i++) if (h[i].en !== h[i - 1].en) n++;
      return n >= 3;
    }
    // Are verses being given in two languages: read in both, or read in one and interpreted into the other?
    _both() { return !!(this.both && this.now() - this.both.t < 120000) || this._interp(); }
    // The sentence being said changed without the one before it being finished (the engine drops a sentence it takes
    // for noise): the words before are done with. seg: the engine's number for the sentence, when it gives one;
    // otherwise a preview that starts over, much shorter and with another first word, is a new sentence.
    _newSentence(text, en, seg, final) {
      const k = this.track, prev = this.cursorToks;
      if (!this.cursorText || !prev) return;
      let fresh;
      if (seg != null && this.cursorSeg != null) fresh = seg !== this.cursorSeg;
      else if (final) fresh = false;
      else { const toks = this._toks(text, en); fresh = prev.length >= 4 && toks.length <= prev.length / 2 && toks[0] !== prev[0]; }
      if (!fresh || !k) return;
      k.finals.push({ text: this.cursorText, skip: k.open, en: this.cursorEn });
      if (k.finals.length > 10) k.finals.shift();
      k.open = 0;
    }
    _interim1(text, seg) {
      if (!text) return;
      const en = isEnglish(text);
      this.textSeq++;
      this._newSentence(text, en, seg, false);
      this.cursorText = text; this.cursorAt = this.now(); this.cursorToks = this._toks(text, en); this.cursorEn = en; this.cursorSeg = seg == null ? null : seg;
      this._screenContext(this.now());
      this.inText = { final: false, text, en, len: this.cursorToks.length };
      this._arm(text, false);
      if (!this._opening(text)) {
        this._stopped(text, false);
        const followed = this._readAlong(text, false);
        for (const c of this.detector.processInterim(text, this.now())) this._card(c, null, true);
        if (!followed && !saysHymn(text)) this._quoteLive(text, seg);
      }
      this.inText = null;
    }
    // A clear quote goes up while it is still being said, not when the sentence ends (Settings → Detection: quoteLive).
    // Only a quote that would go on the screen by itself; a less clear one gets its card when the sentence is finished.
    // Words still being said can change, so the verse has to be found in two previews of the sentence, one after the other.
    _quoteLive(text, seg) {
      const s = this.settings, T = this.now(), was = this.liveQ;
      this.liveQ = null;
      if (s.quoteLive === false || !s.autoShowQuotes || this.hold || this.screenType === 'video') return;
      const f = this.detector.quoteLive(text, T);
      if (!f) return;
      const q = f.q, key = `${q.book}:${q.chapter}:${q.verse}`, sg = seg == null ? null : seg;
      if (!this._clear(q, !(q.alsoIn && q.alsoIn.length)) || (s.cardOnly || []).includes(key)) return;
      const cur = this.screenType === 'show' ? this.current : null;
      if (cur && cur.book === q.book && cur.chapter === q.chapter && q.verse >= cur.verse && q.verse <= (cur.verseEnd || cur.verse)) return;   // it is up
      const d = this.liveDone;
      if (d && d.key === key && d.seg === sg) return;               // acted on in this sentence already (the operator may have taken it off)
      const n = was && was.key === key && was.seg === sg ? was.n + 1 : 1;
      this.liveQ = { key, seg: sg, n };
      if (n === 1 && this.opts.sighted) this.opts.sighted({ book: q.book, chapter: q.chapter, verse: q.verse, lang: f.lang });   // (its text can be got ready)
      if (n < 2) return;
      const c = this.detector.take(f, T);
      if (!c) return;
      c.live = true;
      // on the screen now, or nothing: when these rules do not want it yet (its words fit what is on the screen as well,
      // or it only just left the screen) it is given back, and the finished sentence decides as it always did
      if (this._card(c, { live: true }, true) === false) this.detector.untake(c);
      else this.liveDone = { key, seg: sg };
    }
    // Called about once a second by the console. The screen moved on at the end of a verse and then nothing was said:
    // the reading has stopped, so back to the verse it ended on. After 8 seconds of silence; inside a passage that was
    // announced with its end ("من ١٤ إلى ٢٠") the next verse is surely coming, so there a pause may last 20 seconds.
    tick() {
      const e = this.eov;
      if (!e || this.hold) return;
      if (this.screenType !== 'show' || !this.current || refKey(this.current) !== refKey(e.to)) { this.eov = null; return; }
      const T = this.now(), p = this.passage, cur = this.current;
      const announced = p && !p.open && p.book === cur.book && p.chapter === cur.chapter && cur.verse >= p.start && cur.verse <= p.end;
      if (T - e.t > (announced ? 20000 : 8000) && T - this.cursorAt > 3000) {
        this.eov = null;
        this.show(e.prev, 'reading-stopped');
        this.noEov = { book: e.prev.book, chapter: e.prev.chapter, t: T };
        if (this.passage && this.passage.open) this.passage = null;
      }
    }

    // a detection: give it to the operator's list, and decide whether it goes on the screen by itself
    _card(c, opts, partial) {
      const s = this.settings, T = this.now(), m = c.match;
      const cur = this.screenType === 'show' ? this.current : null;
      // the words fit the verse on the screen just as well: the reader is in it, not quoting another one
      // (the end of John 3:16 is, word for word, John 3:15)
      if (c.source === 'quote' && cur && this._fits(c, cur)) return false;
      // a reference to what is on the screen already: nothing to do
      if ((c.source === 'reference' || c.source === 'context') && cur && c.verse != null && cur.book === c.book && cur.chapter === c.chapter &&
          cur.verse === c.verse && (cur.verseEnd || cur.verse) === (c.verseEnd || c.verse)) return false;
      // Quotes go up by themselves only when clear and certain:
      //   word for word: six words or more in a row (four 3-word sequences), or five («الرب راعي فلا يعوزني شيء») when
      //     hardly another verse has those sequences and no other verse reads the same;
      //   with words heard differently: six words of the verse, or five that are nearly all of a short verse
      //     («في البدء خلق الله السماء والأرض»), nearly all of them said just now, and no other verse fits as well.
      const strong = this._clear(m, !(c.alsoIn && c.alsoIn.length));
      let auto = ['reference', 'context', 'next', 'prev'].includes(c.source) ? !!s.autoShow
        : c.source === 'quote' ? !!(s.autoShowQuotes && strong && !(s.cardOnly || []).includes(`${c.book}:${c.chapter}:${c.verse}`))
        : c.source === 'phrase' ? !!(s.autoShowQuotes && !c.cardOnly) : false;
      if ((opts && opts.noAuto) || c.verse == null || c.probable || this.hold || this.screenType === 'video') auto = false;
      const here = cur && cur.book === c.book && cur.chapter === c.chapter;
      // While a reading is being followed (see _reading; the screen moved on with the reader in the last 15 seconds) a
      // quote of a verse somewhere else has to be plain to pull the screen away: six words in a row, word for word. Less
      // makes a card. (18 Nov: John 3:24 read in a wording this PC does not have, "This was before John was put in
      // prison", put Mark 1:14 up in the middle of the reading.)
      if (auto && c.source === 'quote' && cur && !here && T - this.lastFollowAt < 15000 && !(m && !m.fuzzy && m.hits >= 4) && this._reading()) auto = false;
      // A verse that was found or on the screen a moment ago is quoted again. Nothing new while it is still up, in the
      // chapter being read (the reader's place decides there), or within 15 seconds of its leaving the screen (those
      // are its last words arriving, or the operator took it off while it was being said). Otherwise it is being said
      // again, and a clear quote brings it back; an unclear one adds nothing to the list, which has its card already.
      // (grown: the rest of a verse whose first words only made a card. It has been said in full now, so it goes up as any
      //  clear quote does, with no second card; nothing when it is on the screen already.)
      const onIt = here && c.verse >= cur.verse && c.verse <= (cur.verseEnd || cur.verse);
      if (c.again && (!auto || (c.grown ? onIt : here) || this._wentOff(c, T, 15000))) return false;
      // in a reading, late words of a verse just read are not a new quote: a card, but the screen is not pulled back
      const late = auto && c.source === 'quote' && here && c.verse < cur.verse && cur.verse - c.verse <= 2 && T - this.lastFollowAt < 20000;
      if (opts && opts.live && (!auto || late)) return false;       // (from words still being said: on the screen, or nothing yet)
      this.noteCard(c);
      if (late) auto = false;
      const end = here ? (cur.verseEnd || cur.verse) : null, last = this.shows[this.shows.length - 1];
      // a quote of another verse of the chapter on screen, in words that also begin the verse after the one on screen
      // ("So I prophesied as I was commanded" is Ezekiel 37:7, and the start of 37:10): the reader is going on, not back
      const after = here ? { book: cur.book, chapter: cur.chapter, verse: end + 1 } : null;
      if (auto && c.source === 'quote' && here && !c.verseEnd && c.verse < cur.verse && this._opens(after)) {
        const n = this._ref(after, { source: 'read', lang: cur.lang || c.lang || 'ar' });
        this.noteCard(n);
        if (this.opts.card) this.opts.card(n, { partial: !!partial, auto: true });
        this.show(n, 'read-along');
        return;
      }
      if (this.opts.card && !c.grown) this.opts.card(c, { partial: !!partial, auto });
      if (!auto) return;
      // a quote two or three verses further on in the chapter being read: the reader got there, so what was skipped goes up too
      if (c.source === 'quote' && here && !c.verseEnd && c.verse > end + 1 && c.verse <= end + 3 && last && T - last.t < 60000)
        this.show({ book: c.book, chapter: c.chapter, verse: end + 1, verseEnd: c.verse, lang: c.lang }, 'auto-quote+');
      else this.show(c, 'auto-' + c.source);      // (a long passage goes up a verse at a time: show() sees to that)
    }
    // Is a quote clear enough to go up by itself? m: how it matched; one: no other verse fits as well. (The rules are
    // spelt out in _card.)
    _clear(m, one) {
      const loose = x => (x.hits >= 6 || (x.hits === 5 && (x.coverage || 0) >= 0.8)) && (x.fresh || 0) >= 5;
      return !!m && (m.fuzzy ? loose(m) && one
        : m.hits >= 4 || (one && ((m.hits === 3 && (m.weight || 0) >= 2.4) || !!(m.more && m.more.one && loose(m.more)))));
    }
    // Do the words of the sentence being worked on begin this verse?
    _opens(r) {
      const x = this.inText;
      if (!x || !r || !this.bible.valid(r.book, r.chapter, r.verse)) return false;
      const words = this._toks(x.text, x.en).slice(-30), weight = this._weight(x.en), eq = x.en ? enEq : softEq;
      for (const V of this._wordings(r, x.en)) {
        if (V.length < 4) continue;
        const m = seg(alignPairs(words, V, weight, eq), 0, V.length, V, weight);
        if (m.n >= 3 && m.first <= 1 && m.dense >= 0.6 && m.tight >= 0.6 && m.score >= 8) return true;
      }
      return false;
    }
    // Do the words of the sentence being worked on belong to what is on the screen (or to the verse the screen left a
    // moment ago, when they ended it), as much as to the quoted verse c?
    _fits(c, cur) {
      const x = this.inText;
      if (!x || (c.book === cur.book && c.chapter === cur.chapter && c.verse >= cur.verse && c.verse <= (cur.verseEnd || cur.verse))) return false;
      const e = this.eov;
      if (e && this.now() - e.t < 3000 && cur !== e.prev && this._fits(c, e.prev)) return true;
      const words = this._toks(x.text, x.en).slice(-22), weight = this._weight(x.en), eq = x.en ? enEq : softEq;
      const need = Math.max(3, ((c.match && c.match.hits) || 4) - 2);
      for (let v = cur.verse; v <= (cur.verseEnd || cur.verse); v++) {
        for (const V of this._wordings({ book: cur.book, chapter: cur.chapter, verse: v }, x.en)) {
          if (!V.length) continue;
          const m = seg(alignPairs(words, V, weight, eq), 0, V.length, V, weight);
          if (m.n >= need && m.dense >= 0.6 && m.tight >= 0.6) return true;
        }
      }
      return false;
    }

    // "العدد اللي بعده" / "next verse" / "اللي بعده": go on from the verse on screen (or the last one found)
    _nav(dir, lang, bare) {
      const s = this.settings;
      if (bare && this.now() - this.lastVerseAt > 10 * 60 * 1000) return;   // plain "اللي بعده" only while reading scripture
      const base = this.current || this.lastCard;
      if (!base) return;
      const from = dir === 'next' ? (base.verseEnd || base.verse) : base.verse;
      const t = dir === 'next' ? this.bible.next(base.book, base.chapter, from) : this.bible.prev(base.book, base.chapter, from);
      if (!t) return;
      const c = this._ref(t, { source: dir, lang: lang === 'en' || (this.current && this.current.lang === 'en') ? 'en' : 'ar' });
      const follow = s.navFollow !== false && this.screenType === 'show';
      if (follow && !this.hold) {
        this.noteCard(c);
        if (this.opts.card) this.opts.card(c, { partial: false, auto: true });
        this.show(c, 'spoken-' + dir);
      } else this._card(c, follow || s.navFollow === false ? { noAuto: true } : null, false);
    }

    // In a reading the screen moves on as each verse ends. A reading is:
    //   - a passage was announced or planned ("يوحنا ٣ من ١٤ إلى ٢٠", "هنقرأ من عدد ٣"), and the verse on screen, up for
    //     under 90 s, is inside it and is not its last; or
    //   - the last three things shown are verses of one chapter in order, the newest under 40 s ago (two verses read one
    //     after the other are often all there is: then the next one is waited for, not put up ahead); or
    //   - verses are being read in two languages, one after the other.
    _reading() {
      const T = this.now(), cur = this.current, p = this.passage, k = this.track;
      if (!cur || !k) return false;
      if (p && T - k.t < 90000 && p.book === cur.book && p.chapter === cur.chapter && cur.verse >= p.start && (cur.verseEnd || cur.verse) < p.end) return true;
      if (this.both && T - this.both.t < 120000) return true;
      const s = this.shows.slice(-3);
      const inOrder = (a, b) => a.ref.book === b.ref.book && a.ref.chapter === b.ref.chapter && b.ref.verse > a.ref.verse && b.ref.verse - (a.ref.verseEnd || a.ref.verse) <= 2;
      return s.length === 3 && T - s[2].t < 40000 && inOrder(s[0], s[1]) && inOrder(s[1], s[2]);
    }
    // Follow the reading. A verse is on the screen, and
    //   - the reader goes on into the next one (its opening words are heard): the next one goes up; or
    //   - in a reading, the last words of the verse on screen are said: the next one goes up, before he starts it.
    // Only the words said since the verse went up count: what was said before it belongs to something else.
    _readAlong(text, final) {
      const s = this.settings, cur = this.current, T = this.now(), k = this.track;
      if (s.readAlong === false || this.hold || this.screenType !== 'show' || !cur || !k) return false;
      const en = isEnglish(text);
      if (!en && !(this.detector.fuzzyIndex && this.detector.fuzzyIndex.ready)) return false;
      const lastV = cur.verseEnd || cur.verse, here = { book: cur.book, chapter: cur.chapter, verse: lastV };
      const nxt = this.bible.next(cur.book, cur.chapter, lastV);
      // The last verse of a chapter (a psalm, a book): following stops there. Readings end at a chapter's end far more
      // often than they run on, and the screen moving into the next chapter by itself looked wrong (18 Nov: James 2:26
      // went on to 3:1, Psalm 1:6 to 2:1). A reader who does go on is found by the words, like any quote, or says so.
      if (!nxt || nxt.book !== cur.book || nxt.chapter !== cur.chapter) return false;
      const weight = this._weight(en), eq = en ? enEq : softEq, min = 10;
      const V1s = this._wordings(nxt, en);
      // the words on the screen, per wording: one verse, or the verses of a short range one after the other
      let V0s = this._wordings({ book: cur.book, chapter: cur.chapter, verse: cur.verse }, en);
      for (let n = cur.verse + 1; n <= lastV; n++) { const more = this._wordings({ book: cur.book, chapter: cur.chapter, verse: n }, en); V0s = V0s.map((v, x) => (v.length && more[x] && more[x].length ? v.concat(more[x]) : [])); }
      const reading = s.readEnd !== false && this._reading();
      const sn = this._since(text, en);

      // Has what is on the screen just been read to its end? Everything said since it went up is lined up with it, in
      // order, so words that two verses share (the end of John 3:15 and of 3:16) fall where the reader is.
      // The next verse can go up a little before the end of this one (Settings -> Detection: about a second by
      // default). In words: about 2.3 a second in Arabic, 3 in English. A short verse is read nearly to its end.
      const lead = Math.max(0, Math.min(3, s.readLead == null ? 1 : +s.readLead || 0)), early = Math.round(lead * (en ? 3 : 2.3));
      const sw = sn.words.slice(-80), shift = sn.words.length - sw.length;
      let end = null;
      for (const V0 of V0s) {
        if (V0.length < 2) continue;
        const pairs = alignPairs(sw, V0, weight, eq), whole = seg(pairs, 0, V0.length, V0, weight);
        // "the end" is the word so many before the last (or any after it, when the words come several at a time)
        for (let cut = V0.length - Math.max(0, Math.min(early, V0.length - 5)); cut <= V0.length && !end; cut++) {
          const lo = Math.max(0, cut - 4), e = seg(pairs, lo, cut, V0, weight);
          // most of the four words before it, said together, and only just now (at most three words ago): the very
          // last of them, or the one before it and then something else (the last word is the one most often
          // misheard, and in a preview it is often a guess at a word cut in half)
          const after = sw.length - 1 - e.w1;
          if (!(e.n >= (cut - lo >= 4 ? 3 : 2) && e.dense >= 0.75 && after <= 3 && (e.last === e.len - 1 || (e.last === e.len - 2 && after >= 1)))) continue;
          // … in a reading of the verse: half of it or more was said since it went up, from its beginning
          if (whole.n < cut * 0.5 || whole.first > 3) continue;
          // … and not sooner than it can be read (four words a second): the speech model can finish a verse it knows
          // before the reader does
          if (T - k.t + Math.max(k.paid, Math.min(8, k.head) * 250) < cut * 250) continue;
          end = { at: shift + e.w1, left: V0.length - 1 - (lo + e.last) };      // left: words of the verse still to be said
        }
        if (end) break;
      }
      if (end) k.ended = T;

      // 1. The opening words of the next verse, said after whatever was said of the verse on screen.
      const eased = k.ended && T - k.ended < 30000;        // (he has finished the verse on screen: its neighbour is likely next)
      let go = null;
      const words = sn.words.slice(-40), cut = sn.words.length - words.length;
      // (a verse that has been up for minutes while he preached: its neighbour's opening words, often a formula like
      //  "This is what the Sovereign Lord says", are then looked for as a quote, anywhere, not taken as reading on)
      if (words.length >= 3 && (T - k.t < 180000 || eased || reading)) {
        for (let x = 0; x < V1s.length; x++) {
          const V1 = V1s[x], V0 = V0s[x] || [];
          if (!V1.length || (V1.length < 4 && !reading)) continue;
          const v = V0.concat(V1), m = seg(alignPairs(words, v, weight, eq), V0.length, v.length, v, weight);
          const ok = (m.n >= Math.min(4, V1.length) && m.dense >= 0.6 && m.tight >= 0.6 && m.first <= 2 && (m.score >= min || m.n >= Math.min(V1.length, 7))) ||
            (m.n === 3 && m.first === 0 && m.dense === 1 && m.tight === 1 && m.score >= min * 1.2) ||
            (eased && m.n >= 3 && m.first <= 1 && m.dense >= 0.75 && m.tight >= 0.75 && m.score >= min * 0.8);
          if (ok && (!go || m.score > go.score)) go = m;
        }
      }
      let why = 'read-along', toEnd = null, carry;
      if (go) {
        // … and the same words already began the verse after that one: both go up, so neither is skipped
        const n2 = this.bible.next(nxt.book, nxt.chapter, nxt.verse);
        if (n2 && n2.book === nxt.book && n2.chapter === nxt.chapter) {
          for (const V2 of this._wordings(n2, en)) {
            if (V2.length < 4) continue;
            const m2 = seg(alignPairs(words, V2, weight, eq), 0, V2.length, V2, weight);
            if (m2.n >= 4 && m2.score >= min && m2.dense >= 0.6 && m2.tight >= 0.6 && m2.first <= 1 && m2.w0 > go.w1) { toEnd = n2.verse; break; }
          }
        }
        // this sentence's words from where the next verse began are the first words said of the verse now going up
        carry = { skip: (k.open || 0) + Math.max(0, go.w0 + cut - sn.base), head: go.n };
      } else {
        // 2. In a reading: the verse on screen has just been read to its end.
        // In two languages (read in both, or an interpreter after each sentence) it is over when its last words
        // have been read in both. (An interpreter who gives it in his own words: then the next verse goes up at its
        // first words, like any verse that was not announced.)
        const two = this._both();
        if (end && two) k.read[en ? 'en' : 'ar'] = true;
        if (!reading || !end) return false;
        const p = this.passage;                                     // (the passage that was announced or planned ends here)
        if (p && p.book === cur.book && p.chapter === cur.chapter && lastV >= p.end) return false;
        if (two && !(k.read.en && k.read.ar)) return false;
        // a reader who stops to talk between the verses: the screen went on once and had to come back, so in this
        // chapter it now waits for him to begin each verse
        const q = this.noEov;
        if (q && q.book === cur.book && q.chapter === cur.chapter && T - q.t < 600000) return false;
        if (this.both) this.both.t = T;
        why = 'end-of-verse';
        carry = { skip: (k.open || 0) + Math.max(0, end.at - sn.base + 1), head: 0 };    // (what this sentence says after the ending is the next verse's)
      }
      const c = this._ref(nxt, { source: 'read', lang: cur.lang || 'ar', verseEnd: toEnd });
      if (toEnd) { c.label = refLabel(c); c.labelEn = refLabel(c, { lang: 'en' }); }
      this.noteCard(c);
      if (this.opts.card) this.opts.card(c, { partial: !final, auto: true });
      this._carry = Object.assign(carry, { final, text, en });
      const shown = this.show(c, why);
      this._carry = null;
      if (why === 'end-of-verse' && shown) this.eov = { prev: cur, to: shown, t: T, en, left: (end && end.left) || 0 };
      return true;
    }
    // The screen moved on at the last words of a verse. If what is said next is not that next verse, the reader has
    // stopped (or is reading the same verse again, in the other language): back to the verse he ended on.
    _stopped(text, final) {
      const e = this.eov, cur = this.current, T = this.now();
      if (!e) return;
      if (this.screenType !== 'show' || !cur || refKey(cur) !== refKey(e.to)) { this.eov = null; return; }
      const en = isEnglish(text), weight = this._weight(en), eq = en ? enEq : softEq;
      const sn = this._since(text, en), since = sn.words.slice(-40);
      let best = 0;
      for (const V of this._wordings(cur, en)) {
        if (!V.length) continue;
        const m = seg(alignPairs(since, V, weight, eq), 0, V.length, V, weight);
        if (m.n >= Math.min(3, Math.max(2, V.length - 1)) && m.dense >= 0.6) { this.eov = null; return; }   // he is reading it
        // … or reading it in a wording this PC does not have: many of its words, in order, but spread out (18 Nov:
        // 1 John 4:20 was read to its end from another translation, and the screen went back to 4:19)
        if (m.n >= 6 && m.score >= 15 && m.dense >= 0.35 && m.tight >= 0.35) { this.eov = null; return; }
        best = Math.max(best, m.n);
      }
      // the verse he ended on, begun again
      const prev = { book: e.prev.book, chapter: e.prev.chapter, verse: e.prev.verseEnd || e.prev.verse };
      const recent = sn.words.slice(-30), shift = sn.words.length - recent.length;
      let again = null;
      for (const V of this._wordings(prev, en)) {
        if (V.length < 4) continue;
        const m = seg(alignPairs(recent, V, weight, eq), 0, V.length, V, weight);
        if (m.n >= 4 && m.dense >= 0.6 && m.tight >= 0.6 && m.first <= 2 && m.score >= (en ? 8 : 10)) { again = m; break; }
      }
      if (again && en !== e.en) this.both = { t: T };     // a verse at a time in two languages: from now on a verse is over when both are read
      // … and already read to its end again (a whole sentence of it at once): the screen is where it should be
      if (again && again.last >= again.len - 2) { e.t = T; return; }
      // (The first words of an English sentence can come out as a few Arabic words before the speech model settles:
      //  words still being said count as "not the next verse" only in the language of the reading.)
      // (when the screen moved on early, the last words of the verse before are still being said: they are not "something else")
      const waited = T - e.t - (e.left || 0) * 450, after = Math.max(0, since.length - (e.left || 0));
      if (!(again || (final && waited > 8000) || (waited > 2500 && after >= 5 && best < 2 && (final || en === e.en || (after >= 8 && this._both()))))) return;
      this.eov = null;
      if (this.hold) return;
      if (again) {
        // this sentence's words from where he began it again belong to it
        const i = shift + again.w0 - sn.base;
        this._carry = { final, text, en, skip: i >= 0 ? (this.track.open || 0) + i : 0, head: 0 };
      }
      const shown = this.show(e.prev, 'reading-stopped');
      this._carry = null;
      if (!again) this.noEov = { book: e.prev.book, chapter: e.prev.chapter, t: T };
      if (!again && this.passage && this.passage.open) this.passage = null;      // (a reading "from verse 3" that has stopped)
      if (again && shown && this.both && this.track) this.track.read[e.en ? 'en' : 'ar'] = true;   // (it was read in the first language already)
    }
    // A chapter announced without a verse ("مزمور ٤٦", "سفر إشعياء الأصحاح ١٢") is remembered for a minute …
    _arm(text, final) {
      const s = this.settings;
      if (!s.autoShow || s.readAlong === false) return;
      const t = tokenize(text);
      for (const r of findRefs(t)) {
        if (r.kind === 'reference' && r.book && r.verse == null && (final || r.end < t.length - 1) && this.bible.valid(r.book, r.chapter, null))
          this.armed = { book: r.book, chapter: r.chapter, t: this.now() };
      }
    }
    // … and when the opening words of one of its first three verses are heard, that verse goes up.
    _opening(text) {
      const a = this.armed, fi = this.detector.fuzzyIndex, T = this.now();
      if (!a) return false;
      if (T - a.t > 60000) { this.armed = null; return false; }
      const cur = this.screenType === 'show' ? this.current : null;
      if (cur && cur.book === a.book && cur.chapter === a.chapter) { this.armed = null; return false; }
      if (this.hold || this.screenType === 'video' || (!isEnglish(text) && !(fi && fi.ready))) return false;
      // (in Arabic, or in English with the translations on this PC: "The hand of the Lord was upon me")
      const en = isEnglish(text), words = this._toks(text, en).slice(-30);
      if (words.length < 3) return false;
      const weight = this._weight(en), eq = en ? enEq : softEq;
      for (let v = 1; v <= Math.min(3, this.bible.verseCount(a.book, a.chapter)); v++) {
        const r = { book: a.book, chapter: a.chapter, verse: v };
        const ok = this._wordings(r, en).some(V => {
          if (V.length < 3) return false;
          const m = seg(alignPairs(words, V, weight, eq), 0, V.length, V, weight);
          return m.n >= 3 && m.first <= 1 && m.dense >= 0.6 && m.score >= (en ? 8 : 6);
        });
        if (!ok) continue;
        const c = this._ref(r, { source: 'read', lang: en ? 'en' : 'ar' });
        this.armed = null;
        this.noteCard(c);
        if (this.opts.card) this.opts.card(c, { partial: false, auto: true });
        this.show(c, 'chapter-opening');
        return true;
      }
      return false;
    }
  }

  return {
    normalize, tokenize, parseNumber, findRefs, parseQuery, detectNav, detectNavDetail, refLabel, toArabicDigits, qtokens,
    stripTashkeel, enTokens, isEnglish, Bible, QuoteIndex, FuzzyQuoteIndex, verseSimilarity, alignWords, soft, Detector, Director, Phrases,
    DEFAULT_PHRASES, isLongRef, langRuns, VideoMatcher, SongIndex, splitTitle, BOOKS, version: '3.4.1',
  };
});
