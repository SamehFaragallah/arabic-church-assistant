// Run: node test/youtube.test.js  — checks the YouTube playlist reader with pages shaped like YouTube's (no internet needed)
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const pick = name => src.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`))[0];
const UA = 'x'; const log = () => {};
async function fetchWithTimeout(url, ms, opts) { return global.fetch(url, opts); }
eval([pick('playlistIdFrom'), pick('videoIdFrom'), pick('jsonAfter'), 'var ytText = ' + src.match(/const ytText = ([^\n]+)/)[1], pick('collectVideos'), pick('playlistTitleFrom'), pick('fetchPlaylist')].join('\n'));
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) pass++; else { fail++; console.log('FAIL', n, '\n got ', a, '\n want', b); } };

eq('list id', playlistIdFrom('https://youtube.com/playlist?list=PLU6ETb4LbcJgHzSiu80t1VtJ7ITud6qlO&si=nMlamFpJj8oRYSns'), 'PLU6ETb4LbcJgHzSiu80t1VtJ7ITud6qlO');
eq('list id from watch url', playlistIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLU6ETb4LbcJgHzSiu80t1VtJ7ITud6qlO&index=2'), 'PLU6ETb4LbcJgHzSiu80t1VtJ7ITud6qlO');
eq('video id youtu.be', videoIdFrom('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
eq('video id shorts', videoIdFrom('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

// page in the classic layout, with a "load more" token; the continuation answers in the new (lockup) layout
const pvr = (id, t) => ({ playlistVideoRenderer: { videoId: id, title: { runs: [{ text: t }] }, lengthText: { simpleText: '3:45' }, isPlayable: true } });
const page = { metadata: { playlistMetadataRenderer: { title: 'موسيقى ترانيم للكنيسة والنيروز | توزيع بولس باسيلى' } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: [
    pvr('AAAAAAAAAA1', 'موسيقى ترنيمة أنا عايز أشكرك | توزيع بولس باسيلى'),
    pvr('AAAAAAAAAA2', 'موسيقى ترنيمة "ربنا موجود" \\ test'),
    { playlistVideoRenderer: { videoId: 'AAAAAAAAAA3', title: { runs: [{ text: '[Deleted video]' }] }, isPlayable: false } },
    { continuationItemRenderer: { continuationEndpoint: { commandExecutorCommand: { commands: [{ continuationCommand: { token: 'TOKEN1' } }] } } } },
  ] } }] } }] } } } }] } } };
const html = '<html><script>var ytInitialData = ' + JSON.stringify(page) + ';</script><script>ytcfg.set({"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CLIENT_VERSION":"2.20261101.01.00"});</script></html>';
const cont = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
  { lockupViewModel: { contentId: 'BBBBBBBBBB1', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'موسيقى ترنيمة قلبي الخفاق | توزيع بولس باسيلى' } } } } },
  pvr('AAAAAAAAAA1', 'duplicate'),
] } }] };
const calls = [];
global.fetch = async (url, opts) => {
  calls.push(url);
  if (url.includes('/playlist?list=GOOD')) return { ok: true, text: async () => html };
  if (url.includes('/youtubei/v1/browse')) { const b = JSON.parse(opts.body); return { ok: true, json: async () => (b.continuation === 'TOKEN1' ? cont : {}) }; }
  if (url.includes('/playlist?list=FEEDONLY')) return { ok: true, text: async () => '<html>nothing</html>' };
  if (url.includes('feeds/videos.xml') && !url.includes('MISSING')) return { ok: true, text: async () => '<feed><title>Feed title &amp; more</title><entry><yt:videoId>CCCCCCCCCC1</yt:videoId><title>موسيقى ترنيمة سبحوه</title></entry><entry><yt:videoId>CCCCCCCCCC2</yt:videoId><title>Hallelujah &amp; هللويا</title></entry></feed>' };
  return { ok: false, status: 404, text: async () => '' };
};
(async () => {
  const pl = await fetchPlaylist('GOOD');
  eq('playlist title', pl.title, 'موسيقى ترانيم للكنيسة والنيروز | توزيع بولس باسيلى');
  eq('playlist videos (page + load more, no deleted, no duplicates)', pl.videos.map(v => v.id), ['AAAAAAAAAA1', 'AAAAAAAAAA2', 'BBBBBBBBBB1']);
  eq('title with quotes/backslash survives', pl.videos[1].title, 'موسيقى ترنيمة "ربنا موجود" \\ test');
  eq('api key used for load more', calls.some(u => u.includes('key=KEY123')), true);
  const f = await fetchPlaylist('FEEDONLY');
  eq('feed fallback', [f.title, f.videos.map(v => v.title), f.partial], ['Feed title & more', ['موسيقى ترنيمة سبحوه', 'Hallelujah & هللويا'], true]);
  try { await fetchPlaylist('MISSING'); eq('missing playlist throws', false, true); } catch (e) { eq('missing playlist message', /Public or Unlisted/.test(e.message), true); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('FAIL: the test stopped: ' + (e && e.stack || e)); process.exitCode = 1; });
