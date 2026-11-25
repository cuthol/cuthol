#!/usr/bin/env python3
"""Keyless local speech bridge for Cuthol (faster-whisper ASR + Piper TTS).

Shipped inside the npm package (`scripts/local_speech.py`) and driven by
`src/speech/local_engine.ts`; never hand-wire this in a shell.

Subcommands:
  asr <audio> --lang <code|auto> --model <dir|id> [--keyterms a,b]
    Decode <audio> with ffmpeg to 16 kHz mono s16le, transcribe with
    faster-whisper (deterministic: condition_on_previous_text=False, fixed
    beam_size, int8 CPU) and print the JSON the local provider parses:
    {"language": ..., "words": [{word, punctuated_word, source_start_ms,
    source_end_ms, confidence}]}.
  tts --text-file <utf8 file> --voice <onnx path|id> --out <wav>
    [plus --voices-dir and --piper-exe overrides]
    Synthesize with the Piper binary and print
    {"duration_ms": ..., "words": []} (Piper exposes no word timings, so
    Cuthol falls back to its proportional estimate).

Notes:
  - Audio is decoded by the ffmpeg binary (the bundled PyAV build rejects
    `av.open(..., metadata_errors=...)` in this version), never by PyAV.
  - The text file is always read as UTF-8 here, so Windows console code
    pages (cp1252 mangling "g", "u" etc.) cannot corrupt the input.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Cache-busting revision of the chunked local ASR engine (see
# `LOCAL_ASR_ENGINE_REVISION` in `src/speech/transcribe.ts`).
LOCAL_ASR_ENGINE_REVISION = "v5"

# Fixed decode seed: the faster-whisper default temperature fallback list
# re-decodes bad windows, so the RNG must be seeded for repeat runs.
# Set per chunk (not per file) so results do not depend on worker order.
LOCAL_ASR_DECODE_SEED = 20261121

# Hallucinated-segment drop thresholds: the same defaults faster-whisper
# itself uses to trigger its temperature fallback (no tuning to any talk).
# A segment is dropped when it is likely not speech (high no-speech
# probability while the average log-probability is low) or when the output
# is looping (compression ratio above threshold).
SEGMENT_NO_SPEECH_PROB_THRESHOLD = 0.6
SEGMENT_AVG_LOGPROB_THRESHOLD = -1.0
SEGMENT_COMPRESSION_RATIO_THRESHOLD = 2.4


def should_drop_segment(no_speech_prob, avg_logprob, compression_ratio):
    """Pure predicate: True when a decoded segment is likely hallucinated.

    Drops segments that are likely not speech (no_speech_prob above
    threshold while avg_logprob is low) or looping output (compression
    ratio above threshold). Thresholds are the faster-whisper defaults.
    """
    try:
        no_speech = float(no_speech_prob)
    except (TypeError, ValueError):
        no_speech = 0.0
    try:
        logprob = float(avg_logprob)
    except (TypeError, ValueError):
        logprob = 0.0
    try:
        ratio = float(compression_ratio)
    except (TypeError, ValueError):
        ratio = 0.0
    if no_speech > SEGMENT_NO_SPEECH_PROB_THRESHOLD and logprob < SEGMENT_AVG_LOGPROB_THRESHOLD:
        return True
    if ratio > SEGMENT_COMPRESSION_RATIO_THRESHOLD:
        return True
    return False

# Per-chunk initial prompts. Every chunk gets its own prompt (faster-whisper
# only applies `initial_prompt` to the first ~30 s window, so a whole-file
# prompt never reaches later minutes). Keyterms are prepended when given.
FILLER_PROMPTS = {
    "en": "Um, uh, er, ah, umm, hmm. This is a spoken talk with hesitations, um, and, uh, filled pauses.",
    "tr": "Iı, ee, şey, yani, hani. Bu konuşma içeriyor, ıı, duraksamalar ve, ee, dolgu sesleri.",
    "neutral": "Um, uh, er, ah, umm, hmm. Iı, ee, şey, yani, hani. Spoken talk with hesitations and filled pauses.",
}

# Longest audio slice transcribed in one model call. Shorter than
# faster-whisper's 30 s window so each slice gets the full prompt context.
MAX_CHUNK_S = 28.0
MIN_CHUNK_S = 8.0
# A silence run must last this long to host a chunk boundary.
MIN_SILENCE_S = 0.25
# Frame RMS below this counts as silence (16 kHz float mono PCM).
SILENCE_RMS_THRESH = 0.02
FRAME_S = 0.02


def filler_prompt_for(lang, keyterms=()):
    """Language-aware initial prompt (en/tr/neutral for auto-or-unknown)."""
    base = FILLER_PROMPTS.get((lang or "auto").lower(), FILLER_PROMPTS["neutral"])
    keys = " ".join(k for k in (keyterms or []) if k).strip()
    if keys:
        return keys + ". " + base
    return base


def plan_chunks(pcm_len, rms, sr=16000):
    """Split sample indices into chunks at silence-valley midpoints.

    Pure function of the per-frame RMS envelope (no model): deterministic,
    unit-testable. Returns a list of (start_sample, end_sample); every
    chunk is at most MAX_CHUNK_S long and boundaries sit inside silence
    runs of at least MIN_SILENCE_S where one exists.
    """
    import numpy as np

    rms = np.asarray(rms, dtype=np.float64)
    frame_len = max(1, int(sr * FRAME_S))
    total_s = pcm_len / float(sr)
    if total_s <= MAX_CHUNK_S:
        return [(0, pcm_len)]
    silent = rms < SILENCE_RMS_THRESH
    min_run = max(1, int(round(MIN_SILENCE_S / FRAME_S)))
    # Midpoints (in samples) of every long-enough silence run.
    valleys = []
    i = 0
    n = len(silent)
    while i < n:
        if silent[i]:
            j = i
            while j < n and silent[j]:
                j += 1
            if j - i >= min_run:
                valleys.append(int(((i + j) // 2) * frame_len))
            i = j
        else:
            i += 1
    max_len = int(MAX_CHUNK_S * sr)
    min_len = int(MIN_CHUNK_S * sr)
    chunks = []
    start = 0
    while pcm_len - start > max_len:
        limit = start + max_len
        earliest = start + min_len
        cands = [v for v in valleys if earliest <= v <= limit]
        cut = max(cands) if cands else limit
        chunks.append((start, cut))
        start = cut
    chunks.append((start, pcm_len))
    return chunks


def frame_rms(pcm, sr=16000):
    """20 ms frame RMS envelope of 16 kHz float mono PCM."""
    import numpy as np

    frame_len = max(1, int(sr * FRAME_S))
    trimmed = pcm[: (len(pcm) // frame_len) * frame_len]
    if len(trimmed) == 0:
        return np.zeros(0, dtype=np.float64)
    return np.sqrt((trimmed.reshape(-1, frame_len).astype(np.float64) ** 2).mean(axis=1))


def decode_audio_16k_mono(path):
    """Decode any audio file to 16 kHz mono s16le via the ffmpeg binary."""
    import numpy as np

    ffmpeg = shutil.which("ffmpeg") or os.environ.get("FFMPEG_EXE", "ffmpeg")
    tmp = tempfile.NamedTemporaryFile(suffix=".raw", delete=False)
    tmp.close()
    try:
        subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", path,
             "-ac", "1", "-ar", "16000", "-f", "s16le", tmp.name],
            check=True,
        )
        with open(tmp.name, "rb") as f:
            raw = f.read()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe_chunk(pcm_slice, model, lang, initial_prompt, hotwords, beam_size=5):
    """Transcribe one PCM slice; word times are slice-relative seconds.

    Decoding uses faster-whisper's default temperature
    fallback list; the RNG is seeded per chunk (`LOCAL_ASR_DECODE_SEED`) so repeated runs decode identically. Segments that look
    hallucinated are dropped (see `should_drop_segment`); the drop count
    and time ranges are returned next to the words, never silently.
    Returns (words, dropped_segments) where each dropped entry carries
    the slice-relative start/end seconds and the reason.
    """
    try:
        import ctranslate2

        ctranslate2.set_random_seed(LOCAL_ASR_DECODE_SEED)
    except Exception:
        pass
    words = []
    dropped = []
    segments, _info = model.transcribe(
        pcm_slice,
        language=lang,
        word_timestamps=True,
        vad_filter=False,
        hotwords=hotwords,
        initial_prompt=initial_prompt,
        condition_on_previous_text=False,
        beam_size=beam_size,
        # No temperature argument: faster-whisper default fallback list.
    )
    for seg in segments:
        if should_drop_segment(
            getattr(seg, "no_speech_prob", 0.0),
            getattr(seg, "avg_logprob", 0.0),
            getattr(seg, "compression_ratio", 0.0),
        ):
            dropped.append({
                "start": float(seg.start),
                "end": float(seg.end),
                "reason": "not_speech" if float(getattr(seg, "no_speech_prob", 0.0) or 0.0) > SEGMENT_NO_SPEECH_PROB_THRESHOLD else "looping",
            })
            continue
        for w in seg.words or []:
            text = (w.word or "").strip()
            if not text:
                continue
            words.append({
                "word": text,
                "punctuated_word": text,
                "start": float(w.start),
                "end": float(w.end),
                "confidence": float(w.probability) if w.probability is not None else 0.99,
            })
    return words, dropped


def shift_words(words, offset_s):
    """Shift slice-relative word times back to source time (pure, testable)."""
    out = []
    for w in words:
        start_ms = int(round((w["start"] + offset_s) * 1000))
        end_ms = int(round((w["end"] + offset_s) * 1000))
        if end_ms < start_ms:
            end_ms = start_ms
        out.append({
            "word": w["word"],
            "punctuated_word": w.get("punctuated_word", w["word"]),
            "source_start_ms": start_ms,
            "source_end_ms": end_ms,
            "confidence": w.get("confidence", 0.99),
        })
    return out


_chunk_worker_model = None


def _init_chunk_worker(model_ref, cpu_threads=0):
    """Load one model copy per worker process (see cmd_asr)."""
    global _chunk_worker_model
    from faster_whisper import WhisperModel

    kwargs = {} if not cpu_threads else {"cpu_threads": cpu_threads}
    _chunk_worker_model = WhisperModel(model_ref, device="cpu", compute_type="int8", **kwargs)


def merge_split_numbers(words, max_gap_ms=120):
    """Merge a split-thousands word pair back into one token (pure, testable).

    faster-whisper word timestamps can emit `"30"`, `",000"` (and `"24"`,
    `",000"`) as two words. Rule: when a word starts with `,` or `.`
    followed by digits, the previous word ends with a digit, and the gap
    between them is at most `max_gap_ms`, the pair merges into one token
    (`30` + `,000` -> `30,000`) with the first start and the last end.
    Applies repeatedly left to right; confidence is the minimum of the pair.
    """
    merged = []
    for w in words:
        if (
            merged
            and isinstance(w.get("word"), str)
            and len(w["word"]) >= 2
            and w["word"][0] in (",", ".")
            and w["word"][1:].isdigit()
            and isinstance(merged[-1].get("word"), str)
            and merged[-1]["word"][-1:].isdigit()
            and (w.get("source_start_ms", 0) - merged[-1].get("source_end_ms", 0)) <= max_gap_ms
        ):
            prev = merged[-1]
            prev = dict(prev)
            prev["word"] = prev["word"] + w["word"]
            prev["punctuated_word"] = prev.get("punctuated_word", prev["word"]) + w.get(
                "punctuated_word", w["word"]
            )
            prev["source_end_ms"] = w.get("source_end_ms", prev["source_end_ms"])
            prev["confidence"] = min(
                prev.get("confidence", 0.99), w.get("confidence", 0.99)
            )
            merged[-1] = prev
        else:
            merged.append(w)
    return merged


def shift_dropped(dropped, offset_s):
    """Shift slice-relative dropped-segment ranges back to source ms."""
    out = []
    for d in dropped:
        start_ms = int(round((d["start"] + offset_s) * 1000))
        end_ms = int(round((d["end"] + offset_s) * 1000))
        if end_ms < start_ms:
            end_ms = start_ms
        out.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "reason": d.get("reason", "not_speech"),
        })
    return out


def _transcribe_span(payload):
    """Decode one audio slice in a worker process; times return in source ms."""
    import numpy as np

    pcm_slice = np.frombuffer(payload["pcm"], dtype=np.float32)
    slice_words, slice_dropped = transcribe_chunk(
        pcm_slice,
        _chunk_worker_model,
        payload["lang"],
        payload["initial_prompt"],
        payload["hotwords"],
    )
    return {
        "words": shift_words(slice_words, payload["offset_s"]),
        "dropped": shift_dropped(slice_dropped, payload["offset_s"]),
    }


def cmd_asr(args):
    from faster_whisper import WhisperModel

    model_arg = args.model
    if os.path.isdir(model_arg):
        model_ref = model_arg
        model_label = os.path.basename(os.path.normpath(model_arg))
    else:
        model_ref = model_arg
        model_label = model_arg
    keyterms = [k.strip() for k in (args.keyterms or "").split(",") if k.strip()]
    hotwords = ", ".join(keyterms) if keyterms else None
    requested = (args.lang or "auto").lower()
    lang = None if requested == "auto" else args.lang
    jobs = max(1, int(getattr(args, "jobs", 1) or 1))
    cpu_threads = max(0, int(getattr(args, "cpu_threads", 0) or 0))

    pcm = decode_audio_16k_mono(args.audio)
    sr = 16000
    rms = frame_rms(pcm, sr)
    chunks = plan_chunks(len(pcm), rms, sr)

    def load_model():
        kwargs = {} if not cpu_threads else {"cpu_threads": cpu_threads}
        return WhisperModel(model_ref, device="cpu", compute_type="int8", **kwargs)

    # Language is detected once (encoder-only, no decode) so every chunk
    # transcribes with one fixed language and one shared prompt. Chunk 0 is
    # decoded on the main model; the rest fan out to worker processes.
    # Separate processes (never threads sharing one process) keep inference
    # bit-identical across runs: same input still decodes to the same JSON.
    model = load_model()
    try:
        if lang is None:
            probe = pcm[: min(len(pcm), 30 * sr)]
            detected, _prob, _all = model.detect_language(probe)
            detected = (detected or "auto").lower()
        else:
            detected = requested
        prompt_lang = detected if detected in FILLER_PROMPTS else "neutral"
        initial_prompt = filler_prompt_for(prompt_lang, keyterms)
        fixed_lang = detected if detected != "auto" else None

        per_chunk = [None] * len(chunks)
        per_dropped = [None] * len(chunks)
        first_start, first_end = chunks[0]
        first_words, first_dropped = transcribe_chunk(
            pcm[first_start:first_end], model, fixed_lang, initial_prompt, hotwords,
        )
        per_chunk[0] = shift_words(first_words, first_start / float(sr))
        per_dropped[0] = shift_dropped(first_dropped, first_start / float(sr))
        rest = list(enumerate(chunks))[1:]

        if jobs == 1:
            for i, span in rest:
                start, end = span
                slice_words, slice_dropped = transcribe_chunk(
                    pcm[start:end], model, fixed_lang, initial_prompt, hotwords,
                )
                per_chunk[i] = shift_words(slice_words, start / float(sr))
                per_dropped[i] = shift_dropped(slice_dropped, start / float(sr))
        else:
            import concurrent.futures

            payloads = [
                {
                    "pcm": pcm[start:end].tobytes(),
                    "offset_s": start / float(sr),
                    "lang": fixed_lang,
                    "initial_prompt": initial_prompt,
                    "hotwords": hotwords,
                    "model_ref": model_ref,
                }
                for i, (start, end) in rest
            ]
            with concurrent.futures.ProcessPoolExecutor(
                max_workers=min(jobs, len(payloads)),
                initializer=_init_chunk_worker,
                initargs=(model_ref, cpu_threads),
            ) as pool:
                for i, span_result in zip([i for i, _ in rest], pool.map(_transcribe_span, payloads)):
                    per_chunk[i] = span_result["words"]
                    per_dropped[i] = span_result["dropped"]
        words = [w for part in per_chunk if part for w in part]
        words.sort(key=lambda w: (w["source_start_ms"], w["source_end_ms"]))
        words = merge_split_numbers(words)
        dropped_segments = [d for part in per_dropped if part for d in part]
        dropped_segments.sort(key=lambda d: (d["start_ms"], d["end_ms"]))
        language = detected
    finally:
        # Release the model promptly; callers may run ASR then TTS in sequence.
        del model

    sys.stdout.write(json.dumps(
        {
            "language": language,
            "model": model_label,
            "words": words,
            "dropped_segments": dropped_segments,
            "dropped_segment_count": len(dropped_segments),
        },
        ensure_ascii=False,
    ) + "\n")


def cmd_plan_chunks(args):
    pcm = decode_audio_16k_mono(args.audio)
    sr = 16000
    chunks = plan_chunks(len(pcm), frame_rms(pcm, sr), sr)
    sys.stdout.write(json.dumps(
        {"sample_rate": sr, "chunks": [{"start": s, "end": e} for s, e in chunks]},
        ensure_ascii=False,
    ) + "\n")


def resolve_voice(voice_arg, voices_dir):
    if voice_arg and os.path.isfile(voice_arg):
        return voice_arg
    candidates = []
    if voice_arg:
        candidates.append(voice_arg if voice_arg.endswith(".onnx") else voice_arg + ".onnx")
    if voices_dir:
        for name in candidates + ([voice_arg] if voice_arg else []):
            base = name if name.endswith(".onnx") else name + ".onnx"
            candidates.append(os.path.join(voices_dir, base))
            candidates.append(os.path.join(voices_dir, voice_arg or "", base))
    for cand in candidates:
        if cand and os.path.isfile(cand):
            return cand
    raise FileNotFoundError(
        "Piper voice not found: %r (tried %s)" % (voice_arg, candidates)
    )


def piper_module_available():
    """True when `piper` is importable in this interpreter (venv package)."""
    try:
        import importlib.util

        return importlib.util.find_spec("piper") is not None
    except Exception:
        return False


def resolve_piper_cmd(explicit):
    """Argv prefix that runs Piper. Returns a list.

    Order: explicit `--piper-exe`/`PIPER_EXE` first, then
    `[sys.executable, "-m", "piper"]` when the module is importable (a
    `venv\\Scripts\\piper.exe` `uv` trampoline fails when the folder is
    copied or moved, while `python -m piper` from the same venv works),
    then `piper` on PATH and the venv siblings.
    """
    if explicit:
        return [explicit]
    env = os.environ.get("PIPER_EXE")
    if env:
        return [env]
    if piper_module_available():
        return [sys.executable, "-m", "piper"]
    found = shutil.which("piper")
    if found:
        return [found]
    sibling = os.path.join(os.path.dirname(sys.executable), "piper.exe")
    if os.path.isfile(sibling):
        return [sibling]
    sibling2 = os.path.join(os.path.dirname(sys.executable), "piper")
    if os.path.isfile(sibling2):
        return [sibling2]
    raise FileNotFoundError(
        "Piper binary not found (set PIPER_EXE, put `piper` on PATH, "
        "or install it next to this Python)."
    )


def resolve_piper_exe(explicit):
    """Legacy form; returns the executable string when the prefix is a
    single binary, else the full argv prefix (e.g. `python -m piper`)."""
    cmd = resolve_piper_cmd(explicit)
    return cmd[0] if len(cmd) == 1 else cmd


def cmd_tts(args):
    import wave

    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        raise ValueError("text file %r is empty" % args.text_file)
    voice_path = resolve_voice(args.voice, args.voices_dir)
    config_path = voice_path + ".json"
    piper_cmd = resolve_piper_cmd(args.piper_exe)

    cmd = [*piper_cmd, "-m", voice_path, "-f", args.out, "-i", args.text_file]
    if os.path.isfile(config_path):
        cmd += ["-c", config_path]
    env = dict(os.environ)
    # Keep stdin/stdout byte-clean; the text travels via --input-file.
    env.setdefault("PYTHONUTF8", "1")
    subprocess.run(cmd, check=True, env=env)

    with wave.open(args.out, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate() or 22050
    duration_ms = int(round(frames / float(rate) * 1000))
    sys.stdout.write(json.dumps(
        {"duration_ms": duration_ms, "words": []}, ensure_ascii=False
    ) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Cuthol keyless local speech bridge.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    asr = sub.add_parser("asr", help="Transcribe audio to provider JSON.")
    asr.add_argument("audio")
    asr.add_argument("--lang", default="auto")
    asr.add_argument("--model", required=True)
    asr.add_argument("--keyterms", default="")
    asr.add_argument("--jobs", type=int, default=1,
                     help="Parallel chunk workers (each loads its own model copy).")
    asr.add_argument("--cpu-threads", type=int, default=0, dest="cpu_threads",
                     help="Threads per process for faster-whisper (0 = library default).")

    plan = sub.add_parser("plan-chunks", help="Print silence-valley chunk boundaries as JSON (no model).")
    plan.add_argument("audio")

    tts = sub.add_parser("tts", help="Synthesize a UTF-8 text file to wav.")
    tts.add_argument("--text-file", required=True)
    tts.add_argument("--voice", required=True)
    tts.add_argument("--out", required=True)
    tts.add_argument("--voices-dir", default=None)
    tts.add_argument("--piper-exe", default=None)

    args = parser.parse_args(argv)
    if args.cmd == "asr":
        cmd_asr(args)
    elif args.cmd == "plan-chunks":
        cmd_plan_chunks(args)
    else:
        cmd_tts(args)


if __name__ == "__main__":
    main()
