# YouTube Transcript Saver (Edge Extension)

This repo includes a Microsoft Edge / Chromium extension that adapts the `yt_transcript.py` workflow to run locally in the browser.

## What it does

- Uses the active YouTube tab.
- Detects available caption languages.
- Language selection behavior:
  - `(auto)` (default):
    1. Manual English (`en`, `en-US`, `en-GB`)
    2. Auto-generated English
    3. First available track
  - Or choose a specific detected language in the popup.
- Downloads transcript as a plain `.txt` file named after the video title.

## Load in Edge

1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder (`youtube-transcript`)

## Use

1. Open a YouTube video page.
2. Click the extension icon.
3. (Optional) Click **Detect** to refresh transcript languages.
4. Choose language or keep `(auto)`.
5. Click **Save Transcript as .txt** and choose where to save.

## Files

- `manifest.json` – Extension manifest (MV3)
- `popup.html` / `popup.css` – Popup UI
- `popup.js` – Transcript detection, extraction, and download logic
- `yt_transcript.py` – Original local Python script (reference)

## Troubleshooting

If you see `No transcript tracks found` on a video that clearly has captions:

- Reload the YouTube tab and reopen the extension popup.
- Click **Detect** to force refresh track discovery.
- Open the extension service worker console (`edge://extensions` → this extension → **service worker**) and page DevTools console to inspect `[yt-transcript] caption track discovery` logs.

The extension now reads player data from the page `MAIN` world, which fixes cases where caption tracks were hidden from isolated extension scripts.
