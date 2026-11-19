# Arabic Church Assistant for Mac

The Mac version is its own download (its own release on GitHub), so nobody downloads the other computer's files. The
code is the same as the Windows version's; only what is around it differs (a Mac app instead of a Windows folder).

## What works on a Mac

- Listening with **Google** (free; needs Google Chrome on the Mac) or with **ElevenLabs**, **Soniox** or **Deepgram**
  (paid, with the church's own key).
- Everything else: the display on the projector, the phone remote, OBS and displays on other computers, the Bibles and
  hymns, Back and Hold, the history of each service.
- Not on a Mac yet: **On this PC** (the speech model on the computer needs an NVIDIA graphics card), and listening to
  the Mac's own sound (a Mac can't without extra software).

It needs macOS 14 or newer on a Mac with an Apple chip (M1 and newer), or macOS 13 or newer on an Intel Mac.
Settings, history, logs and recordings are kept in `~/Library/Application Support/Arabic Church Assistant/data`.

## Build it (on a Mac, about 10 minutes, with internet)

1. Xcode, or only its command line tools: `xcode-select --install`.
2. This folder on the Mac: `git clone https://github.com/SamehFaragallah/arabic-church-assistant.git`, or a copy of it.
3. In Terminal, in the folder:

   ```
   bash macos/build.sh arm64
   ```

   The zip is in `dist/`: `Arabic-Church-Assistant-<version>-Mac-AppleSilicon.zip`. For Intel Macs: `bash macos/build.sh x64`
   (on a Mac with an Apple chip this needs Rosetta: `softwareupdate --install-rosetta`).

## Signed with your Developer ID and notarized: no warnings on any Mac

With an Apple Developer account, once:

1. A **Developer ID Application** certificate in the Mac's keychain: Xcode → Settings → Accounts → your team →
   Manage Certificates → **+** → Developer ID Application. Its full name is shown by
   `security find-identity -v -p codesigning`.
2. Let the Mac send the app to Apple to be notarized: make an app-specific password at account.apple.com
   (Sign-In and Security → App-Specific Passwords), then run the line below. It asks for that password and keeps it
   in the Mac's keychain, under the name ACA.

   ```
   xcrun notarytool store-credentials ACA --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID
   ```

Then, for each new version:

```
MAC_SIGN_ID="Developer ID Application: Your Name (YOUR_TEAM_ID)" MAC_NOTARY_PROFILE=ACA bash macos/build.sh arm64
MAC_SIGN_ID="Developer ID Application: Your Name (YOUR_TEAM_ID)" MAC_NOTARY_PROFILE=ACA bash macos/build.sh x64
```

Without `MAC_SIGN_ID` the app is signed "ad hoc": it works, but the first time each Mac says it can't check who made it.
Then: System Settings → Privacy & Security → **Open Anyway** (or, in Terminal,
`xattr -cr "/Applications/Arabic Church Assistant.app"`).

## Try it before it goes on GitHub

1. Double-click the zip, drag **Arabic Church Assistant** into **Applications**, open it.
2. Allow the microphone when the Mac asks.
3. Settings → Listening: **Google**, and the microphone.
4. Start listening and say "John 3:16": the verse comes up.
5. Quit (⌘Q). Activity Monitor should then show no `python3` and no Chrome started by the app.

Then put the zips on the Mac release on GitHub (its own release, not the Windows one).
