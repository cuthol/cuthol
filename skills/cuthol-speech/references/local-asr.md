# Local (keyless) speech recognition: the contract

`speech.transcribe(handle, provider="local")` uses the first of these that applies:

1. **Sidecar transcript:** a file `<media file>.transcript.json` next to the source media (the library file Cuthol reads). Loaded as is; nothing runs.
2. **Your own command:** environment variable `CUTHOL_LOCAL_ASR_CMD` (a shell command line).
3. **The installed engine:** `cuthol setup --local-speech --apply` installs a private faster-whisper + Piper environment (no API key). Without it (and without 1 and 2) you get `CUTHOL-G237` with the install command.

## JSON shape (sidecar file and your command's stdout)

```json
{
  "language": "en",
  "text": "optional full text",
  "words": [
    { "word": "Hello", "punctuated_word": "Hello,", "source_start_ms": 0, "source_end_ms": 420, "confidence": 0.97 }
  ]
}
```

- `words` is required (an array); every other field is optional.
- `source_start_ms` / `source_end_ms` are milliseconds from the start of the **source media file** (not the timeline). Non-numbers fall back to 0 / 100.
- `punctuated_word` defaults to `word`; captions show it. `confidence` defaults to 0.99.
- `language` (lower-case code). Without it Cuthol uses the `lang` you passed; with `lang="auto"` and no language in the JSON, it asks you for an explicit `lang`.

## Your command (`CUTHOL_LOCAL_ASR_CMD`)

- Cuthol runs `<your command> "<audio file>"` through the shell; the audio path is also in `CUTHOL_LOCAL_ASR_AUDIO_FILE`.
- Print the JSON above on stdout, exit 0. A non-zero exit or invalid JSON is an error that quotes your stderr.
- Example wrapper (Python, any ASR that gives word times):

```python
import json, sys
from faster_whisper import WhisperModel
segs, info = WhisperModel("small", compute_type="int8").transcribe(sys.argv[1], word_timestamps=True)
words = [{"word": w.word.strip(), "source_start_ms": int(w.start * 1000), "source_end_ms": int(w.end * 1000),
          "confidence": w.probability} for s in segs for w in (s.words or []) if w.word.strip()]
print(json.dumps({"language": info.language, "words": words}))
```

## What Cuthol does with the words (all three paths)

- **Fillers** are marked by token: English `uh, um, umm, er, ah, hmm`; Turkish `ıı, ııı, ee, eee`. Turkish discourse words (`şey, yani, hani, acaba`) count as fillers only when pauses isolate them on both sides. Your ASR must **write** the fillers for cleanup to find them (many models drop them).
- **Repetitions** (immediate repeated words) and **pauses** (gaps between words) are computed from the times; `speech.cleanup` offers them as candidates.
- Captions hide filler words.

## The installed engine (path 3)

- faster-whisper `small`, int8 on CPU, word timestamps; audio is cut at silent valleys into chunks, each chunk gets a filler-writing prompt in its language, chunks run in parallel worker processes (`CUTHOL_LOCAL_ASR_JOBS`, default 2; `CUTHOL_LOCAL_ASR_THREADS` per worker, default 3).
- Same input, same output: decoding is seeded per chunk.
- Segments that look invented (high no-speech probability with low confidence, or looping text) are dropped and listed in the transcript as `local_dropped_segments` (time ranges + reason).
- Numbers split by the model (`30` + `,000`) are joined back (`30,000`).
- Speed on a 6-core CPU: roughly 0.2–0.3× real time (a 25-minute talk takes 5–7 minutes).
