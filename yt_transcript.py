import re
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from urllib.parse import urlparse, parse_qs, unquote

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import TextFormatter


def extract_video_id(url_or_id: str) -> str:
    """
    Robustly extract a YouTube video ID (11 chars) from:
    - bare video IDs
    - watch URLs with extra params (t=328s, list=..., feature=..., etc.)
    - youtu.be short links
    - shorts / embed URLs
    - URL-encoded attribution links (e.g. ...u=/watch%3Fv%3DID%26t%3D328s)
    """
    s = (url_or_id or "").strip()

    # Bare video ID
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s

    # Some links are URL-encoded (attribution links etc.)
    decoded = unquote(s)

    for candidate in (s, decoded):
        # URL parsing path
        try:
            p = urlparse(candidate)
        except Exception:
            p = None

        if p and p.netloc:
            host = p.netloc.lower()
            qs = parse_qs(p.query)

            # Standard watch URL: ?v=VIDEOID
            if "v" in qs and qs["v"]:
                vid = qs["v"][0].strip()
                if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
                    return vid

            # youtu.be/VIDEOID
            if "youtu.be" in host:
                vid = p.path.strip("/").split("/")[0]
                if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
                    return vid

            # youtube.com/shorts/VIDEOID or /embed/VIDEOID
            m = re.search(r"/(shorts|embed)/([A-Za-z0-9_-]{11})", p.path)
            if m:
                return m.group(2)

        # Regex fallback (handles lots of messy cases)
        m = re.search(r"(?:v=|/shorts/|/embed/|youtu\.be/)([A-Za-z0-9_-]{11})", candidate)
        if m:
            return m.group(1)

    raise ValueError("Could not extract a YouTube video ID from that input.")


def clean_transcript_text(text: str) -> str:
    """
    Remove common timestamp artifacts if they show up in text output.
    """
    if not text:
        return ""

    lines_out = []
    for line in text.splitlines():
        s = line.strip()

        if not s:
            continue

        # Remove standalone timestamps (mm:ss or hh:mm:ss)
        if re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", s):
            continue

        # Remove standalone "328s" lines
        if re.fullmatch(r"\d+\s*s", s, flags=re.IGNORECASE):
            continue

        # Remove leading timestamps like "0:03  hello" or "328s hello"
        s = re.sub(
            r"^\s*(\d{1,2}:\d{2}(?::\d{2})?|\d+\s*s)\s+",
            "",
            s,
            flags=re.IGNORECASE,
        ).strip()

        if s:
            lines_out.append(s)

    cleaned = "\n".join(lines_out)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("YouTube Transcript Fetcher (Local)")
        self.geometry("900x650")

        self.available_langs = []

        # --- v1.x API: instantiate the client once ---
        self.api = YouTubeTranscriptApi()

        self._build_ui()

    def _build_ui(self):
        pad = {"padx": 10, "pady": 8}

        top = ttk.Frame(self)
        top.pack(fill="x", **pad)

        ttk.Label(top, text="YouTube URL or Video ID:").pack(anchor="w")

        row = ttk.Frame(top)
        row.pack(fill="x", pady=6)

        self.url_var = tk.StringVar()
        self.url_entry = ttk.Entry(row, textvariable=self.url_var)
        self.url_entry.pack(side="left", fill="x", expand=True)

        self.fetch_btn = ttk.Button(row, text="Get Transcript", command=self.fetch_transcript)
        self.fetch_btn.pack(side="left", padx=(8, 0))

        lang_row = ttk.Frame(top)
        lang_row.pack(fill="x")

        ttk.Label(lang_row, text="Language:").pack(side="left")

        self.lang_var = tk.StringVar(value="(auto)")
        self.lang_combo = ttk.Combobox(lang_row, textvariable=self.lang_var, state="readonly", width=18)
        self.lang_combo["values"] = ["(auto)"]
        self.lang_combo.current(0)
        self.lang_combo.pack(side="left", padx=(8, 0))

        self.refresh_langs_btn = ttk.Button(lang_row, text="Detect Languages", command=self.detect_languages)
        self.refresh_langs_btn.pack(side="left", padx=(8, 0))

        action_row = ttk.Frame(top)
        action_row.pack(fill="x", pady=(6, 0))

        self.copy_btn = ttk.Button(action_row, text="Copy", command=self.copy_to_clipboard, state="disabled")
        self.copy_btn.pack(side="left")

        self.save_btn = ttk.Button(action_row, text="Save .txt", command=self.save_to_file, state="disabled")
        self.save_btn.pack(side="left", padx=(8, 0))

        self.clear_btn = ttk.Button(action_row, text="Clear", command=self.clear_output)
        self.clear_btn.pack(side="left", padx=(8, 0))

        out_frame = ttk.Frame(self)
        out_frame.pack(fill="both", expand=True, **pad)

        ttk.Label(out_frame, text="Transcript Output:").pack(anchor="w")

        text_frame = ttk.Frame(out_frame)
        text_frame.pack(fill="both", expand=True)

        self.output = tk.Text(text_frame, wrap="word", undo=True)
        self.output.pack(side="left", fill="both", expand=True)

        scroll = ttk.Scrollbar(text_frame, orient="vertical", command=self.output.yview)
        scroll.pack(side="right", fill="y")
        self.output.configure(yscrollcommand=scroll.set)

        self.status_var = tk.StringVar(value="Ready.")
        status = ttk.Label(self, textvariable=self.status_var, anchor="w")
        status.pack(fill="x", padx=10, pady=(0, 8))

    def set_status(self, msg: str):
        self.status_var.set(msg)
        self.update_idletasks()

    def clear_output(self):
        self.output.delete("1.0", "end")
        self.copy_btn.configure(state="disabled")
        self.save_btn.configure(state="disabled")
        self.set_status("Cleared.")

    def copy_to_clipboard(self):
        text = self.output.get("1.0", "end-1c").strip()
        if not text:
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        self.set_status("Copied to clipboard.")

    def save_to_file(self):
        text = self.output.get("1.0", "end-1c").strip()
        if not text:
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Text Files", "*.txt")],
            title="Save transcript as...",
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        self.set_status(f"Saved: {path}")

    def detect_languages(self):
        try:
            video_id = extract_video_id(self.url_var.get())
        except ValueError as e:
            messagebox.showerror("Invalid Input", str(e))
            return

        try:
            self.set_status("Detecting available transcript languages...")
            # v1.x: instance method .list() instead of class method .list_transcripts()
            tl = self.api.list(video_id)

            # Deduplicate while preserving order
            langcodes = []
            seen = set()
            for t in tl:
                lc = t.language_code
                if lc not in seen:
                    langcodes.append(lc)
                    seen.add(lc)

            self.available_langs = langcodes
            values = ["(auto)"] + langcodes
            self.lang_combo["values"] = values
            self.lang_combo.current(0)

            if langcodes:
                self.set_status(f"Detected languages: {', '.join(langcodes)}")
            else:
                self.set_status("No transcript languages detected (captions may be disabled).")
        except Exception as e:
            messagebox.showerror("Error", f"Could not detect languages.\n\n{e}")
            self.set_status("Language detection failed.")

    def fetch_transcript(self):
        self.fetch_btn.configure(state="disabled")
        self.set_status("Fetching transcript...")

        try:
            video_id = extract_video_id(self.url_var.get())
            chosen_lang = self.lang_var.get()

            if chosen_lang == "(auto)":
                # Prefer manually created English, then auto English, then first available
                # v1.x: instance method .list() instead of class method .list_transcripts()
                tl = self.api.list(video_id)

                manual_english = None
                auto_english = None
                first_any = None

                for t in tl:
                    if first_any is None:
                        first_any = t
                    if t.language_code in ("en", "en-US", "en-GB"):
                        if t.is_generated:
                            auto_english = auto_english or t
                        else:
                            manual_english = manual_english or t

                target = manual_english or auto_english or first_any
                if target is None:
                    raise RuntimeError("No transcripts available for this video.")

                transcript = target.fetch()
            else:
                # v1.x: instance method .fetch() instead of class method .get_transcript()
                transcript = self.api.fetch(video_id, languages=[chosen_lang])

            formatter = TextFormatter()
            text = formatter.format_transcript(transcript).strip()
            text = clean_transcript_text(text)

            self.output.delete("1.0", "end")
            self.output.insert("1.0", text)

            self.copy_btn.configure(state="normal")
            self.save_btn.configure(state="normal")
            self.set_status("Done.")
        except Exception as e:
            messagebox.showerror("Error", str(e))
            self.set_status("Failed to fetch transcript.")
        finally:
            self.fetch_btn.configure(state="normal")


if __name__ == "__main__":
    app = App()
    app.mainloop()
