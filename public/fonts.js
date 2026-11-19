/* Arabic display fonts. The server keeps a copy of each font in data\fonts after the first
   download, so the display still looks right without internet. Shared by the display and
   settings pages. */
(function () {
  const FONTS = {
    naskh:        { name: 'Noto Naskh Arabic', scale: 1.0,  lh: 1.8,  label: 'Noto Naskh',   note: 'Classic Naskh, very readable (default)' },
    amiri:        { name: 'Amiri',             scale: 1.0,  lh: 1.8,  label: 'Amiri',        note: 'Traditional book style' },
    scheherazade: { name: 'Scheherazade New',  scale: 1.12, lh: 1.65, label: 'Scheherazade', note: 'Traditional, large letters' },
    cairo:        { name: 'Cairo',             scale: 0.92, lh: 1.75, label: 'Cairo',        note: 'Modern, clean' },
    tajawal:      { name: 'Tajawal',           scale: 1.0,  lh: 1.7,  label: 'Tajawal',      note: 'Modern, light' },
    readex:       { name: 'Readex Pro',        scale: 0.9,  lh: 1.75, label: 'Readex Pro',   note: 'Modern, wide' },
    kufi:         { name: 'Noto Kufi Arabic',  scale: 0.88, lh: 1.85, label: 'Noto Kufi',    note: 'Geometric Kufi' },
  };
  // The server answers immediately (empty when the font isn't saved yet, e.g. no internet), so a
  // page never waits for fonts; we retry a few times while the server downloads them.
  const loaded = new Set();
  async function loadCss(key, attempt) {
    attempt = attempt || 0;
    if (!attempt) { if (loaded.has(key)) return; loaded.add(key); }
    try {
      const r = await fetch('/fonts/' + key + '.css', { cache: 'no-store' });
      const css = r.ok ? await r.text() : '';
      if (css.indexOf('@font-face') >= 0) {
        const st = document.createElement('style');
        st.textContent = css;
        document.head.appendChild(st);
        // let pages re-measure text once the font has arrived
        setTimeout(() => window.dispatchEvent(new Event('vf-font-loaded')), 300);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => window.dispatchEvent(new Event('vf-font-loaded')));
        return;
      }
    } catch (e) { /* server not reachable */ }
    const wait = [4000, 10000, 30000, 90000][attempt];
    if (wait) setTimeout(() => loadCss(key, attempt + 1), wait);
  }
  function loadFont(key) {
    const k = FONTS[key] ? key : 'naskh';
    loadCss(k);
    return FONTS[k];
  }
  window.VF_FONTS = FONTS;
  window.VF_loadFont = loadFont;
  window.VF_loadCss = loadCss;
})();
