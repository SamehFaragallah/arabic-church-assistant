# Arabic Church Assistant

Made by **Sameh Welson Faragallah**.

Arabic Church Assistant listens to the pastor preaching in Arabic or English. When he mentions a Bible verse, quotes one, reads on into the next verse, or names a hymn from your YouTube playlists, it brings it up for the projector and the livestream.

## Download

The [latest release](https://github.com/SamehFaragallah/arabic-church-assistant/releases/latest) has two downloads under **Assets**. Both are the finished app, ready to run: nothing else has to be installed.

- **`Arabic-Church-Assistant-…-Windows.zip`** (about 240 MB): listens with Google (needs internet). The model that runs on the PC itself is downloaded later, only if **On this PC** is chosen in Settings.
- **The offline edition** (about 7 GB, in parts, because GitHub takes files of up to 2 GB): everything, the speech model included, for a church without internet. Download every `…-Windows-Offline.zip.001`, `.002`, … part and the `…-Offline-Join.bat` into one folder, then double-click the `.bat`: it puts the parts together and unpacks the folder. It listens **On this PC** from the start: with an NVIDIA graphics card (6 GB or more) it keeps up with the pastor; without one it works, more slowly.

1. Right-click the zip, choose **Extract All**, and put the folder where it can stay (for example in Documents). (The offline edition's `.bat` does this for you.)
2. In the folder, double-click **Arabic Church Assistant** (the shortcut at the top of the folder). To also have its icon on the desktop and in the Start menu, double-click **`Setup.bat`** once.
3. Windows may say *Windows protected your PC*, because the app is new and not signed: click **More info → Run anyway**. When it asks whether the app may use the network, click **Allow** (for the phone remote, OBS and displays on other PCs).

It needs Windows 10 or 11, and **Google Chrome** for Google speech (the offline edition doesn't need it). The app, its speech engine and the Bibles are all inside the folder.

**On a Mac:** the Mac version is a release of its own, with only the Mac's files in it: **[Arabic Church Assistant 3.4.1 for Mac](https://github.com/SamehFaragallah/arabic-church-assistant/releases/tag/v3.4.1-mac)** (macOS 14 or newer on an Apple chip, 13.4 or newer on an Intel Mac). Google or a paid service listens; **On this PC** is for Windows PCs with an NVIDIA card. How it is built and signed: [macos/README.md](macos/README.md).

The English under the Arabic is the NKJV, from API.Bible, with the key that comes with the app (the ESV and many more can be chosen); without internet the KJV that is inside the app is shown instead. A church can use its own keys in **Settings → English on screen**.

## What it listens with, and how much space it takes

Speech is turned into text by **Google** (free, online, through a hidden Chrome), unless something else is chosen in **Settings → Listening → Speech recognition**:

| Choice | Download | Space on the PC | Cost |
|---|---|---|---|
| **Google** (the default) | the app's zip, about 240 MB | about 560 MB | free (needs internet) |
| **On this PC** (Cohere Transcribe Arabic) | about 7 GB more, the first time it is chosen (4.5 GB on a PC without an NVIDIA card) | about 8.5 GB more (4.6 GB without NVIDIA) | free, no internet while listening |
| **The offline edition** (On this PC from the start) | about 7 GB, in parts | about 9.3 GB | free, no internet at all |
| **Soniox** / **ElevenLabs** / **Deepgram** | nothing more | nothing more | paid, with the church's own key |

The model for **On this PC** is downloaded only when that choice is picked; Google listens until it is ready, and Settings shows how far the download is. It needs an NVIDIA graphics card with 6 GB (or a fast processor). Its download page on Hugging Face asks for a sign-in. The download zip comes with a read-only key for it, so nobody has to sign in; without a working key (for example in a copy made from this code), Settings shows the three steps to use your own.

Version 3 is a Windows desktop app. With **On this PC**, nothing goes to Google or anywhere else, there's no internet needed while listening, and it keeps listening for the whole service. Google's speech recognition is fixed so that it keeps listening for the whole service too.

## Why it changed

Version 2 used Chrome's speech recognition (Google's servers). That has built-in silence timeouts and undocumented server cut-offs, so it stopped after a sentence or two. Version 2's offline option, Whisper, was less accurate in Arabic.

On the same real Egyptian Arabic recordings, measured on this PC:

| | Read Arabic, Egyptian speakers (FLEURS): word errors | Everyday Egyptian dialect (Casablanca): word errors | Sermon test with church echo and noise: references and hymns found, of 22 |
|---|---|---|---|
| **Cohere Transcribe Arabic (v3)** | **3.8%** | **40%** | **12 found** |
| Google (Chrome) | 6.7% | 52% | 3 found |
| Whisper large-v3-turbo (v2 offline) | 8.8% | 61% | 5 found |

The sermon test was read by Windows' Egyptian Arabic voice, with echo and noise added. Without the added echo and noise, the new engine and the improved detector found all 22.

## Speech recognition choices

**Google** is the default. **Automatic** uses the model on this PC when the PC has an NVIDIA graphics card good enough for it (6 GB or more, GeForce 16 / RTX 20 series or newer; the model takes about 4.6 GB of it) and the model has been downloaded; otherwise Google. If Google or ElevenLabs stops answering in the middle of a service (no internet), the model on this PC takes over if it is installed, and the chosen service is tried again when listening is stopped. **Settings → Listening** shows what this PC has and which one Automatic picked. Any choice can also be picked by hand.

Two real sermon clips from our livestream recordings (noisier than the sound desk), through the whole app:

| | Word errors, John 4 reading | Word errors, Habakkuk 3 + Psalm 46 | Spoken references caught | Words appear | Cost |
|---|---|---|---|---|---|
| On this PC (Cohere) | 10% | 24% | John 4 | when each sentence ends | free |
| ElevenLabs Scribe Live | 11% | 14% | John 4, Psalm 46 | while the pastor talks (about 1 s) | $0.30 / hour |
| Soniox (real-time) | 7% | 9% | John 4, Habakkuk 3:17, Psalm 46 | while the pastor talks (about 1 s behind) | about $0.12 / hour |
| Google (Chrome) | 29% | 66% | John 4 | while the pastor talks (about 1 s) | free |

Soniox was measured on 18 November 2026 with the same two clips, references and counting, but through Soniox's own free comparison page (stt.compare.soniox.com; Arabic, its sentence-end detection on, no Bible names given as hints), not through Arabic Church Assistant: the account had no credit. It made about 40% fewer word errors than ElevenLabs Live on both clips (19 against 32 of 277 words, 23 against 37 of 251) and wrote «لحبقوق 3:17» and «مزمور 46» as said. Its own sentence-end detection did not end a sentence once during the two minutes of continuous reading, so in the app the engine's own pause detection closes the sentences (built in). With today's detector the texts of all three services give the app Habakkuk 3:17 and Psalm 46 as well as John 4.

Two harder tests on the same page, the same day (again not through Arabic Church Assistant):

- **From across a room** (the home recordings of 17 November: several people talking, away from the microphone), set beside a careful transcript of the same recordings (ElevenLabs Scribe given each whole recording at once). In the first excerpt (a prayer, Genesis 3:15, Philippians 4, Ephesians 5:1-5 read out; 218 words) Soniox differed in 17% of the words and the model on this PC, live that evening, in 22%. In the second (verses quoted from memory across the room, with talk in between; 513 words) Soniox differed in 30% and the model on this PC in 46%. Soniox wrote «في البدء خلق الله السماوات والأرض» right all three times, «تكوين 3:15», «أفسس 5 من عدد 1 إلى عدد 5» and 13 for «تلاتاشر». Run through today's rules, both texts put the same verses on the screen.
- **From the sound desk, with an interpreter** (Ezekiel 37 read by an English pastor, each sentence given in Arabic; 2½ minutes): Soniox wrote the two voices as separate sentences, each in its own language and with «حزقيال» spelt right (65 short sentences; the model on this PC wrote 25, several with the two languages run together, and «حسقيان» for حزقيال). Both put Ezekiel 37:1-4 on the screen in order. No careful transcript was made of this one, so there is no error figure.

Soniox ends a sentence at every short pause, so a verse said in two breaths arrives as two sentences. The rule for that (below: *a verse said in pieces*) came out of this test.

**How far behind Soniox is** (measured 18 November 2026 on a recording of our own, with Soniox's own time stamps for each word, which agree with the sound to within a tenth of a second): a word first appears about **1 second** after it is said (0.9 to 1.0 s in nine runs), and a sentence is closed about 0.7 s after its last word. Arabic Church Assistant adds 0.1 to 0.2 s. That second is how the model (stt-rt-v6) works, and no setting changes it: sending the sound in smaller pieces, leaving out the names and the language detection, or switching its sentence-end detection off made no difference. Its faster sentence-end settings were tried too: levels 1 and 2 close a sentence 0.1 s sooner, and level 3 with the shortest delay chopped a slowly read verse into single words and misheard some, so the app keeps the defaults. The older model (stt-rt-v5) shows a word 0.6 s after it is said, but Soniox removes it on 15 December 2026.

**What Soniox charges** is counted in tokens, not hours: the sound sent ($2 a million tokens, about 6 cents an hour), the text it writes ($4 a million, about 6 cents for an hour of steady speech) and the names given as hints at the start of every stream ($4 a million). "About $0.12 an hour" is their own round figure for the three together. A stream is open only while Arabic Church Assistant is listening. From the account's own usage log for our first evening (18 November 2026, 23 minutes of listening in seven sessions): the sound came to 6 cents an hour, the text to 3 cents an hour (there were pauses), and the hints (the books of the Bible and the hymn titles, 832 tokens) to a third of a cent **each time listening starts**, and again for each spoken command from the phone. In a two-hour service that is about 20 cents, of which the hints are under one cent; in a string of short tests the hints were nearly half the bill.

Google skips many words on church sound (it left out most of the Habakkuk recitation), so it finds fewer verses. Version 2's Google stopped after a sentence or two; Arabic Church Assistant now closes each sentence itself at the pastor's pauses (Google never decides a sentence has ended on church audio), and starts the next one before the last one stops, so it keeps listening for the whole service.

## First-time setup

Nothing has to be installed on the PC first: no Python, no Node.js. The PC needs Windows 10 or 11 and, for setup, the internet.

The download zip has everything in it already, so `Setup.bat` only makes the icons. From the code on GitHub (no `bin` and no `engine\python` yet), `Setup.bat` fetches the rest:

1. Double-click **`Setup.bat`**. It:
   - sets up the app (`bin\Arabic Church Assistant.exe`; downloads about 150 MB if needed, and keeps only the English and Arabic languages of its menus),
   - gives the speech engine a Python of its own in `engine\python` (the official Python, 15 MB), with the two Microsoft Visual C++ runtime libraries the engine needs beside it (a freshly installed Windows does not have them); all of it stays inside this folder and nothing is installed on the PC,
   - installs what Google speech and the paid services need into it (about 80 MB),
   - puts an **Arabic Church Assistant** icon on the desktop and in the Start menu.

   `Setup.bat -Model` also installs the model for **On this PC** (PyTorch, with NVIDIA graphics-card support when there is a card, and the 4 GB model), the same as choosing it in Settings.
2. The first time Arabic Church Assistant opens, Windows asks whether **Arabic Church Assistant may use the network**. Click **Allow**: OBS on another PC, the phone remote and displays on other PCs need it. On this PC everything works either way.

**Moving to another PC.** Copy the whole folder and double-click `Setup.bat` there: it finds what is already in the folder and only makes the desktop icon (or downloads what is missing). Once the engine is in `engine\python`, the copied folder also runs as it is, with `Arabic Church Assistant.bat`, even without internet. The model, your settings and every API key (all in `settings.json`), the playlists and the song database, your plan and the history come with the folder: nothing is kept in Windows or in your user profile. The microphone and the projector screen are found again on the new PC (when the saved microphone is not there, the Windows default is used).

**Giving it to another church.** The download zip is the simplest: it has no settings, keys or services of yours. A copy of your own folder works there too, settings and keys included. Two things to know first: with your keys in it, everything they listen to with Soniox or ElevenLabs is paid from your accounts until they paste their own in Settings; and `data\recordings`, `data\logs` and `data\history` hold the sound and the transcripts of your own services, so delete those three folders from the copy if they should not go with it.

A PC set up before version 3.2 has the engine in `engine\.venv` instead, tied to a Python installed on that PC; it keeps working there, but it does not survive being copied. `Setup.bat -Repair` rebuilds it as `engine\python` (downloads about 3 GB again unless it is still in the PC's cache).

## Every service

1. Open **Arabic Church Assistant** from the desktop icon.
   - The display opens full screen on the projector (the second screen) by itself.
   - With only one screen it opens as a window. Double-click it to switch full screen on or off.
2. Check **Listen to**: the pastor's microphone. The level bar moves when someone speaks and turns green when it hears a voice.
3. Press **Start listening** (or the **L** key).
4. Verses and hymns appear as cards. Click **Show** or **▶ Play**, or turn on **Auto-show**.

Keys: **Enter** shows the newest card, **← / →** previous or next verse, **Backspace** goes back to what was on screen before, **Esc** clears the screen, **H** Hold on or off, **L** listening on or off, **N** next in the plan, **B** opens the Bible, **/** finds a verse.

- **⟲ Back** (Backspace, or Back on the phone) undoes a wrong screen change: the verse, message or blank screen from before comes back, the reading carries on from there, and the verse that was taken off is not put straight back by itself. It goes back up to ten screens.
- **Hold** (H, or Hold on the phone): verses are still found and listed, but nothing goes on screen by itself until Hold is turned off. Use it to rehearse with a recording while the livestream is on, or when the detection is getting in the way. It is off every time the app starts.

## What it understands

- **References**, however they're said: «يوحنا ٣: ١٦», «إنجيل يوحنا الأصحاح الثالث والعدد السادس عشر», «يوحنا تلاتة عدد ستاشر», «العدد ١٦ من الأصحاح الثالث من يوحنا», «كورنثوس الأولى», «مزمور مية وتسعتاشر», «من عدد ٢٨ لعدد ٣٠», «لآخر الأصحاح», and "John chapter three verse sixteen".
- **Slips of the speech engine**: «يوحن», «كورينثوس», «ارميه», «رسالة يومية» (for رومية), «الإصحاحة», «استاشر» and «تناشر» are still understood. Book words like «إنجيل» and «رسالة» keep this from catching everyday words.
- **Quotes without a reference** («لأنه هكذا أحب الله العالم…»), even with a few words misheard. When the same saying is in several places, the card offers the others.
  - **How much has to be said** for a quote to go on the screen by itself: six words in a row, word for word; or five («الرب راعي فلا يعوزني شيء», "He leads me in green pastures") when hardly another verse has those words; or, with a word heard differently, six words of the verse, or five that are nearly the whole of a short verse («في البدء خلق الله السماء والأرض»). Less than that makes a card only.
  - **A verse quoted again** after it has left the screen comes back (it used to be ignored for a minute and a half). Not while it is still up, not in the chapter that is being read, and not in the 15 seconds after it leaves the screen: those are its last words still arriving, or the operator took it off while it was being said.
  - **A verse said in pieces**, with a pause in the middle («لأنه هكذا أحب الله العالم» … «حتى بذل ابنه الوحيد»): the speech engine ends a sentence at the pause, each half alone was too little to be sure of, and the verse stayed a card. Now the half before counts together with the next sentence, when that comes within 15 seconds and is more of the same verse; the verse then goes up, and no second card is made. On the recorded services this brings up Isaiah 40:31, Psalm 103:5 and Revelation 5:9, each said in two breaths, and the six verses of Psalm 103 that were skipped when it was read out a line at a time; nothing wrong was added.
  - **A quote goes up while it is still being said** (with a speech service that gives the words as they are spoken: Soniox, ElevenLabs, Google; the model on this PC gives them about once a second). As soon as enough of the verse has been said to be sure of it, by the rules above, it goes up: for John 3:16 that is at «…حتى بذل ابنه», about three seconds in, instead of when the sentence ends eight seconds in. The words still being said can change, so the verse has to be found in two updates in a row; a set prayer is still a set prayer; and a verse the operator takes off while it is being said stays off. **Settings → Detection → Show a quote while it is still being said** (on by default); off, a quote goes up when the sentence is finished, as before 3.3.3.
  - **While a reading is being followed**, a quote of a verse somewhere else has to be six words in a row, word for word, to pull the screen away; less makes a card. (John 3:24 read from a translation this PC does not have, "This was before John was put in prison", used to put Mark 1:14 up in the middle of the reading.)
- **Follow the reading**: with a verse on screen, the screen keeps in step with the reader. No one needs to say "the next verse".
  - **A passage that was announced** («يوحنا ٣ من ١٤ إلى ٢٠», «هنقرأ من عدد ٣») **or put up from the plan** is followed from its first verse: each verse goes up as the last words of the one before it are said, and the screen stops at the verse the passage ends on. (**Settings → Detection → In a reading, move on as each verse ends**.)
  - **One verse announced, and the pastor reads on**: the next verse goes up at its first words (about a second into it). After three verses in a row it is treated as a reading too, and each verse goes up as the one before it ends.
  - **How early**: the next verse goes up about a second before the one on screen ends (**Settings → Detection → the slider under "In a reading, move on as each verse ends"**, 0 to 3 seconds; at 0 it waits for the last word).
  - **He stops**: if the screen moved on and he talks about the verse instead, or nothing is said for 8 seconds (20 inside a passage announced with its end), it goes back to the verse he ended on. That step back is meant: the screen went ahead expecting him to read on, and he did not. A verse read from a translation this PC does not have (its words come in the same order, but with others between them) counts as reading on, so the screen no longer steps back in the middle of it. To have no stepping back at all, turn off **In a reading, move on as each verse ends**: the next verse then goes up at its first words.
  - **The last verse of a chapter** (or of a psalm): following ends there. The screen does not go on into the next chapter by itself. A reader who does go on is found by the words, like any quote, or says the reference.
  - **Two or three verses announced together** («يوحنا ٣: ١٤-١٦») go up together and stay.
  - **English** is followed the same way (with the English translations on this PC). When a passage is read in both languages, a verse at a time, the screen moves on once both have read it.
  - Only what is said after a verse goes up counts for it, in order. Words that two verses share (the end of John 3:16 is John 3:15, word for word) no longer pull the screen to the other verse or move it on early.
  - When one sentence runs across two verses, both are shown, and a verse recognized two or three further on brings the ones before it with it, so no verse of a passage is skipped.
  - A chapter announced without a verse («مزمور ٤٦») is remembered for a minute: when the opening words of one of its first three verses are heard, that verse goes up.
  - A reference in words that are still being said goes up once it has stayed the same for two previews (a number half said, «ستة…» on the way to «ستة عشر», used to flash the wrong verse).
- **Misheard book names**: «لحبقوك 3 17», «حبقوق 317» (chapter and verse written as one number), «نحوم واحد واحد», «مضمون 46» (for مزمور) and «جون 3:14» ("John" said the English way) are understood, and so is Philippians as it is often written: «فليب ٤», «فيليب», and «في ليبيا 4 عدد واحد» (with chapter and verse straight after), and Philemon as Soniox wrote it, «في لمون 1:5» (also only with chapter and verse straight after), with «الأصح رابع وعدد أربع» for «الأصحاح الرابع وعدد أربعة». «103 عدد 3» with no book named is taken for a psalm (no other book has a chapter 103): a **not sure** card, or for certain while the Psalms are being read. «إيه» ("what") is no longer read as «آية»: «شكله إيه؟ … واحد» is not "verse one". A range that runs past the end of the chapter («مزمور ١ من ١ لـ ١٠») goes to its last verse. When the book itself is a guess («الصومين الأول إصحاح ٣» for صموئيل الأول) the card says **not sure** and never goes on screen by itself. Everyday words next to «صفحة» or «الأصحاح» («شوية صفحة ١٢») are no longer taken for a book.
- **Set prayers and formulas**: words said every week are not quotations. «باسم الآب والابن والروح القدس» no longer brings up Matthew 28:19, the doxology no longer Jude 1:25, and the Lord's Prayer brings up Matthew 6:9-13 instead of Luke 11:2. The list is in **Settings → Detection → Set prayers**: each phrase is *ignored*, makes a *card only*, or *shows a passage*. A card for a quoted verse also has a **Card only** button: quoted words then never put that verse on screen by themselves.
- **Spoken navigation**: «العدد اللي بعده», «الآية التالية», "next verse"; and the one word alone, «التالي» or "Next." ("Next verse." said after an Arabic verse is often written «التالي»). «اللي بعده» alone counts at the end of a sentence, in any of its forms («اللي بعدها», «اللي بعديه», «اللي بعديها»; «اللي قبله» the same way). Talk about the screen («لما أقول اللي بعده بييجي اللي بعده») is not a command, and neither is «مش في اللي بعديها».
- **Arabic + English in one service**: each sentence is written in the language it was spoken in, so English quotes are recognized without pressing anything.
- **A sermon with an interpreter** (an English pastor, and someone giving each sentence in Arabic): nothing has to be switched on. When the sentences keep changing language, the speech engine notices (the log says "an interpreter is at work") and from then on:
  - it asks the speech model for each stretch of sound in both languages and keeps both sentences. The two voices run into each other and overlap, and the model writes only the language it is asked for: before this, about three quarters of the pastor's English was lost and only the Arabic came out;
  - it cuts sentences at shorter pauses (0.3 s), so the two voices fall into sentences of their own more often;
  - a sentence that holds both ("He needs us to cooperate with him. يريدنا أن نتعاون معه") is taken as two sentences, each in its own language, so a reference or a verse is found in whichever language it was clearer («Jeremiah 32, 27» when the Arabic was heard as «أرميا ٢٢ ٣٧»);
  - in a reading, a verse is over when both the pastor and the interpreter have read its last words, and a pastor who stops to talk about each verse is waited for: after the screen has gone on once and had to come back, the next verse goes up when he begins it.
  It goes back to normal after ten sentences in one language.
  Two languages by turns in ordinary talk set it off as well, and the model then made things up. An answer that is not what was said is no longer kept: one that goes round in circles ("I'm not sure." eight times), one in two scripts mixed word by word ("For the Bid's, خلق Allah السماوات والأرض" for «في البدء خلق الله السماوات والأرض»), an English answer with fewer than half the Arabic answer's words, and a short sentence with the model's own translation of it beside it (when the sound is too short to hold two sentences).
- **A reference said again** brings the verse back when something else is on the screen ("can you bring that back up? Matthew 28:19").
- **English straight after Arabic**: when the speech model is unsure of a sentence it wrote as Arabic, it is asked for English too and the surer answer is kept (a few English sentences used to come out as stray Arabic words).
- **A hymn plays by itself once**: mentioned again later in the service, its card comes to the top but it is not started again (Settings: "A hymn that has played by itself is not played again by itself", on unless turned off).
- **Hymn titles** from your YouTube playlists, including titles written like «سلامك فاق العقول- موسيقى وكلمات» or with another name in brackets.
- **A hymn plays by itself only when it is announced** as something we are about to sing or hear, the way worship leaders say it: «خلونا نرنم مع بعض ترنيمة …», «تعالوا نرنم ونقول …», «تعالوا نكمل تسبيح ونقول …», «نسمع ترنيمة …», «شغلوا …», "let's sing …". A title or first line on its own, said in a prayer, or quoted in the sermon («فيه ترنيمة جميلة بتقول …») makes a card with a Play button and nothing more. (It used to start for any long title: «يا راويني يا يسوع بحنانك» said in a prayer set the video off.) Praise addressed to God («نسبح اسمك») is not an announcement.
- **The song database** (🎵 Videos tab): every title of whole playlists and channels, read from YouTube once and kept on this PC in `data\songs.json` (one line a video: its id and its title; its link is `https://www.youtube.com/watch?v=` and the id). Paste the link of a playlist or of a channel's page and press **＋ Song database**. Nothing in it plays by itself:
  - a hymn that is **announced or named but is not in your playlists** gets a card listing every song in the database whose title begins with what was said (the same hymn in other keys and versions too): press Play on the one you want. When a word was heard wrong («مستحق كل المادة» for «مستحق كل المجد») the nearest title is offered, and so is a title that sounds like the words when they are run together: a word said once or twice where the title repeats it, two words heard as one («قدوس قدوس هات صوت الملائ» or «قدوس، ها صوت الملائكة» for «قدوس قدوس قدوس هاصوت الملائكة», 18 November, where only the short «قدوس قدوس قدوس» had been offered). When the database has nothing, the card offers to search YouTube for the words. A name said right after «ترنيمة» counts as a hymn's name even when a word of it was heard a little off («ترنيمة باركي يا نفس الراب»), and its words make no verse card (it brought up Psalm 104:35 instead, 26 November). «ترنيمة» as the speech engines have misheard it counts too when a hymn's name follows it exactly: Soniox's «تقريباً» (when the name hints are off), the local model's «ترنيمت» / «ترميمت»;
  - **Search YouTube** (Videos tab, and the phone's Videos tab): while you type, **ترنيمه** and **كلمه ولحن** buttons under the box put those words in where the cursor is, with the spaces they need;
  - the **search box** of the Videos tab searches your playlists and the database as you type (spelling evened out: «مالى» / «مالي», «الفخار» / «الفخاري»). **＋ My videos** on a result puts it in your own videos, so that next time it plays when announced;
  - its lists are under "Song database" in the Videos tab (↻ reads one again, ✕ takes it out); they are read again by themselves every two weeks.
  - Long playlists are now read to the end (YouTube changed its page and they stopped at 100 videos).

## Testing without a pastor

- **Listen to → 📁 Test with a recording or video…**: the recording plays on the speakers and is listened to like the pastor. Afterwards listening goes back to how it was.
- **Listen to → 🔊 This PC's sound**: listens to whatever plays on this PC (YouTube, Zoom, a video player).
- Type a sentence in the box under the transcript.

## New in version 3

- **Desktop app**: its own windows, the display placed on the projector automatically, a tray icon, and the PC kept awake while listening.
- **Speech on this PC** with automatic recovery: if the microphone is unplugged, the engine stops or the graphics card has a problem, it reconnects or restarts by itself.
  - **No sound from the input**: if the microphone gives digital silence for 20 seconds, or next to nothing for a minute, while listening (the sound desk's feed is muted or unplugged), the input is opened afresh once, and then a red notice stays on the console until the sound is back.
  - Sentences heard while the speech model is loading (after a restart or a switch to the model on this PC) are kept and written out when it is ready, up to 40 seconds of them. They are listed, but they do not change the screen.
  - If the speech model sits on one sentence for ever, or the graphics card fails, the engine starts afresh by itself (once for the graphics card; if it fails again within ten minutes the processor takes over).
  - A paid service that refuses the key or runs out of credit hands over to the model on this PC, when it is installed.
  - A model that fails to load is tried again after 30 seconds, 2 minutes and 5 minutes.
- **📋 Plan**: list the service's verses and hymns before it starts. One click shows each one, and **N** goes down the list. Detected verses that are in the plan are marked.
- **🕘 History**: every service is saved with the verses shown, the videos played and the full transcript. **Save as text…** exports it.
  - Everything that happens on the screen is kept with its time to the second and **who or what did it**: a verse that went up by itself (reference heard, quote heard, followed the reading…), a card, the Bible tab, the plan, the phone, Back, a cleared screen. Every verse that was found is kept too, with whether it went up by itself, and every sentence with when it was said and how long its text took. These are in `data\history\<date>.jsonl`.
  - **The log**: what the app and the speech engine report (starting, the microphone, warnings, restarts, every screen change) is kept in `data\logs\<date>.log`, a line each with its time to the millisecond, for 60 days. Since version 3.3 it also has every sentence (`heard`, with how sure the model on this PC was of it: `sure -0.05` is certain, below about `-0.3` it was guessing), the words as they arrived (`words`), every verse found (`card`) and the recording's start and stop (`record`). A hymn that started because its title was said is marked `auto-video`; one started by a click, `operator`. The keys are never written to it.
  - **A sound recording** of whatever is listened to is kept as well, **on unless you turn it off** (**Settings → Listening → Record of each service**): about 11 MB an hour in `data\recordings`, one file for each stretch of listening, removed after 8 weeks (or the number you set). Every sentence in the log and the history says which file it is in and how many seconds into it, so a missed or wrong verse can be checked against what was really said. Test recordings are not recorded again.
  - **Going through a service again**: `node test/replay-log.js 2026-11-17 17:04 17:08` gives that day's sentences, and the words as they arrived, to the screen rules as they are now, at the same times, and lists what they would put up (NOW) beside what the app put up that day (THEN). It is how a wrong or late verse is tracked down, and how a change to the rules is checked against a real service. (It needs Node.js. On a PC without it, the app's own program can run it: `set ELECTRON_RUN_AS_NODE=1`, then `"bin\Arabic Church Assistant.exe" test\replay-log.js 2026-11-17`.)
- **Find by words**: type words from a verse («هكذا أحب الله», "all things work together") instead of the reference.
- **✎ Put a message on screen**: announcements, a sermon title, prayer points.
- **Phone remote**: on a phone on the same Wi-Fi, open the address shown in **Settings → Phone remote** (https, port 5443; the phone warns about it the first time, choose Advanced → Proceed) and enter the PIN. **Screen** tab: Previous / Next pinned at the bottom (under your thumb), Clear the screen, show newest, next in plan, **Found while listening** (the newest finds of the console: each verse with Show and ＋ Plan, each hymn announced with its matches from the song database and ▶ Play; the verse on the screen is marked; Show more lists up to 15; cleared with the console's cards), a round hold-to-speak button and a box to type in, listening on/off, Hold, a **message** for the screen (title and text), and the service plan (tap Show or Play on any item). What is said or typed on the phone is understood like the voice: "Next verse" / «اللي بعده» moves on, a reference shows its verse, a hymn from your playlists plays, and a hymn from the **song database** is listed under the box with ▶ Play (it is not played by itself, as on the console's cards; when the words are a verse too, a button shows that verse instead). **Bible** tab: tap a book, a chapter, then a verse to put it on the screen (the books read right to left, Genesis first). **Videos** tab: one search for your playlists and the **song database** (the database's matches are listed under yours), and a YouTube search with a ✕ in the search box to clear it (play now, add to the plan, add to your videos); videos already in the plan say "In Plan" (tap it to take the video out of the plan). While a video plays, both tabs show its controls and a progress bar you can tap or drag to jump.
  - **🎤 Hold to speak**: hold the button, say a verse («يوحنا ٣ ١٦») or a hymn title, and let go. The verse goes on screen or the hymn plays, and the phone says what was done.
- **YouTube search** (🎵 Videos tab): search all of YouTube, then ▶ Play now, ＋ add to the Plan, or ＋ add to your videos (so its title is also noticed when it is said).
- **Auto-play hymns** is on by default and on the console's top bar: a hymn from your playlists starts when it is announced (see "A hymn plays by itself only when it is announced"). Mentioned hymns appear in their own **Just mentioned** section, so the list doesn't jump while you scroll it.
- **Display**: choose the monitor, hide the reference line, plus the version 2 look options (7 Arabic fonts, tashkeel, layouts, backgrounds, transitions).

## No graphics card? Google or a paid service

Without a good NVIDIA graphics card, **Automatic** uses **Google** (free). It needs internet and Google Chrome installed on the PC; Arabic Church Assistant starts Chrome hidden by itself (no window) and closes it when Arabic Church Assistant closes.

**Google in Arabic and English.** A Google recognizer hears one language, and English said to the Arabic one comes out as a word or two of Arabic («ماتش», «انجلش») or nothing. So with the listening language on **Arabic + English** (Settings → Listening), each sentence is heard by an Arabic and an English recognizer at once, on the same sound, and the one that makes sense is kept (a spoken command from the phone too). Google's own confidence does not tell them apart: Arabic heard by the English recognizer comes out as confident English nonsense of about the same length ("Iowa Stephanie" for «ايوه اشتغل»). What does: the wrong recognizer hears much less than the right one, so the English is kept when it holds much more than the Arabic, or when it is a command ("Next") or a whole reference ("John 1:5") the Arabic does not have. While the words are still coming the Arabic shows until the English is clearly ahead. On our recordings of 18 November this kept the language that was spoken for 124 of the 130 sentences said at home in one language (95%); the misses were short phrases ("it is") and two sentences for which Google's Arabic recognizer returned nothing. The English readings that Google in Arabic alone lost were followed verse by verse (Haggai 1:1–12, 1 John 2:18–27, 1 John 4:10–20), and the interpreted Ezekiel reading from the sound desk (pastor and interpreter in turn, often within one sentence) was still followed through Ezekiel 37:1–14 in order. A sentence that changes language in the middle keeps one of the two, usually the one with the verse in it. While the words are still coming, they stay in the language shown so far until the other is clearly ahead, so they do not flicker between the two. Running two recognizers means twice as many requests to Google's free service; if Google ever starts refusing, set the listening language to Arabic only. A Google sentence is closed at a pause once 4 seconds have been said; a spoken command ("Next", «اللي بعده») is passed on at the pause right after it instead (on 18 November "Next" had waited about 3 seconds longer than with Soniox).

**Google or Soniox?** The same 5½-minute session of 18 November (English reading of John 3, Arabic, hymn announcements) through both: both followed the English reading to John 3:23. Soniox wrote the English more exactly ("For God so loved", where Google wrote "forgot so loved") and heard the hymn announcements right («نرنم ترنيمة قدوس، ها صوت الملائكة»), where Google's Arabic recognizer three times returned almost nothing and the English nonsense of the other recognizer was kept. Soniox wrote "John" as "Jean" (now understood) and once wrote an Arabic sentence in English letters ("Yarlaw 3:16" for «يلا يوحنا 3 16»). Google is free; Soniox is about 12 cents an hour. With the listening language on Arabic only (or English only), one recognizer is used, as before. For a light install without the 4 GB model, run `Setup.bat -Cloud` (Setup also offers it when there is no NVIDIA card).

For better accuracy choose a paid service in **Settings → Listening → Speech recognition** and paste its key:

| Service | Price | About 10 h a month | Notes |
|---|---|---|---|
| ElevenLabs Scribe Live | $0.30 / hour while listening ($0.22 + $0.08 for the Bible-name hints) | ~$3.00 | the sound streams as it is heard, so the words appear while the pastor is still talking; the most accurate in our tests |
| Soniox (real-time, stt-rt-v6) | about $0.12 / hour while listening ($10 is the least that can be added to an account, and it is not refunded) | ~$1.20 | the sound streams as it is heard and the words appear while the pastor is still talking; Arabic and English, also mixed in one sentence; the Bible names and your hymn titles are given as hints. The fewest word errors on our two sermon clips (7% and 9%), measured on Soniox's own comparison page; not yet run through Arabic Church Assistant with a funded account |
| Deepgram Nova-3 (ar-EG) | $0.26 / hour | ~$2.60 | each sentence is sent when it ends; new accounts get $200 of free credit, which lasts years at this rate |

ElevenLabs and Soniox are paid for every second of listening, pauses included, so stop listening when the sermon is over. Settings shows how many hours were sent this month and about what they cost. If an online service stops answering and the model is installed on this PC, Arabic Church Assistant switches to it by itself.

**Soniox**: create an account at console.soniox.com, add funds (Billing) and make an API key, then choose **Soniox** in Settings → Listening → Speech recognition and paste the key. A sentence is closed where Soniox hears the speaker finish, or at the pause Arabic Church Assistant's own voice detector finds, whichever comes first. A stream is open only while listening (an open stream is charged), a dropped stream is reopened by itself and the sound whose words were not confirmed is sent again, and a refused key or an empty balance is said plainly ("The Soniox account is out of credit…") while the model on this PC takes over if it is installed. `npm run test:engine` has a drill for all of this against a stand-in server.

**Name hints** (Settings → Listening, under the key; on by default): the Bible book names and the hymn titles of your playlist are given to the cloud service as words to expect. Soniox charges about a third of a cent for that list each time listening starts or a command is spoken on the phone; ElevenLabs charges $0.08 an hour more while it is on. In our tests Soniox found every spoken reference without the list (about 30 minutes of its text, from five recordings), so turning it off lost nothing we could measure.

## Display links (OBS, ProPresenter, another PC)

The display also runs as a web page while the app is open:

| Link | Result |
|---|---|
| `http://localhost:5050/display` | The look from Settings |
| `/display?layout=lower&bg=transparent` | Lower third for a livestream overlay |
| `/display?bg=green` | Green screen |
| `/display?en=1` | Arabic and English |
| `/display?video=1` | Also play videos on this screen |

From another PC use this PC's address, shown in the console under *Display links*.

## English on screen

**Settings → English** has every translation in one list, with a search box (initials or name: "NKJV", "living"). KJV, BSB, WEB and ASV are on this PC (free, no internet needed). The ESV needs the church's free ESV key. With a free API.Bible key, every translation that key gives (NIV, NKJV, NLT and about thirty more) is in the list by itself; there is nothing to load. API.Bible's own copies of KJV, BSB, WEB and ASV are left out, as the same text is on this PC. The list of API.Bible translations is kept in `data\apibible-bibles.json` (never the key), so it shows at once and without internet; it is asked for again when it is a week old, when the key changes, or with **Check again**. Picking an online translation tries it straight away (John 3:16), so a key or a plan that does not include it shows up there, not in the middle of a service.

## Troubleshooting

- **"The speech engine isn't installed yet"**: run `Setup.bat`. (It needs the internet, and nothing else on the PC.)
- **"No sound is coming from …"**: the microphone is giving silence. Check that the sound desk is sending to this PC (the feed's fader, mute button and cable). The notice goes away by itself when the sound is back.
- **A verse went up that should not have**: press **Backspace** (Back). If it keeps happening, turn on **Hold**, and afterwards look at the History tab: each row says why it went up.
- **Speech engine problem**: open **Settings → Listening**. The status and the log show what happened, and **Restart the speech engine** starts it again. It also restarts by itself.
- **Nothing is heard**: check that the level bar moves. If the room is noisy, feed the pastor's microphone from the sound desk into this PC; that's more accurate than a microphone in the room. **Settings → Voice sensitivity** adjusts how easily speech is picked up.
- **It's slow** (no NVIDIA graphics card, with "On this PC" chosen): the processor is used instead. A fast processor keeps up; on a slow one, verses appear a few seconds late. **Automatic** uses Google on such a PC.
- **"Google speech runs inside Google Chrome, which isn't on this PC"**: install Chrome from <https://www.google.com/chrome/>, then restart the speech engine (Settings → Listening).
- **A hymn isn't found**: announce it («هنرنم ترنيمة …») and check its playlist is listed in the **🎵 Videos** tab. A hymn that is not in your playlists never plays by itself: its card lists what the song database has.
- **A hymn did not start by itself**: it must be announced as something we are about to sing («خلونا نرنم …», «تعالوا نسبح ونقول …»), and be in your own playlists. The log says how each one was heard: `hymn … (heard “…”; announced | named | said; played by itself | card only)`.

## Folder

```
Arabic Church Assistant.bat   opens the app (the desktop icon does the same)
Setup.bat          one-time setup (safe to run again; repairs what's missing)
settings.json      your settings and API keys (also editable in Notepad)
bin\               the app program (Electron)
electron\          the desktop app: windows, projector, tray
server.js          the local server: console, display, settings, history, YouTube
speech.js          starts the speech engine and keeps it running
engine\            the speech engine (Python): engine.py, asr.py, audio_io.py, the model, the voice detector,
                   live.py and google.html (Google through a hidden Chrome, ElevenLabs Live, Soniox), cloud.py (Deepgram),
                   python\ (the engine's own Python and packages, put there by Setup)
public\            the pages: console, display, settings, phone remote; engine.js (the verse detector, and the rules
                   for what goes on screen by itself)
data\              Bibles, fonts, playlists, plan, phrases.json (set prayers, once changed), history, logs, recordings,
                   chrome-speech (the hidden Chrome's own profile)
test\              npm test (detector, screen rules with real sermon transcripts in fixtures\, YouTube);
                   npm run test:engine (what the speech engine does when things go wrong)
```

Credits: Smith & Van Dyck Arabic Bible (public domain); KJV, BSB, WEB and ASV (public domain). Speech model: Cohere Transcribe Arabic (Apache-2.0). Voice detector: Silero VAD (MIT). ESV® text from the ESV API (Crossway); NIV and NKJV from API.Bible, each used under its terms with your own key.
