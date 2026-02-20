const saveBtn = document.getElementById("saveBtn");
const detectBtn = document.getElementById("detectBtn");
const languageSelect = document.getElementById("languageSelect");
const statusEl = document.getElementById("status");

let cachedVideoData = null;
let cachedTabUrl = null;

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

function decodeHtml(text) {
  const temp = document.createElement("textarea");
  temp.innerHTML = text || "";
  return temp.value;
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
    world: "MAIN",
    func: () => {
      const response =
        window.ytInitialPlayerResponse ||
        window.ytcfg?.data_?.PLAYER_RESPONSE ||
        window.ytcfg?.get?.("PLAYER_RESPONSE");
      const details = response?.videoDetails || {};
      const tracklist = response?.captions?.playerCaptionsTracklistRenderer;
      const tracks = tracklist?.captionTracks || [];

      console.debug("[yt-transcript] caption track discovery", {
        hasInitialPlayerResponse: !!window.ytInitialPlayerResponse,
        hasYtcfgPlayerResponse: !!window.ytcfg?.data_?.PLAYER_RESPONSE || !!window.ytcfg?.get?.("PLAYER_RESPONSE"),
        trackCount: tracks.length,
        href: location.href
      });

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

function forceFmtUrl(baseUrl, fmt) {
  const u = new URL(baseUrl);
  u.searchParams.set("fmt", fmt);
  return u.toString();
}

function textFromJsonEvents(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const lines = events
    .flatMap((event) => event?.segs || [])
    .map((seg) => decodeHtml((seg?.utf8 || "").replace(/\s+/g, " ").trim()))
    .filter(Boolean);
  return cleanTranscriptText(lines.join("\n"));
}

function textFromXml(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) return "";

  const textNodes = [...doc.getElementsByTagName("text")];
  const paragraphNodes = [...doc.getElementsByTagName("p")];
  const nodes = textNodes.length ? textNodes : paragraphNodes;
  if (!nodes.length) return "";

  const text = nodes
    .map((node) => decodeHtml((node.textContent || "").replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .join("\n");

  return cleanTranscriptText(text);
}

function textFromVtt(vtt) {
  const lines = vtt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("WEBVTT") && !line.includes("-->") && !/^\d+$/.test(line));
  return cleanTranscriptText(lines.join("\n"));
}

function transcriptPayloadToText(payload) {
  const raw = (payload || "").trim();
  if (!raw) return "";

  const jsonCandidate = raw.replace(/^\)\]\}'\s*/, "");
  if (jsonCandidate.startsWith("{") || jsonCandidate.startsWith("[")) {
    try {
      return textFromJsonEvents(JSON.parse(jsonCandidate));
    } catch {
      // Continue into other parsers.
    }
  }

  if (raw.startsWith("WEBVTT")) {
    return textFromVtt(raw);
  }

  if (raw.startsWith("<")) {
    return textFromXml(raw);
  }

  return "";
}

async function fetchTranscriptPayloadFromTab(tabId, url) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url],
    func: async (targetUrl) => {
      const response = await fetch(targetUrl, { credentials: "include" });
      const payload = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        payload,
        url: targetUrl
      };
    }
  });

  if (!result) throw new Error("Failed to fetch transcript payload from YouTube page context.");
  return result;
}

async function getTranscriptTextFromTrack(tabId, track) {
  const attempts = [
    track.baseUrl,
    forceFmtUrl(track.baseUrl, "json3"),
    forceFmtUrl(track.baseUrl, "vtt"),
    forceFmtUrl(track.baseUrl, "srv3")
  ];

  for (const url of attempts) {
    const res = await fetchTranscriptPayloadFromTab(tabId, url);
    console.debug("[yt-transcript] transcript fetch", {
      status: res.status,
      ok: res.ok,
      contentType: res.contentType,
      length: res.payload?.length || 0,
      url,
      head: (res.payload || "").slice(0, 80)
    });

    if (!res.ok || !res.payload) {
      continue;
    }

    const text = transcriptPayloadToText(res.payload);
    if (text) {
      return text;
    }
  }

  throw new Error(
    "Transcript payload could not be parsed. Open console and check '[yt-transcript] transcript fetch' logs for blocked/empty responses."
  );
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
  cachedTabUrl = tab.url;
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
  if (!cachedVideoData || cachedTabUrl !== tab.url) {
    cachedVideoData = await readVideoDataFromTab(tab.id);
    cachedTabUrl = tab.url;
    populateLanguageOptions(cachedVideoData.tracks);
  }

  const selectedLanguage = languageSelect.value;
  const chosenTrack = pickTrack(cachedVideoData.tracks, selectedLanguage);
  const transcriptText = await getTranscriptTextFromTrack(tab.id, chosenTrack);

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
