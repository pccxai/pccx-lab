import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

// Mirror of `pccx_core::live_window::LiveSample` (see
// `src/core/src/live_window.rs`). Values are normalised 0..1.
export interface LiveSample {
  ts_ns:     number;
  mac_util:  number;
  dma_bw:    number;
  stall_pct: number;
}

export interface LiveWindowSnapshot {
  samples:  LiveSample[];
  hasTrace: boolean;
}

// ─── Module-level store ──────────────────────────────────────────────────────
// A single `fetch_live_window` poller fans out to every subscriber via
// `useSyncExternalStore` so React 19 concurrent rendering cannot observe
// a half-updated array (tearing).  One consumer ⇒ one IPC call / 500 ms.

const EMPTY: LiveWindowSnapshot = Object.freeze({ samples: [], hasTrace: false });

let snapshot: LiveWindowSnapshot       = EMPTY;
let timer:    ReturnType<typeof setInterval> | null = null;
let emptyStreak = 0;
const listeners = new Set<() => void>();

function emit(next: LiveWindowSnapshot) {
  snapshot = next;
  for (const fn of listeners) fn();
}

async function poll() {
  try {
    const rows: LiveSample[] = await invoke("fetch_live_window", { windowCycles: 256 });
    if (rows.length === 0) {
      emptyStreak += 1;
      // Yuan OSDI 2014 loud fallback — three consecutive empty polls
      // signal a stuck producer or unloaded trace.  Warn once per streak
      // boundary so the console does not drown.
      if (emptyStreak === 3) {
        // eslint-disable-next-line no-console
        console.warn(
          "[useLiveWindow] fetch_live_window returned empty 3× in a row — " +
          "no trace loaded or producer stalled (Yuan OSDI 2014 loud fallback).",
        );
      }
      emit(EMPTY);
    } else {
      emptyStreak = 0;
      emit({ samples: rows, hasTrace: true });
    }
  } catch {
    emptyStreak += 1;
    emit(EMPTY);
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (timer === null) {
    // 2 Hz cadence matches BottomPanel / PerfChart / Roofline (R4 T-1).
    void poll();
    timer = setInterval(poll, 500);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      emptyStreak = 0;
      snapshot = EMPTY;
    }
  };
}

function getSnapshot(): LiveWindowSnapshot { return snapshot; }
// SSR / first-render path — Tauri never SSRs, but React 19 still
// checks the shape during hydration, so we must return a stable ref.
function getServerSnapshot(): LiveWindowSnapshot { return EMPTY; }

/**
 * React hook for the live telemetry window.  Polls `fetch_live_window`
 * at 2 Hz via a module-level store; uses `useSyncExternalStore` so
 * concurrent renders cannot tear across a sample update.
 */
export function useLiveWindow(): LiveWindowSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
