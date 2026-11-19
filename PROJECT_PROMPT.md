# Project prompt — Arabic Church Assistant

Use this to describe or rebuild the project.

```
Build a free Windows desktop app for our Arabic-speaking church, "Arabic Church Assistant". It listens to the pastor preaching
(mostly Egyptian colloquial Arabic, quoting the Van Dyke Bible, sometimes English) and, the moment he mentions a
Bible verse, quotes one, reads on into the next verse, or names a hymn from our YouTube playlists, brings it up for
the projector and the livestream.

SPEECH
- Turn speech into text on this PC, with no Google and no internet while listening, and keep listening for a whole
  1–2 hour service: never stop after a sentence or two, recover by itself from an unplugged microphone or a crash.
- Use the most accurate Arabic model that runs here (Cohere Transcribe Arabic on the NVIDIA graphics card, or the
  processor without one). Measure it against Google and Whisper on real Egyptian Arabic.
- Voice detection (not loudness) to cut sentences; live text while the pastor speaks; Arabic and English mixed
  without switching anything.
- Listen to a microphone, to this PC's own sound (a video, YouTube, Zoom), or to a recording/video to test with.

DETECTION
- References said any way (MSA and Egyptian numbers, book before or after, ranges, "to the end of the chapter"),
  also when the speech engine spells a book, the chapter word or a number a little wrong.
- Quotes without a reference, even with a few words misheard; parallel passages offered.
- Follow the reading into the next verse; spoken "next verse" / "العدد اللي بعده".
- Hymn titles from YouTube playlists, however the titles are written.

DESKTOP APP
- Its own windows; the display full screen on the projector by itself; tray icon; one copy at a time; the PC stays
  awake while listening; a desktop icon; one Setup.bat that installs everything and can be run again.
- Operator console: live transcript, cards, Bible picker, service plan, playlists, history, on-screen preview,
  messages, keyboard shortcuts. Settings page. Phone remote with a PIN.
- Display links for OBS / other PCs (full screen, lower third, transparent / green), English underneath (built-in
  KJV/BSB/WEB/ASV, or ESV/NIV/NKJV with the church's own key), 7 Arabic fonts, tashkeel, transitions, YouTube videos.

QUALITY
- Tested (automated tests for detection), documented in a README, clear messages a non-technical operator understands.
```
