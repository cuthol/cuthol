// Tabbed panel: Clip Info | Notes | Effects. Mounts the existing inspector and notes
// modules into the panes; owns only the tab bar and the active tab. The Notes pane
// can be expanded over the whole right column (Activity + tabs), like an effect's
// menu: the pane itself moves into the overlay (drafts, pins and listeners stay),
// and moves back when collapsed.

const EXPAND_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** @param {HTMLElement|null} root  @param {import('./app.js').LiveContext} ctx */
export async function mount(root, ctx) {
  if (!root) return;
  root.innerHTML = `
    <div class="kt-tabs" role="tablist" aria-label="Details">
      <button class="kt-tab" role="tab" data-tab="clip" aria-selected="true" type="button">Clip Info</button>
      <button class="kt-tab" role="tab" data-tab="notes" aria-selected="false" type="button">Notes</button>
      <button class="kt-tab" role="tab" data-tab="effects" aria-selected="false" type="button">Effects</button>
      <button class="kt-expand" type="button" title="Expand notes" aria-label="Expand notes" hidden>${EXPAND_ICON}</button>
    </div>
    <div class="kt-panes">
      <div class="kt-pane" data-pane="clip" role="tabpanel"></div>
      <div class="kt-pane" data-pane="notes" role="tabpanel" hidden></div>
      <div class="kt-pane" data-pane="effects" role="tabpanel" hidden></div>
    </div>`;
  const panesEl = root.querySelector(".kt-panes");
  const panes = {
    clip: root.querySelector('[data-pane="clip"]'),
    notes: root.querySelector('[data-pane="notes"]'),
    effects: root.querySelector('[data-pane="effects"]'),
  };
  const tabs = [...root.querySelectorAll(".kt-tab")];
  const expandBtn = root.querySelector(".kt-expand");
  /** @type {HTMLElement|null} */
  let notesOverlay = null;

  const select = (name) => {
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const [k, pane] of Object.entries(panes)) {
      if (k === "notes" && notesOverlay) continue; // lives in the overlay while expanded
      pane.hidden = k !== name;
    }
    expandBtn.hidden = name !== "notes";
  };
  for (const t of tabs) t.addEventListener("click", () => select(t.dataset.tab));
  const [inspector, notes, effects] = await Promise.all([import("./inspector.js"), import("./notes.js"), import("./effects.js")]);
  inspector.mount(panes.clip, ctx);
  notes.mount(panes.notes, ctx);
  effects.mountEffectsTab(panes.effects, ctx);
  // Opening the Notes tab opens the note box (same as N).
  root.querySelector('[data-tab="notes"]').addEventListener("click", () => {
    if (!ctx.store.state.annotate) ctx.store.set({ annotate: true });
  });

  const collapseNotes = () => {
    if (!notesOverlay) return;
    panesEl.insertBefore(panes.notes, panes.effects);
    notesOverlay.remove();
    notesOverlay = null;
    select("notes");
    expandBtn.focus();
  };

  const expandNotes = () => {
    const host = document.getElementById("rightcol");
    if (!host || notesOverlay) return;
    effects.closeEffect(); // one overlay at a time
    const el = document.createElement("section");
    el.className = "panel fx-overlay nt-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Notes");
    el.innerHTML = `
      <header class="fx-head">
        <span class="fx-title">Notes</span>
        <button class="fx-close nt-collapse" type="button" title="Collapse (Esc)" aria-label="Collapse notes">${COLLAPSE_ICON}</button>
      </header>
      <div class="fx-body nt-overlay-body"></div>`;
    host.appendChild(el);
    el.querySelector(".nt-overlay-body").appendChild(panes.notes);
    panes.notes.hidden = false;
    notesOverlay = el;
    el.querySelector(".nt-collapse").addEventListener("click", collapseNotes);
    if (!ctx.store.state.annotate) ctx.store.set({ annotate: true });
  };

  expandBtn.addEventListener("click", expandNotes);
  // An effect's menu takes the same place: opening one collapses expanded notes.
  document.addEventListener("live:effect-open", collapseNotes);
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !notesOverlay) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    collapseNotes();
  });
}
