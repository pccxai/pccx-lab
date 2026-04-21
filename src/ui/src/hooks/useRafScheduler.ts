import { useEffect, useMemo, useRef } from "react";

/* ─────────────────────────────────────────────────────────────────────
 * useRafScheduler — RAF-coalesced draw queue
 *
 * Rationale. Mouse-move handlers on Canvas2D panels (Timeline,
 * FlameGraph, WaveformViewer) fire 60-120 times per second on a
 * high-polling-rate mouse. Calling `draw()` synchronously on every
 * event pegs the main thread past 16 ms per frame — the exact jank the
 * user called out as "System Simulator lag" in Round-6 directive #3.
 *
 * The fix is the Perfetto "raf-scheduler" idiom: schedule a dirty flag,
 * coalesce many `schedule(fn)` calls into a single `requestAnimationFrame`
 * callback, and run one draw per frame in insertion order. When the same
 * `key` is re-scheduled inside a frame, the LATEST fn wins — stale
 * closures never fire.
 *
 * References:
 *   - Perfetto UI raf-scheduler (https://perfetto.dev/docs/contributing/ui-plugins)
 *   - MDN Window.requestAnimationFrame — auto-throttles in hidden tabs
 *     (https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
 *
 * Test shape. This module is a pure TS factory: `createRafScheduler()`
 * returns `{ schedule, cancel, dispose, flushSync }`. The React hook
 * `useRafScheduler()` only wraps lifetime. See
 *   src/ui/src/hooks/__tests__/useRafScheduler.test.ts
 * for the JSDoc-level expected behaviour; a real Vitest spec is added
 * once the Round-7 test harness lands.
 *
 * @example
 *   const sched = useRafScheduler();
 *   const onMouseMove = () => sched.schedule("timeline", () => draw());
 *   // later:
 *   sched.cancel("timeline"); // drop pending draw
 * ─────────────────────────────────────────────────────────────────── */

export interface RafScheduler {
    /** Queue a draw for the next RAF tick. Repeated calls in the same
     *  frame keep only the LATEST fn per `key`. */
    schedule: (key: string, fn: () => void) => void;
    /** Drop a pending draw by key. Idempotent. */
    cancel:   (key: string) => void;
    /** Tear down the scheduler; any in-flight RAF is cancelled and the
     *  queue cleared. Safe to call more than once. */
    dispose:  () => void;
    /** For tests only — run every queued fn immediately and clear the
     *  queue. Do NOT call from production render paths; it defeats the
     *  whole point of coalescing. */
    flushSync: () => void;
}

export function createRafScheduler(): RafScheduler {
    const queue = new Map<string, () => void>();
    let rafId: number | null = null;
    let disposed = false;

    // Fallback for jsdom / SSR where requestAnimationFrame may be
    // absent: use a 16 ms timeout so unit tests still exercise the
    // coalescing contract. Production always has RAF.
    const raf: (cb: FrameRequestCallback) => number =
        typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
    const caf: (id: number) => void =
        typeof cancelAnimationFrame === "function"
            ? cancelAnimationFrame
            : (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

    const flush = () => {
        rafId = null;
        if (disposed) return;
        // Snapshot + clear BEFORE running — a draw fn that re-schedules
        // its own key must land on the NEXT frame, not merge into this
        // one (that would create an infinite loop).
        const pending = Array.from(queue.values());
        queue.clear();
        for (const fn of pending) {
            try { fn(); }
            catch (err) { console.error("[raf-scheduler] draw threw:", err); }
        }
    };

    const schedule = (key: string, fn: () => void) => {
        if (disposed) return;
        queue.set(key, fn);
        if (rafId == null) rafId = raf(flush);
    };

    const cancel = (key: string) => {
        queue.delete(key);
        if (queue.size === 0 && rafId != null) {
            caf(rafId);
            rafId = null;
        }
    };

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        queue.clear();
        if (rafId != null) {
            caf(rafId);
            rafId = null;
        }
    };

    const flushSync = () => {
        if (rafId != null) { caf(rafId); rafId = null; }
        const pending = Array.from(queue.values());
        queue.clear();
        for (const fn of pending) fn();
    };

    return { schedule, cancel, dispose, flushSync };
}

/** React lifecycle wrapper — returns a stable scheduler tied to the
 *  component's mount/unmount. Schedules are cancelled on unmount so
 *  unmounted components never paint. */
export function useRafScheduler(): RafScheduler {
    const ref = useRef<RafScheduler | null>(null);
    // Memoise so every render sees the same instance.
    const scheduler = useMemo(() => {
        const s = createRafScheduler();
        ref.current = s;
        return s;
    }, []);

    useEffect(() => {
        return () => { ref.current?.dispose(); };
    }, []);

    return scheduler;
}
