import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createRafScheduler, type RafScheduler } from "./useRafScheduler";

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

// ─── RegisterSnapshot IPC types ─────────────────────────────────────────────
// Mirrors `pccx_core::step_snapshot::{CoreState, RegisterSnapshot}`.
// Field names match Rust serde defaults (snake_case).

export interface CoreState {
  core_id:          number;
  event_type_id:    number;
  event_start:      number;
  cycles_remaining: number;
}

export interface RegisterSnapshot {
  cycle:          number;
  total_cycles:   number;
  cores:          CoreState[];
  mac_active:     number;
  dma_active:     number;
  stall_active:   number;
  barrier_active: number;
  events_retired: number;
}

type Listener = (s: CycleCursorSnapshot) => void;

let cursorState: CycleCursorSnapshot = { cycle: 0, totalCycles: 1024 };
const listeners = new Set<Listener>();

// ─── IPC debounce + LRU cache (module-level, shared across panels) ──────────
// The IPC machinery is global because the cursor is global — N mounted
// panels scrubbing the same cycle must coalesce into a single invoke,
// not N redundant round-trips.
//
// Cache: Map<cycle, RegisterSnapshot>.  Insertion-order iteration gives
// FIFO eviction (not true LRU — lookups don't promote), which is close
// enough for the slider scrub pattern where locality is temporal and
// the oldest entry is almost always the coldest.
// 128 entries * ~1 KB JSON ≈ 128 KB — negligible.

const MAX_SNAPSHOT_CACHE = 128;
const snapshotCache = new Map<number, RegisterSnapshot>();
let snapshotState: RegisterSnapshot | null = null;
let snapshotLoading = false;

// Monotonic generation counter — guards against out-of-order IPC
// completions when the user scrubs faster than the round-trip latency.
let ipcGeneration = 0;

type SnapshotListener = (s: RegisterSnapshot | null, loading: boolean) => void;
const snapshotListeners = new Set<SnapshotListener>();

function emitSnapshot(s: RegisterSnapshot | null, loading: boolean) {
  snapshotState = s;
  snapshotLoading = loading;
  for (const l of snapshotListeners) l(s, loading);
}

// Module-level RAF scheduler — coalesces rapid setCycle calls into one
// IPC per animation frame.  Created lazily (SSR / test safety) and
// never disposed because the cursor outlives every component.
let ipcScheduler: RafScheduler | null = null;
function getIpcScheduler(): RafScheduler {
  if (!ipcScheduler) ipcScheduler = createRafScheduler();
  return ipcScheduler;
}

/** Schedule a debounced `step_to_cycle` IPC for the given cycle.
 *  Called automatically whenever the shared cursor moves. */
function scheduleSnapshotFetch(cycle: number) {
  // Bump generation on every cursor move — including cache hits — so
  // any older in-flight IPC is orphaned when it completes. Without
  // this, a cache-hit at cycle 0 followed by a late IPC-100 return
  // would overwrite the snapshot with stale cycle-100 data.
  const gen = ++ipcGeneration;

  // Cache hit — serve immediately, skip IPC entirely.
  const cached = snapshotCache.get(cycle);
  if (cached) {
    emitSnapshot(cached, false);
    return;
  }
  emitSnapshot(snapshotState, true);

  getIpcScheduler().schedule("cycle-cursor-ipc", async () => {
    try {
      const result = await invoke<RegisterSnapshot>("step_to_cycle", { cycle });
      // Drop if the cursor moved on while the IPC was in flight.
      if (gen !== ipcGeneration) return;
      // LRU eviction — delete the oldest entry (first key in insertion order).
      if (snapshotCache.size >= MAX_SNAPSHOT_CACHE) {
        const oldest = snapshotCache.keys().next().value;
        if (oldest !== undefined) snapshotCache.delete(oldest);
      }
      snapshotCache.set(cycle, result);
      emitSnapshot(result, false);
      // Prefetch adjacent cycles for smooth scrubbing
      const PREFETCH_RADIUS = 4;
      for (let d = -PREFETCH_RADIUS; d <= PREFETCH_RADIUS; d++) {
        if (d === 0) continue;
        const adj = cycle + d;
        if (adj < 0 || adj > cursorState.totalCycles) continue;
        if (snapshotCache.has(adj)) continue;
        invoke<RegisterSnapshot>("step_to_cycle", { cycle: adj })
          .then(r => {
            if (snapshotCache.size >= MAX_SNAPSHOT_CACHE) {
              const oldest = snapshotCache.keys().next().value;
              if (oldest !== undefined) snapshotCache.delete(oldest);
            }
            snapshotCache.set(adj, r);
          })
          .catch(() => {});
      }
    } catch (e) {
      if (gen !== ipcGeneration) return;
      console.error("[useCycleCursor] step_to_cycle IPC failed:", e);
      emitSnapshot(null, false);
    }
  });
}

function emit(next: CycleCursorSnapshot) {
  // Re-create the object so React `useSyncExternalStore`-ish equality
  // checks always see a new reference; cheap — just two numbers.
  cursorState = { cycle: next.cycle, totalCycles: next.totalCycles };
  for (const l of listeners) l(cursorState);
  // Trigger debounced IPC for the new cycle.
  scheduleSnapshotFetch(next.cycle);
}

function setCycleGlobal(next: number) {
  // Integer snap + clamp. Negative inputs snap to 0, overshoot snaps
  // to totalCycles so the "go to cycle N" flow never dead-ends.
  const n = Math.max(0, Math.min(Math.round(next), cursorState.totalCycles));
  if (n === cursorState.cycle) return;
  emit({ cycle: n, totalCycles: cursorState.totalCycles });
}

function clearSnapshotCache() {
  snapshotCache.clear();
  ipcGeneration++;
}

function setTotalCyclesGlobal(total: number) {
  const t = Math.max(1, Math.floor(total));
  clearSnapshotCache();
  const nextCycle = Math.min(cursorState.cycle, t);
  if (nextCycle === cursorState.cycle && t === cursorState.totalCycles) return;
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
  /** Cached register-level snapshot for the current cycle (from
   *  `step_to_cycle` IPC). `null` before the first fetch or on error. */
  snapshot:        RegisterSnapshot | null;
  /** `true` while a `step_to_cycle` IPC is in flight for the current
   *  cycle. Cache hits never set this — only wire round-trips. */
  snapshotLoading: boolean;
}

export function useCycleCursor(): CycleCursor {
  const [snap, setSnap] = useState<CycleCursorSnapshot>(cursorState);
  const [ipcSnap, setIpcSnap] = useState<RegisterSnapshot | null>(snapshotState);
  const [ipcLoading, setIpcLoading] = useState(snapshotLoading);

  useEffect(() => {
    const fn: Listener = s => setSnap(s);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  useEffect(() => {
    const fn: SnapshotListener = (s, loading) => {
      setIpcSnap(s);
      setIpcLoading(loading);
    };
    snapshotListeners.add(fn);
    return () => { snapshotListeners.delete(fn); };
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
    cycle:           snap.cycle,
    totalCycles:     snap.totalCycles,
    setCycle,
    stepBy,
    stepEdge,
    goToCycle,
    goToCyclePrompt,
    setTotalCycles,
    snapshot:        ipcSnap,
    snapshotLoading: ipcLoading,
  }), [snap, setCycle, stepBy, stepEdge, goToCycle, goToCyclePrompt, setTotalCycles, ipcSnap, ipcLoading]);
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
  snapshotCache.clear();
  snapshotState = null;
  snapshotLoading = false;
  ipcGeneration = 0;
  snapshotListeners.forEach(l => l(null, false));
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
