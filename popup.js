const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

function setStatus(message) {
  statusEl.textContent = message;
}

function sanitizeFileName(title) {
  const base = (title || "youtube-transcript").trim();
  return base
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 140)
    .trim() || "youtube-transcript";
}

function decodeHtml(str) {
  if (!str) return "";
  const parser = new DOMParser();
  return parser.parseFromString(str, "text/html").documentElement.textContent || "";
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function getActiveYoutubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) throw new Error("No active tab found.");
  const url = new URL(tab.url);
  const isYouTube = ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname);
  if (!isYouTube) throw new Error("Active tab is not a YouTube page.");
  return tab;
}

async function extractVideoData(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const response = window.ytInitialPlayerResponse;
      const details = response?.videoDetails || {};
      const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      return {
        title: details.title || document.title.replace(/\s*-\s*YouTube\s*$/i, ""),
        tracks: tracks.map((t) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join("") || t.languageCode,
          isGenerated: !!t.kind
        }))
      };
    }
  });

  if (!result) throw new Error("Unable to read video metadata from page.");
  return result;
}

function chooseTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error("No transcript tracks found (captions may be disabled for this video).");
  }

  const englishManual = tracks.find((t) => ["en", "en-US", "en-GB"].includes(t.languageCode) && !t.isGenerated);
  const englishAuto = tracks.find((t) => ["en", "en-US", "en-GB"].includes(t.languageCode) && t.isGenerated);
  return englishManual || englishAuto || tracks[0];
}

function transcriptXmlToText(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const entries = [...doc.getElementsByTagName("text")];

  if (!entries.length) {
    throw new Error("Transcript response was empty.");
  }

  const lines = entries
    .map((node) => {
      const start = Number(node.getAttribute("start") || "0");
      const raw = decodeHtml(node.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw) return null;
      return `[${formatTimestamp(start)}] ${raw}`;
    })
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("Transcript contains no text lines.");
  }

  return lines.join("\n");
}

async function downloadTranscript(title, text) {
  const blob = new Blob([text + "\n"], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `${sanitizeFileName(title)}.txt`,
      saveAs: true
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  setStatus("Collecting video metadata...");

  try {
    const tab = await getActiveYoutubeTab();
    const { title, tracks } = await extractVideoData(tab.id);
    const track = chooseTrack(tracks);

    setStatus(`Fetching transcript (${track.languageCode})...`);
    const response = await fetch(track.baseUrl);
    if (!response.ok) {
      throw new Error(`Transcript request failed: ${response.status}`);
    }

    const xml = await response.text();
    const transcript = transcriptXmlToText(xml);
    await downloadTranscript(title, transcript);
    setStatus(`Saved transcript for "${title}".`);
  } catch (error) {
    setStatus(error?.message || "Failed to save transcript.");
  } finally {
    saveBtn.disabled = false;
  }
});
