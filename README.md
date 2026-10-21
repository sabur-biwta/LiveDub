# Live Dub for Android

Watch YouTube videos with a Bangla voice-over that follows the video.

- Paste a YouTube link (or share a video from the YouTube app to **Live Dub**).
- The video plays in YouTube's own player; Bangla is spoken sentence by sentence in step with it.
- Translation: Google Translate (free) or your own AI key (Gemini, ChatGPT, Claude, ...).
- Voice: the phone's own text-to-speech (free, offline, no limits), with separate male and female voices.

## Building the app (done automatically by GitHub)

Every upload to this repository starts the **Build Live Dub APK** workflow (Actions tab).
After about 5 minutes the APK is available under **Releases -> latest -> LiveDub.apk**.

## First run on the phone

1. Install LiveDub.apk (allow "Install unknown apps" for your browser when Android asks).
2. Open Live Dub -> Settings -> Playback:
   - Voice: Phone voice. If no Bangla voice is listed, tap **Install Bangla voice** and download
     Bangla (Bangladesh) in Google's speech engine, then reopen Settings.
   - Use **Test male** / **Test female** to choose voices.
3. Optional: under AI translators add Gemini with your API key for better Bangla.

## Notes

- Videos need captions (YouTube's automatic captions are enough). Shorts and live streams are not supported.
- Ads may play because the app is not signed in to YouTube; the voice pauses during ads.
- The signing key (app/livedub.keystore) is only for this personal app, so updates install over the old version.
