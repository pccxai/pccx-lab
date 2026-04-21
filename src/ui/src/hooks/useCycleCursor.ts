import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Module-level shared store ──────────────────────────────────────────────
// A single cycle cursor is shared across every time-domain panel so the
// Timeline, WaveformViewer, HardwareVisualizer, and FlameGraph all agree
// on "where we are".  Surfer 0.2.0 + GTKWave 3.3 binding convention:
//   ArrowLeft  / ArrowRight  → prev / next edge on the focused signal
//   Shift+Arrow              → ±1 cycle
//   Ctrl+G or "g"            → prompt "go to cycle N"
//   .  /  ,                  → mouse-free alternates (Verdi convention)
//
// The shared store avoids prop-drilling and keeps every panel's cursor
// deterministic: one "current cycle" integer, totalCycles clamp.

export interface CycleCursorSnapshot {
  cycle:        number;
  totalCycles:  number;
}

type Listener = (s: CycleCursorSnapshot) => void;

let cursorState: CycleCursorSnapshot = { cycle: 0, totalCycles: 1024 };
const listeners = new Set<Listener>();

function emit(next: CycleCursorSnapshot) {
  // Re-create the object so React `useSyncExternalStore`-ish equality
  // checks always see a new reference; cheap — just two numbers.
  cursorState = { cycle: next.cycle, totalCycles: next.totalCycles };
  for (const l of listeners) l(cursorState);
}

function setCycleGlobal(next: number) {
  // Integer snap + clamp. Negative inputs snap to 0, overshoot snaps
  // to totalCycles so the "go to cycle N" flow never dead-ends.
  const n = Math.max(0, Math.min(Math.round(next), cursorState.totalCycles));
  if (n === cursorState.cycle) return;
  emit({ cycle: n, totalCycles: cursorState.totalCycles });
}

function setTotalCyclesGlobal(total: number) {
  const t = Math.max(1, Math.floor(total));
  if (t === cursorState.totalCycles) return;
  // Keep the cursor in-bounds when the trace shrinks.
  const nextCycle = Math.min(cursorState.cycle, t);
  emit({ cycle: nextCycle, totalCycles: t });
}

// ─── Hook surface ───────────────────────────────────────────────────────────

export interface CycleCursor {
  cycle:        number;
  totalCycles:  number;
  setCycle:     (n: number) => void;
  /** Step by ±N cycles (integer snap). */
  stepBy:       (n: number) => void;
  /** Step to the next / previous posedge of a signal.  `dir = +1` →
   *  next edge, `dir = -1` → previous. `edges` is a pre-sorted array
   *  of integer cycles at which the focused signal transitions.  If
   *  it is empty the cursor is nudged by a single cycle so the user
   *  still gets feedback. */
  stepEdge:     (dir: 1 | -1, edges?: number[]) => void;
  /** Prompt the user for a target cycle, then snap to it. */
  goToCyclePrompt: (message?: string) => void;
  /** Direct numeric snap — used by the per-panel "Go to cycle N" field. */
  goToCycle:    (n: number) => void;
  /** Update the shared upper bound; usually fed by the panel that
   *  owns the ground-truth trace (Timeline / FlameGraph). */
  setTotalCycles: (total: number) => void;
}

export function useCycleCursor(): CycleCursor {
  const [snap, setSnap] = useState<CycleCursorSnapshot>(cursorState);

  useEffect(() => {
    const fn: Listener = s => setSnap(s);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const setCycle = useCallback((n: number) => setCycleGlobal(n), []);

  const stepBy = useCallback((n: number) => {
    setCycleGlobal(cursorState.cycle + Math.round(n));
  }, []);

  const stepEdge = useCallback((dir: 1 | -1, edges?: number[]) => {
    // No edge data → fall back to ±1 cycle so the key press is never
    // a dead letter (Surfer keeps the cursor moving even when the
    // focused signal has no transitions in the viewport).
    if (!edges || edges.length === 0) {
      stepBy(dir);
      return;
    }
    // Binary search over the pre-sorted edges array (IEEE 1364-2005
    // VCD Annex 18 sort guarantee).  O(log N) per keypress.
    const cur = cursorState.cycle;
    let lo = 0, hi = edges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (edges[mid] <= cur) lo = mid + 1; else hi = mid;
    }
    // `lo` is the index of the first edge strictly after `cur`.
    if (dir === 1) {
      if (lo < edges.length) setCycleGlobal(edges[lo]);
      else                   stepBy(1);   // past last edge — nudge
    } else {
      // Previous edge: the largest edge strictly less than `cur`.
      let prev = lo - 1;
      // Skip equal values so we actually move.
      while (prev >= 0 && edges[prev] >= cur) prev -= 1;
      if (prev >= 0) setCycleGlobal(edges[prev]);
      else           stepBy(-1);
    }
  }, [stepBy]);

  const goToCycle = useCallback((n: number) => setCycleGlobal(n), []);

  const goToCyclePrompt = useCallback((message?: string) => {
    const raw = window.prompt(message ?? `Go to cycle (0–${cursorState.totalCycles})`,
                              String(cursorState.cycle));
    if (raw == null) return;
    const parsed = parseInt(raw.trim(), 10);
    if (Number.isNaN(parsed)) return;
    setCycleGlobal(parsed);
  }, []);

  const setTotalCycles = useCallback((total: number) => setTotalCyclesGlobal(total), []);

  return useMemo<CycleCursor>(() => ({
    cycle:        snap.cycle,
    totalCycles:  snap.totalCycles,
    setCycle,
    stepBy,
    stepEdge,
    goToCycle,
    goToCyclePrompt,
    setTotalCycles,
  }), [snap, setCycle, stepBy, stepEdge, goToCycle, goToCyclePrompt, setTotalCycles]);
}

// ─── Keyboard helper — wires the common panel bindings in one place ─────────

/**
 * Attaches cycle-cursor key bindings to the supplied root element's
 * keydown events (not window-wide, so per-panel focus wins).  Bindings:
 *
 *   ArrowRight / ArrowLeft  → stepEdge(+1 / -1)   with `edges` if supplied
 *   Shift + Arrow           → stepBy(+1 / -1)
 *   .                       → stepEdge(+1)
 *   ,                       → stepEdge(-1)
 *   Ctrl+G or g             → goToCyclePrompt()
 *
 * The element must be focusable (usually `tabIndex={0}` on the host).
 * Returns a cleanup function for `useEffect`.
 */
export function attachCycleKeybindings(
  el: HTMLElement | null,
  cursor: CycleCursor,
  getEdges?: () => number[] | undefined,
): () => void {
  if (!el) return () => {};
  const onKey = (e: KeyboardEvent) => {
    // Don't hijack keys while the user is typing in a child input.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      // Exception: allow Ctrl+G even inside inputs — consistent with
      // Verdi / Surfer. Block plain "g" because the user may be typing.
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "g") return;
    }

    const shift = e.shiftKey;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (shift) cursor.stepBy(1);
      else       cursor.stepEdge(1, getEdges?.());
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (shift) cursor.stepBy(-1);
      else       cursor.stepEdge(-1, getEdges?.());
      return;
    }
    if (e.key === ".") {
      e.preventDefault();
      cursor.stepEdge(1, getEdges?.());
      return;
    }
    if (e.key === ",") {
      e.preventDefault();
      cursor.stepEdge(-1, getEdges?.());
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && !e.shiftKey) {
      e.preventDefault();
      cursor.goToCyclePrompt();
      return;
    }
    // Plain "g" (no modifiers) also triggers the prompt, Verdi-style.
    if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      cursor.goToCyclePrompt();
      return;
    }
  };
  el.addEventListener("keydown", onKey);
  return () => el.removeEventListener("keydown", onKey);
}

/** Compact numeric "Go to cycle" input ref setup — exported so the
 *  four panels can mount a uniform control in their toolbar with a
 *  single line of tsx.  Kept as a hook so the textbox shares the
 *  cursor's totalCycles clamp + Enter-to-commit contract. */
export function useGoToCycleInput(cursor: CycleCursor): {
  value:    string;
  setValue: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  commit:   () => void;
} {
  const [value, setValue] = useState("");
  const commit = useCallback(() => {
    const v = value.trim();
    if (v === "") return;
    const parsed = parseInt(v, 10);
    if (Number.isNaN(parsed)) return;
    cursor.goToCycle(parsed);
    setValue("");
  }, [value, cursor]);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  }, [commit]);
  return { value, setValue, onKeyDown, commit };
}

// ─── Test-only escape hatch ─────────────────────────────────────────────────
// Panel unit tests (jsdom / vitest) can reach in to reset the shared
// cursor state between specs; left as a named export so production
// code can grep for any accidental use.
export function __resetCycleCursorForTests__(): void {
  cursorState = { cycle: 0, totalCycles: 1024 };
  listeners.forEach(l => l(cursorState));
}

// ─── Ref-based helper for sites that don't want the re-render cost ──────────
/** Returns a ref that mirrors the current cursor without triggering
 *  React re-renders. Use inside Canvas2D draw loops where the cycle is
 *  sampled once per RAF tick, not once per React commit. */
export function useCycleCursorRef(): React.MutableRefObject<CycleCursorSnapshot> {
  const ref = useRef<CycleCursorSnapshot>(cursorState);
  useEffect(() => {
    const fn: Listener = s => { ref.current = s; };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return ref;
}
