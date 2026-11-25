// Notes region: click a point or drag an area on the preview frame, write a
// note; every note on one frame ships as a single packet to the agent with the
// elements under each pin and one contact-sheet image. Prefix: .nt-
//
// The overlay never touches the preview DOM: it aligns a fixed layer to the
// stage rectangle and converts through the project stage size (letterbox-aware).
import { DEFAULT_SHORTCUTS, eventChord, loadShortcuts, matchShortcut, resolveShortcuts } from "./shortcuts.js";

// -- pure helpers (also imported by the node unit test; no DOM here) ---------

/** Sequence frame at a playhead position (matches the preview timecode). */
export function frameAtMs(playheadMs, fps) {
  const f = Math.max(1, Number(fps) || 30);
  return Math.max(0, Math.floor((Math.max(0, Number(playheadMs) || 0) / 1000) * f));
}

/**
 * Client (CSS px) click to stage pixels. The stage rect keeps the project
 * aspect, but the mapping stays correct under letterboxing: uniform scale plus
 * a centered offset.
 */
export function clientToStage(clientX, clientY, rect, stageW, stageH) {
  const W = Math.max(1, stageW);
  const H = Math.max(1, stageH);
  const scale = Math.min(rect.width / W, rect.height / H);
  const offX = rect.left + (rect.width - W * scale) / 2;
  const offY = rect.top + (rect.height - H * scale) / 2;
  return { x: (clientX - offX) / scale, y: (clientY - offY) / scale, scale };
}

/** Stage pixels back to client (CSS px) coordinates within the same rect. */
export function stageToClient(stageX, stageY, rect, stageW, stageH) {
  const W = Math.max(1, stageW);
  const H = Math.max(1, stageH);
  const scale = Math.min(rect.width / W, rect.height / H);
  const offX = rect.left + (rect.width - W * scale) / 2;
  const offY = rect.top + (rect.height - H * scale) / 2;
  return { x: offX + stageX * scale, y: offY + stageY * scale, scale };
}

/** Group notes/drafts by frame; one frame ships as one packet. */
export function groupNotesByFrame(items) {
  const groups = new Map();
  for (const it of items ?? []) {
    const key = it.frame;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return groups;
}

/** All drafts flat, ordered for stable packet numbering (time, then creation). */
export function orderedDrafts(drafts) {
  const all = [];
  for (const list of drafts?.values?.() ?? []) for (const d of list) all.push(d);
  all.sort((a, b) => (a.at_ms - b.at_ms) || (a.uid - b.uid));
  return all;
}

/** Number drafts 1..N across the whole packet, stable in pins, list and lines. */
export function renumberAll(drafts) {
  for (const [i, d] of orderedDrafts(drafts).entries()) d.n = i + 1;
}

/** Composition cue ids in sequence order (for range from/to picks). */
export function cueOptions(sequence) {
  const out = [];
  for (const lane of sequence?.lanes ?? []) for (const cue of lane?.cues ?? []) out.push(cue.id);
  return out;
}

/** Topmost composition cue at a sequence time, else the spine clip (the scene). */
export function cueAtTimeSeq(sequence, atMs) {
  const lanes = [...(sequence?.lanes ?? [])].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
  let best;
  for (const lane of lanes) {
    const cues = [...(lane?.cues ?? [])].sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
    for (const cue of cues) {
      const start = cue.at_ms ?? 0;
      if (atMs >= start && atMs < start + (cue.duration_ms ?? 0)) best = cue.id;
    }
  }
  if (best) return best;
  for (const c of sequence?.spine?.clips ?? []) {
    if (atMs >= (c.at_ms ?? 0) && atMs < (c.at_ms ?? 0) + (c.duration_ms ?? 0)) return c.id;
  }
  return undefined;
}

/** Cuts between consecutive cues (end of one ≈ start of the next). */
export function cueBoundaries(sequence, fps) {
  const frameMs = 1000 / Math.max(1, fps ?? 30);
  const cues = [];
  for (const lane of sequence?.lanes ?? []) {
    for (const cue of lane?.cues ?? []) cues.push({ id: cue.id, start: cue.at_ms ?? 0, end: (cue.at_ms ?? 0) + (cue.duration_ms ?? 0) });
  }
  cues.sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 0; i + 1 < cues.length; i++) {
    const gap = cues[i + 1].start - cues[i].end;
    if (Math.abs(gap) <= frameMs * 1.5 + 1) {
      const at = Math.round((cues[i].end + cues[i + 1].start) / 2);
      if (!out.some((b) => b.from === cues[i].id && b.to === cues[i + 1].id)) out.push({ at_ms: at, from: cues[i].id, to: cues[i + 1].id });
    }
  }
  return out;
}

/** Compact note timestamp `MM:SS.cc` for packet lines. */
export function formatNoteTime(atMs) {
  const ms = Math.max(0, Math.round(Number(atMs) || 0));
  const mm = String(Math.floor(ms / 60000)).padStart(2, "0");
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  const cc = String(Math.floor((ms % 1000) / 10)).padStart(2, "0");
  return `${mm}:${ss}.${cc}`;
}

/** One packet line per note, the form the agent reads. */
export function formatNoteLine(note) {
  const text = String(note.text ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const refs = (note.elements ?? []).slice(0, 3).map((el) => el.ref);
  const where = refs.length
    ? ` → ${refs.join(" ∩ ")}${note.overlap_px2 ? ` ${Math.round(note.overlap_px2)} px²` : ""}`
    : "";
  return `#${note.n} ${formatNoteTime(note.at_ms)} "${text}"${where}`;
}

/** Whole packet as paste-ready plain text (Copy as text). */
export function formatPacketText(notes) {
  return (notes ?? []).map(formatNoteLine).join("\n");
}

/** An inbox packet as a sent-list entry (still waiting for the agent). */
export function packetToSentEntry(packet) {
  const notes = packet?.notes ?? [];
  const first = notes[0] ?? {};
  return {
    id: packet?.id ?? "",
    frame: first.frame ?? 0,
    frames: new Set(notes.map((n) => n.frame)).size || 1,
    count: notes.length,
    lines: notes.map(formatNoteLine),
    status: "waiting",
    sentAt: packet?.created_at ?? "",
    deliveredAt: null,
  };
}

/**
 * Rebuild the sent list after a (re)load: inbox packets are waiting (newest
 * first); known entries that left the inbox were delivered while away.
 */
export function mergeRestoredSent(inboxPackets, candidates) {
  const pending = new Set((inboxPackets ?? []).map((p) => p?.id));
  const known = new Map((candidates ?? []).filter((c) => c?.id).map((c) => [c.id, c]));
  const next = [];
  for (const p of [...(inboxPackets ?? [])].reverse()) {
    if (!p?.id || !pending.has(p.id)) continue;
    const prev = known.get(p.id);
    next.push(prev ? { ...prev, status: "waiting", deliveredAt: null } : packetToSentEntry(p));
  }
  for (const c of candidates ?? []) {
    if (!c?.id || pending.has(c.id) || next.some((n) => n.id === c.id)) continue;
    next.push(c.status === "delivered" ? { ...c } : { ...c, status: "delivered", deliveredAt: c.deliveredAt ?? "earlier" });
  }
  return next;
}

// -- region ---------------------------------------------------------------

const COORDS_RETRY_MS = 2000;
const COORDS_MAX_RETRIES = 3;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export function mount(root, ctx) {
  if (!root) return;
  const store = ctx.store;
  const api = ctx.api;

  /** @type {Map<number, any[]>} frame -> drafts on that frame (one packet = all frames) */
  const drafts = new Map();
  /** @type {Array<{id:string, frame:number, count:number, lines:string[], status:string, sentAt:string, deliveredAt:string|null}>} */
  const sent = [];
  let uidCounter = 0;
  let selectedUid = null;
  let sending = false;
  let pinEls = new Map();
  let pinSignature = "";
  let rafId = 0;
  const seqDoc = () => store.state.snapshot?.sequence ?? store.state.sequence ?? null;
  const allDrafts = () => orderedDrafts(drafts);

  const stageSize = () => {
    const p = store.state.snapshot?.project ?? {};
    return { w: p.width ?? 1920, h: p.height ?? 1080, fps: p.fps ?? 30 };
  };
  const currentFrame = () => frameAtMs(store.state.playheadMs ?? 0, stageSize().fps);
  const currentDrafts = () => drafts.get(currentFrame()) ?? [];
  const stageEl = () => document.querySelector(".pv-stage");

  const frameLabel = (frame) => {
    const { fps } = stageSize();
    return `f${frame} · ${formatNoteTime((frame / Math.max(1, fps)) * 1000)}`;
  };

  // -- panel --------------------------------------------------------------
  root.innerHTML = `
    <div class="panel-head">notes<span class="spacer"></span><span class="nt-frame mono"></span></div>
    <div class="panel-body nt-body">
      <div class="nt-empty"></div>
      <ul class="nt-list"></ul>
      <div class="nt-actions">
        <button class="nt-general" type="button" title="Note without a frame pin">General note</button>
        <button class="nt-send" type="button">Send notes</button>
        <button class="nt-discard" type="button">Discard</button>
        <span class="nt-hint mono">Ctrl+Enter</span>
      </div>
      <div class="nt-delivery">Notes reach the agent with its next step; it cannot be woken while idle.</div>
      <ul class="nt-sent"></ul>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const frameEl = $(".nt-frame");
  const emptyEl = $(".nt-empty");
  const listEl = $(".nt-list");
  const sentEl = $(".nt-sent");
  const sendBtn = $(".nt-send");
  const discardBtn = $(".nt-discard");

  // -- overlay layer (fixed, aligned to the stage rect; preview DOM untouched)
  const layer = document.createElement("div");
  layer.className = "nt-layer";
  layer.hidden = true;
  document.body.appendChild(layer);
  const marquee = document.createElement("div");
  marquee.className = "nt-marquee";
  marquee.hidden = true;
  layer.appendChild(marquee);

  const layerRect = () => {
    const st = stageEl();
    if (!st) return null;
    const r = st.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return r;
  };

  const syncLayerBox = () => {
    const r = layerRect();
    if (!r) {
      layer.hidden = true;
      return null;
    }
    layer.hidden = false;
    layer.style.left = `${r.left}px`;
    layer.style.top = `${r.top}px`;
    layer.style.width = `${r.width}px`;
    layer.style.height = `${r.height}px`;
    return r;
  };

  const findDraft = (uid) => {
    for (const list of drafts.values()) {
      const d = list.find((x) => x.uid === uid);
      if (d) return d;
    }
    return null;
  };

  const setDraftElements = (frame, n, patch) => {
    const list = drafts.get(frame) ?? [];
    const d = list.find((x) => x.n === n);
    if (!d) return;
    Object.assign(d, patch);
    const row = listEl.querySelector(`[data-uid="${d.uid}"] .nt-els`);
    if (row) row.innerHTML = elementsHtml(d);
    const pin = pinEls.get(d.n);
    if (pin) pin.classList.toggle("is-pending", d.elState === "pending" || d.elState === "loading");
  };

  const elementsHtml = (d) => {
    if (!d.point) return `<span class="nt-noels">general note</span>`;
    if (d.elState === "loading" || d.elState === "pending") return `<span class="nt-measuring">measuring elements…</span>`;
    if (d.elState === "error") return `<span class="nt-noels">elements unavailable</span>`;
    if (!d.elements || d.elements.length === 0) return `<span class="nt-noels">no elements</span>`;
    const names = d.elements.slice(0, 3).map((e) => `<span class="nt-el">${escapeHtml(e.ref)}</span>`).join(`<span class="nt-sep"> · </span>`);
    return names;
  };

  const fetchElements = async (frame, n, attempt = 0) => {
    const list = drafts.get(frame) ?? [];
    const d = list.find((x) => x.n === n);
    if (!d) return;
    setDraftElements(frame, n, { elState: attempt === 0 ? "loading" : "pending" });
    const q = new URLSearchParams({ at_ms: String(Math.round(d.at_ms)), x: String(Math.round(d.point.x * 10) / 10), y: String(Math.round(d.point.y * 10) / 10) });
    if (d.area) {
      q.set("w", String(Math.round(d.area[2] * 10) / 10));
      q.set("h", String(Math.round(d.area[3] * 10) / 10));
      q.set("x", String(Math.round(d.area[0] * 10) / 10));
      q.set("y", String(Math.round(d.area[1] * 10) / 10));
    }
    let res = null;
    try {
      res = await api.get(`/api/coords?${q.toString()}`);
    } catch {
      setDraftElements(frame, n, { elState: "error" });
      return;
    }
    if (!res || res.ok !== true) {
      setDraftElements(frame, n, { elState: "error" });
      return;
    }
    if (res.pending) {
      if (attempt < COORDS_MAX_RETRIES) {
        setDraftElements(frame, n, { elState: "pending" });
        setTimeout(() => fetchElements(frame, n, attempt + 1), COORDS_RETRY_MS);
      } else {
        setDraftElements(frame, n, { elState: "error" });
      }
      return;
    }
    setDraftElements(frame, n, { elState: "ready", elements: res.elements ?? [], overlap_px2: res.overlap_px2 });
  };

  const addDraft = (point, area) => {
    if (store.state.playing) store.set({ playing: false });
    const frame = currentFrame();
    const atMs = Math.round(store.state.playheadMs ?? 0);
    const list = drafts.get(frame) ?? [];
    const general = point == null;
    const seq = seqDoc();
    const d = { uid: ++uidCounter, n: 0, text: "", at_ms: atMs, frame, point: point ?? null, area, elements: [], overlap_px2: undefined, elState: general ? "ready" : "loading", cue: seq ? cueAtTimeSeq(seq, atMs) : undefined, scope: null };
    list.push(d);
    drafts.set(frame, list);
    renumberAll(drafts);
    selectedUid = d.uid;
    if (!general) void fetchElements(frame, d.n);
    renderPanel();
    rebuildPins(true);
    const ta = listEl.querySelector(`.nt-text[data-uid="${d.uid}"]`);
    if (ta) ta.focus();
  };

  // A general note has no pin: same queue, no contact-sheet cell.
  const addGeneralDraft = () => {
    store.set({ annotate: true });
    addDraft(null, undefined);
  };

  const deleteDraft = (uid) => {
    for (const [frame, list] of drafts) {
      const next = list.filter((d) => d.uid !== uid);
      if (next.length !== list.length) {
        if (next.length) drafts.set(frame, next);
        else drafts.delete(frame);
        break;
      }
    }
    renumberAll(drafts);
    if (selectedUid === uid) selectedUid = null;
    renderPanel();
    rebuildPins(true);
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const scopeLabel = (d) => {
    if (!d.scope) return d.cue ? `@ ${d.cue} ${formatNoteTime(d.at_ms)}` : formatNoteTime(d.at_ms);
    if (d.scope.kind === "boundary") return `boundary ${d.scope.from}→${d.scope.to} @ ${formatNoteTime(d.at_ms)}`;
    if (d.scope.kind === "range") return `range ${d.scope.from}–${d.scope.to}`;
    return "all scenes";
  };

  const scopeControls = (d) => {
    const seq = seqDoc();
    const kind = d.scope?.kind ?? "frame";
    let html = `<select class="nt-scope" data-uid="${d.uid}" title="What this note applies to">` +
      `<option value="frame"${kind === "frame" ? " selected" : ""}>this frame</option>` +
      `<option value="boundary"${kind === "boundary" ? " selected" : ""}>boundary</option>` +
      `<option value="range"${kind === "range" ? " selected" : ""}>scene range</option>` +
      `<option value="all"${kind === "all" ? " selected" : ""}>all scenes</option></select>`;
    if (kind === "boundary") {
      const bounds = seq ? cueBoundaries(seq, stageSize().fps) : [];
      const val = d.scope ? `${d.scope.from}→${d.scope.to}` : "";
      html += `<select class="nt-bound" data-uid="${d.uid}" title="Which cut">` +
        bounds.map((b) => `<option value="${escapeHtml(b.from)}→${escapeHtml(b.to)}"${`${b.from}→${b.to}` === val ? " selected" : ""}>${escapeHtml(b.from)}→${escapeHtml(b.to)}</option>`).join("") +
        `</select>`;
    } else if (kind === "range") {
      const cues = seq ? cueOptions(seq) : [];
      const from = d.scope?.from ?? d.cue ?? cues[0] ?? "";
      const to = d.scope?.to ?? d.cue ?? cues[cues.length - 1] ?? "";
      const opts = (sel) => cues.map((c) => `<option${c === sel ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");
      html += `<select class="nt-from" data-uid="${d.uid}" title="Range start">${opts(from)}</select><span class="nt-dash">–</span><select class="nt-to" data-uid="${d.uid}" title="Range end">${opts(to)}</select>`;
    }
    return html;
  };

  const renderPanel = () => {
    const frame = currentFrame();
    const list = allDrafts();
    frameEl.textContent = store.state.snapshot ? `@ ${frameLabel(frame)}` : "";
    const annotate = !!store.state.annotate;
    emptyEl.textContent = !store.state.snapshot
      ? "Waiting for the project…"
      : list.length === 0
        ? (annotate ? "Click the frame for a point, drag for an area." : "Press N, then click the frame — or add a general note.")
        : "";
    emptyEl.hidden = emptyEl.textContent === "";
    let lastGroup = null;
    listEl.innerHTML = list.map((d) => {
      const group = d.scope?.kind === "all" ? "all scenes" : d.scope?.kind === "range" ? `range ${d.scope.from}–${d.scope.to}` : d.cue ?? "no scene";
      const head = group !== lastGroup ? `<li class="nt-group" data-at="${d.at_ms}" data-frame="${d.frame}" title="Seek here"><span>${escapeHtml(group)}</span></li>` : "";
      lastGroup = group;
      return head + `
      <li class="nt-row${d.uid === selectedUid ? " is-selected" : ""}" data-uid="${d.uid}">
        <span class="nt-num">${d.n}</span>
        <div class="nt-main">
          <textarea class="nt-text" rows="2" placeholder="Note ${d.n}…" data-uid="${d.uid}">${escapeHtml(d.text)}</textarea>
          <div class="nt-els">${elementsHtml(d)}</div>
          <div class="nt-meta"><span class="nt-where mono">${escapeHtml(scopeLabel(d))}</span>${scopeControls(d)}</div>
        </div>
        <button class="icon-btn nt-del" type="button" data-uid="${d.uid}" title="Delete note ${d.n}" aria-label="Delete note ${d.n}">
          <svg class="icon" viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
        </button>
      </li>`;
    }).join("");
    for (const t of listEl.querySelectorAll(".nt-text")) {
      t.addEventListener("input", () => {
        const d = findDraft(Number(t.dataset.uid));
        if (d) d.text = t.value;
        syncSendState();
      });
      t.addEventListener("focus", () => {
        selectedUid = Number(t.dataset.uid);
        for (const r of listEl.querySelectorAll(".nt-row")) r.classList.toggle("is-selected", Number(r.dataset.uid) === selectedUid);
        for (const pin of pinEls.values()) pin.classList.toggle("is-selected", Number(pin.dataset.uid) === selectedUid);
      });
    }
    for (const b of listEl.querySelectorAll(".nt-del")) {
      b.addEventListener("click", () => deleteDraft(Number(b.dataset.uid)));
    }
    for (const g of listEl.querySelectorAll(".nt-group")) {
      g.addEventListener("click", () => store.set({ playheadMs: Number(g.dataset.at) }));
    }
    for (const s of listEl.querySelectorAll(".nt-scope")) {
      s.addEventListener("change", () => {
        const d = findDraft(Number(s.dataset.uid));
        if (!d) return;
        const kind = s.value;
        const seq = seqDoc();
        if (kind === "frame") d.scope = null;
        else if (kind === "all") d.scope = { kind: "all" };
        else if (kind === "range") {
          const cues = seq ? cueOptions(seq) : [];
          const cur = d.cue ?? cues[0] ?? "";
          d.scope = { kind: "range", from: cur, to: cur };
        } else if (kind === "boundary") {
          const bounds = seq ? cueBoundaries(seq, stageSize().fps) : [];
          const near = bounds.find((b) => Math.abs(b.at_ms - d.at_ms) <= 1000 / Math.max(1, stageSize().fps) + 1) ?? bounds[0];
          if (near) {
            d.scope = { kind: "boundary", from: near.from, to: near.to };
            d.at_ms = near.at_ms;
            d.frame = frameAtMs(near.at_ms, stageSize().fps);
          } else d.scope = null;
          reframeDraft(d);
        }
        renumberAll(drafts);
        renderPanel();
        rebuildPins(true);
      });
    }
    for (const s of listEl.querySelectorAll(".nt-bound")) {
      s.addEventListener("change", () => {
        const d = findDraft(Number(s.dataset.uid));
        const seq = seqDoc();
        if (!d || !seq) return;
        const [from, to] = String(s.value).split("→");
        const b = cueBoundaries(seq, stageSize().fps).find((x) => x.from === from && x.to === to);
        if (b) {
          d.scope = { kind: "boundary", from, to };
          d.at_ms = b.at_ms;
          d.frame = frameAtMs(b.at_ms, stageSize().fps);
          reframeDraft(d);
        }
        renumberAll(drafts);
        renderPanel();
        rebuildPins(true);
      });
    }
    for (const sel of listEl.querySelectorAll(".nt-from,.nt-to")) {
      sel.addEventListener("change", () => {
        const d = findDraft(Number(sel.dataset.uid));
        if (!d || d.scope?.kind !== "range") return;
        if (sel.classList.contains("nt-from")) d.scope.from = sel.value;
        else d.scope.to = sel.value;
        renderPanel();
      });
    }
    syncSendState();
    renderSent();
  };

  // Move a draft to its frame bucket after a boundary pick changed its time.
  const reframeDraft = (d) => {
    for (const [frame, list] of drafts) {
      const i = list.indexOf(d);
      if (i >= 0) {
        list.splice(i, 1);
        if (!list.length) drafts.delete(frame);
        break;
      }
    }
    const list = drafts.get(d.frame) ?? [];
    list.push(d);
    drafts.set(d.frame, list);
  };

  const syncSendState = () => {
    const list = allDrafts();
    const ready = !sending && list.length > 0 && list.every((d) => d.text.trim().length > 0);
    sendBtn.disabled = !ready;
    discardBtn.disabled = sending || list.length === 0;
    sendBtn.textContent = sending ? "Sending…" : `Send notes (${list.length})`;
  };

  const renderSent = () => {
    const rows = sent.map((p) => `
      <li class="nt-packet" data-status="${p.status}">
        <span class="nt-pcount mono">${p.count} note${p.count > 1 ? "s" : ""} · ${p.frames} frame${p.frames > 1 ? "s" : ""}</span>
        <span class="nt-status">${p.status === "waiting" ? "waiting for agent" : `delivered ${p.deliveredAt ?? ""}`}</span>
        ${p.status === "waiting" ? `<button class="nt-copy" type="button" data-id="${p.id}">Copy as text</button>` : ""}
      </li>`).join("");
    sentEl.innerHTML = rows;
    for (const b of sentEl.querySelectorAll(".nt-copy")) {
      b.addEventListener("click", () => copyPacketText(b.dataset.id, b));
    }
  };

  const copyPacketText = async (id, btn) => {
    const p = sent.find((x) => x.id === id);
    if (!p) return;
    const text = p.lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // clipboard unavailable; the text stays visible in the packet
      }
      ta.remove();
    }
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }
  };

  const toLiveNote = (d) => {
    const { w, h } = stageSize();
    return {
      n: d.n,
      text: d.text.trim(),
      at_ms: Math.round(d.at_ms),
      frame: d.frame,
      ...(d.point
        ? { point: { x: Math.round(d.point.x * 10) / 10, y: Math.round(d.point.y * 10) / 10, nx: Math.round((d.point.x / Math.max(1, w)) * 10000) / 10000, ny: Math.round((d.point.y / Math.max(1, h)) * 10000) / 10000 } }
        : {}),
      ...(d.area ? { area: [Math.round(d.area[0] * 10) / 10, Math.round(d.area[1] * 10) / 10, Math.round(d.area[2] * 10) / 10, Math.round(d.area[3] * 10) / 10] } : {}),
      elements: d.elements ?? [],
      ...(d.overlap_px2 ? { overlap_px2: d.overlap_px2 } : {}),
      ...(d.cue ? { cue: d.cue } : {}),
      ...(d.scope ? { scope: d.scope } : {}),
    };
  };

  // One packet = every draft on every frame, numbered 1..N across the packet.
  const sendAll = async () => {
    const list = allDrafts();
    if (sending || list.length === 0 || !list.every((d) => d.text.trim().length > 0)) return;
    sending = true;
    syncSendState();
    const notes = list.map(toLiveNote);
    let res = null;
    try {
      res = await api.post("/api/notes", { notes, revision: store.state.revision ?? 0 });
    } catch {
      res = null;
    }
    sending = false;
    if (!res || res.ok !== true || !res.id) {
      syncSendState();
      return;
    }
    sent.unshift({
      id: res.id,
      frame: notes[0].frame,
      frames: new Set(notes.map((n) => n.frame)).size,
      count: notes.length,
      lines: notes.map(formatNoteLine),
      status: "waiting",
      sentAt: new Date().toISOString(),
      deliveredAt: null,
    });
    saveStoredSent();
    drafts.clear();
    selectedUid = null;
    renderPanel();
    rebuildPins(true);
  };

  // -- pins (current frame only; numbers are packet-wide) ----------------------
  const rebuildPins = (force = false) => {
    const sig = `${currentFrame()}:${currentDrafts().map((d) => d.n).join(",")}`;
    if (!force && sig === pinSignature) return;
    pinSignature = sig;
    for (const [, el] of pinEls) el.remove();
    pinEls = new Map();
    layer.querySelectorAll(".nt-area").forEach((el) => el.remove());
    for (const d of currentDrafts()) {
      if (!d.point) continue; // general note: panel row only, no pin
      if (d.area) {
        const box = document.createElement("div");
        box.className = "nt-area";
        box.dataset.uid = String(d.uid);
        layer.appendChild(box);
      }
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "nt-pin";
      pin.dataset.uid = String(d.uid);
      pin.textContent = String(d.n);
      pin.title = `Note ${d.n} — select`;
      pin.classList.toggle("is-pending", d.elState === "pending" || d.elState === "loading");
      pin.classList.toggle("is-selected", d.uid === selectedUid);
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedUid = d.uid;
        for (const p of pinEls.values()) p.classList.toggle("is-selected", Number(p.dataset.uid) === selectedUid);
        renderPanel();
        const ta = listEl.querySelector(`.nt-text[data-uid="${d.uid}"]`);
        if (ta) ta.focus();
      });
      layer.appendChild(pin);
      pinEls.set(d.n, pin);
    }
    positionPins();
  };

  const positionPins = () => {
    const r = layerRect();
    if (!r) return;
    const { w, h } = stageSize();
    // Positions are relative to the layer, which exactly covers the stage rect.
    const local = { left: 0, top: 0, width: r.width, height: r.height };
    for (const d of currentDrafts()) {
      if (!d.point) continue;
      const pin = pinEls.get(d.n);
      if (pin) {
        const p = stageToClient(d.point.x, d.point.y, local, w, h);
        pin.style.left = `${p.x}px`;
        pin.style.top = `${p.y}px`;
      }
      if (d.area) {
        const box = layer.querySelector(`.nt-area[data-uid="${d.uid}"]`);
        if (box) {
          const a = stageToClient(d.area[0], d.area[1], local, w, h);
          const b = stageToClient(d.area[0] + d.area[2], d.area[1] + d.area[3], local, w, h);
          box.style.left = `${Math.min(a.x, b.x)}px`;
          box.style.top = `${Math.min(a.y, b.y)}px`;
          box.style.width = `${Math.abs(b.x - a.x)}px`;
          box.style.height = `${Math.abs(b.y - a.y)}px`;
        }
      }
    }
  };

  // -- pointer: click = point, drag = area -----------------------------------
  let gesture = null;
  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = layerRect();
    if (!r) return;
    const { w, h } = stageSize();
    const s = clientToStage(e.clientX, e.clientY, r, w, h);
    gesture = { startX: clamp(s.x, 0, w), startY: clamp(s.y, 0, h), dragging: false };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  layer.addEventListener("pointermove", (e) => {
    if (!gesture) return;
    const r = layerRect();
    if (!r) return;
    const { w, h } = stageSize();
    const s = clientToStage(e.clientX, e.clientY, r, w, h);
    const cx = clamp(s.x, 0, w);
    const cy = clamp(s.y, 0, h);
    if (!gesture.dragging) {
      // Drag threshold in client px, measured on the layer box.
      const a = stageToClient(gesture.startX, gesture.startY, { left: r.left, top: r.top, width: r.width, height: r.height }, w, h);
      if (Math.hypot(e.clientX - a.x, e.clientY - a.y) > 4) gesture.dragging = true;
    }
    if (gesture.dragging) {
      const a = stageToClient(Math.min(gesture.startX, cx), Math.min(gesture.startY, cy), { left: 0, top: 0, width: r.width, height: r.height }, w, h);
      const b = stageToClient(Math.max(gesture.startX, cx), Math.max(gesture.startY, cy), { left: 0, top: 0, width: r.width, height: r.height }, w, h);
      marquee.hidden = false;
      marquee.style.left = `${a.x}px`;
      marquee.style.top = `${a.y}px`;
      marquee.style.width = `${Math.max(1, b.x - a.x)}px`;
      marquee.style.height = `${Math.max(1, b.y - a.y)}px`;
      gesture.curX = cx;
      gesture.curY = cy;
    }
  });
  const endGesture = (e) => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    marquee.hidden = true;
    const { w, h } = stageSize();
    if (g.dragging && g.curX !== undefined) {
      const x0 = clamp(Math.min(g.startX, g.curX), 0, w);
      const y0 = clamp(Math.min(g.startY, g.curY), 0, h);
      const x1 = clamp(Math.max(g.startX, g.curX), 0, w);
      const y1 = clamp(Math.max(g.startY, g.curY), 0, h);
      if (x1 - x0 >= 8 && y1 - y0 >= 8) {
        addDraft({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, [x0, y0, x1 - x0, y1 - y0]);
        return;
      }
      addDraft({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, undefined);
      return;
    }
    const r = layerRect();
    if (!r) return;
    const s = clientToStage(e.clientX, e.clientY, r, w, h);
    addDraft({ x: clamp(s.x, 0, w), y: clamp(s.y, 0, h) }, undefined);
  };
  layer.addEventListener("pointerup", endGesture);
  layer.addEventListener("pointercancel", () => {
    gesture = null;
    marquee.hidden = true;
  });

  // -- wiring ----------------------------------------------------------------
  root.querySelector(".nt-general")?.addEventListener("click", (e) => { e.stopPropagation(); addGeneralDraft(); });
  // Clicking the panel opens the note box (same as N): annotate on.
  root.addEventListener("pointerdown", (e) => {
    if (e.target?.closest?.("textarea,input,button")) return;
    if (!store.state.annotate) store.set({ annotate: true });
  }, true);
  sendBtn.addEventListener("click", () => void sendAll());
  discardBtn.addEventListener("click", () => {
    drafts.clear();
    selectedUid = null;
    renderPanel();
    rebuildPins(true);
  });
  // Note keys run through the shared shortcut table (shortcuts.js). The send
  // chord must also fire while typing, so it compares chords directly.
  let shortcutMap = { ...DEFAULT_SHORTCUTS };
  loadShortcuts(api).then((m) => { shortcutMap = m; }).catch(() => { /* defaults stand */ });
  store.on("settings", (view) => {
    try {
      const entry = (view?.settings ?? []).find((s) => s.key === "live.shortcuts");
      if (entry?.value && typeof entry.value === "object") shortcutMap = resolveShortcuts(entry.value);
    } catch { /* keep the last good map */ }
  });
  root.addEventListener("keydown", (e) => {
    if (eventChord(e) === shortcutMap["send-notes"]) {
      e.preventDefault();
      void sendAll();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (matchShortcut(shortcutMap, e, "new-note")) {
      e.preventDefault();
      store.set({ annotate: !store.state.annotate });
    }
  });

  // The sent list survives reloads: waiting packets are re-read from the
  // server inbox, delivered ones from local storage (the server exposes no
  // delivered list).
  const sentStoreKey = () => `cuthol.live.sent.v1.${store.state.snapshot?.project?.dir ?? "default"}`;
  const loadStoredSent = () => {
    try {
      const arr = JSON.parse(localStorage.getItem(sentStoreKey()) ?? "[]");
      return Array.isArray(arr) ? arr.filter((e) => e?.id) : [];
    } catch {
      return [];
    }
  };
  const saveStoredSent = () => {
    try {
      localStorage.setItem(sentStoreKey(), JSON.stringify(sent.slice(0, 30)));
    } catch {
      // private mode: the session list still works
    }
  };
  let inboxLoading = false;
  const restoreFromInbox = async () => {
    if (inboxLoading) return;
    inboxLoading = true;
    try {
      const packets = await api.get("/api/inbox");
      if (!Array.isArray(packets)) return;
      const withNotes = packets.filter((p) => (p?.notes?.length ?? 0) > 0);
      const candidates = [...sent];
      for (const s of loadStoredSent()) {
        if (!candidates.some((c) => c.id === s.id)) candidates.push(s);
      }
      const next = mergeRestoredSent(withNotes, candidates);
      sent.length = 0;
      sent.push(...next);
      saveStoredSent();
      renderSent();
    } catch {
      // offline: keep the session list
    } finally {
      inboxLoading = false;
    }
  };

  // Notes events carry the packets the agent has NOT read yet; a sent id that
  // disappears from the list was delivered.
  store.on("notes", (packets) => {
    const pending = new Set((packets ?? []).map((p) => p.id));
    let changed = false;
    for (const p of sent) {
      if (p.status === "waiting" && !pending.has(p.id)) {
        p.status = "delivered";
        p.deliveredAt = new Date().toTimeString().slice(0, 5);
        changed = true;
      }
    }
    if (changed) {
      saveStoredSent();
      renderSent();
    }
  });

  let lastFrame = -1;
  const onState = () => {
    const annotate = !!store.state.annotate;
    if (annotate && store.state.playing) store.set({ playing: false });
    const frame = currentFrame();
    if (frame !== lastFrame) {
      lastFrame = frame;
      selectedUid = null;
      renderPanel();
      rebuildPins(true);
    }
  };
  store.on("state", onState);
  store.on("playhead", onState);
  store.on("snapshot", () => {
    lastFrame = -1;
    onState();
    void restoreFromInbox();
  });
  store.on("delta", () => renderPanel());

  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!store.state.annotate || !store.state.snapshot) {
      if (!layer.hidden) layer.hidden = true;
      return;
    }
    const r = syncLayerBox();
    if (r) {
      rebuildPins(false);
      positionPins();
    }
  };
  rafId = requestAnimationFrame(tick);

  // Test hook: drafts and sent packets without touching the DOM.
  window.__liveNotes = {
    drafts: () => [...drafts.entries()].map(([frame, list]) => ({ frame, notes: list.map((d) => ({ ...d })) })),
    sent: () => sent.map((p) => ({ ...p })),
    send: () => sendAll(),
  };

  renderPanel();
}
