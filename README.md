# YouTube Transcript Saver (Edge Extension)

This repo now includes a Microsoft Edge/Chromium extension that recreates the transcript workflow from `yt_transcript.py` in-browser.

## What it does

- Uses the active YouTube tab.
- Reads available caption tracks from the page.
- Chooses transcript in this order:
  1. Manual English (`en`, `en-US`, `en-GB`)
  2. Auto-generated English
  3. First available track
- Downloads transcript as a `.txt` file named after the video title.

## Load in Edge

1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder (`youtube-transcript`)

## Use

1. Open a YouTube video page.
2. Click the extension icon.
3. Click **Save Transcript as .txt**.
4. Choose where to save the file.

## Files

- `manifest.json` – Extension manifest (MV3)
- `popup.html` / `popup.css` – Popup UI
- `popup.js` – Transcript extraction + download logic
- `yt_transcript.py` – Original local Python script (reference)
