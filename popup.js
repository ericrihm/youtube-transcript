const saveBtn = document.getElementById("saveBtn");
const detectBtn = document.getElementById("detectBtn");
const languageSelect = document.getElementById("languageSelect");
const statusEl = document.getElementById("status");

let cachedVideoData = null;

function setStatus(message) {
  statusEl.textContent = message;
}

function sanitizeFileName(title) {
  const base = (title || "youtube-transcript").trim();
  return (
    base
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 140)
      .trim() || "youtube-transcript"
  );
}

function cleanTranscriptText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getActiveYoutubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url) throw new Error("No active tab found.");

  const url = new URL(tab.url);
  const validHosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"]);
  if (!validHosts.has(url.hostname)) throw new Error("Active tab is not a YouTube page.");

  return tab;
}

async function readVideoDataFromTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const response = window.ytInitialPlayerResponse;
      const details = response?.videoDetails || {};
      const tracklist = response?.captions?.playerCaptionsTracklistRenderer;
      const tracks = tracklist?.captionTracks || [];

      return {
        title: details.title || document.title.replace(/\s*-\s*YouTube\s*$/i, ""),
        tracks: tracks.map((track) => ({
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          languageName:
            track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || track.languageCode,
          isGenerated: !!track.kind
        }))
      };
    }
  });

  if (!result) throw new Error("Unable to read metadata from this page.");
  return result;
}

function populateLanguageOptions(tracks) {
  languageSelect.innerHTML = "";

  const autoOption = document.createElement("option");
  autoOption.value = "auto";
  autoOption.textContent = "(auto)";
  languageSelect.appendChild(autoOption);

  const seen = new Set();
  for (const track of tracks) {
    if (!track.languageCode || seen.has(track.languageCode)) continue;
    seen.add(track.languageCode);

    const option = document.createElement("option");
    option.value = track.languageCode;
    option.textContent = `${track.languageName} (${track.languageCode})`;
    languageSelect.appendChild(option);
  }

  languageSelect.disabled = tracks.length === 0;
}

function pickTrack(tracks, selection) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error("No transcript tracks found (captions may be disabled for this video).");
  }

  if (selection && selection !== "auto") {
    const exact = tracks.find((track) => track.languageCode === selection);
    if (exact) return exact;
    throw new Error(`Language '${selection}' is no longer available.`);
  }

  const isEnglish = (track) => ["en", "en-US", "en-GB"].includes(track.languageCode);
  const manualEnglish = tracks.find((track) => isEnglish(track) && !track.isGenerated);
  const autoEnglish = tracks.find((track) => isEnglish(track) && track.isGenerated);

  return manualEnglish || autoEnglish || tracks[0];
}

function transcriptXmlToPlainText(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Transcript response was not valid XML.");

  const entries = [...doc.getElementsByTagName("text")];
  if (!entries.length) throw new Error("Transcript response was empty.");

  const text = entries
    .map((node) => {
      const temp = document.createElement("textarea");
      temp.innerHTML = node.textContent || "";
      return temp.value.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean)
    .join("\n");

  const cleaned = cleanTranscriptText(text);
  if (!cleaned) throw new Error("Transcript contains no text lines.");
  return cleaned;
}

async function downloadTranscript(title, text) {
  const blob = new Blob([`${text}\n`], { type: "text/plain" });
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

async function detectLanguages() {
  setStatus("Detecting available transcript languages...");
  const tab = await getActiveYoutubeTab();
  const videoData = await readVideoDataFromTab(tab.id);

  cachedVideoData = videoData;
  populateLanguageOptions(videoData.tracks);

  if (videoData.tracks.length === 0) {
    setStatus("No transcript languages detected.");
    return;
  }

  const languageCodes = [...new Set(videoData.tracks.map((track) => track.languageCode))];
  setStatus(`Detected languages: ${languageCodes.join(", ")}`);
}

async function saveTranscript() {
  setStatus("Fetching transcript...");

  const tab = await getActiveYoutubeTab();
  if (!cachedVideoData) {
    cachedVideoData = await readVideoDataFromTab(tab.id);
    populateLanguageOptions(cachedVideoData.tracks);
  }

  const selectedLanguage = languageSelect.value;
  const chosenTrack = pickTrack(cachedVideoData.tracks, selectedLanguage);

  const response = await fetch(chosenTrack.baseUrl);
  if (!response.ok) {
    throw new Error(`Transcript request failed: ${response.status}`);
  }

  const xml = await response.text();
  const transcriptText = transcriptXmlToPlainText(xml);

  await downloadTranscript(cachedVideoData.title, transcriptText);
  setStatus(`Saved transcript for "${cachedVideoData.title}".`);
}

async function withUiLock(action) {
  saveBtn.disabled = true;
  detectBtn.disabled = true;

  try {
    await action();
  } catch (error) {
    setStatus(error?.message || "Something went wrong.");
  } finally {
    saveBtn.disabled = false;
    detectBtn.disabled = false;
  }
}

detectBtn.addEventListener("click", () => withUiLock(detectLanguages));
saveBtn.addEventListener("click", () => withUiLock(saveTranscript));

withUiLock(detectLanguages);
