import { useEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────────────────
 * useVisibilityGate — pause RAF loops when the panel isn't actually
 * painted to the user.
 *
 * Two signals combined with AND:
 *
 *   1. `document.visibilityState === "visible"` (MDN Page Visibility
 *      API). The browser already auto-throttles the main-thread RAF
 *      when the tab is hidden, but our Three.js CanvasView may hold a
 *      WebGL queue that still pushes GPU work — we must bail before
 *      touching `renderer.render()`.
 *
 *   2. `IntersectionObserver` on the host element. Docked panels that
 *      are mounted but off-screen (e.g. below-the-fold or behind a
 *      collapsed split) should stop repainting, exactly like Apple
 *      Instruments pauses its timeline when the panel is collapsed.
 *
 * References:
 *   - MDN Page Visibility API
 *     (https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
 *   - W3C Page Visibility Level 2
 *     (https://w3c.github.io/page-visibility/)
 *   - MDN IntersectionObserver
 *     (https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver)
 *
 * API shape:
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   const visible = useVisibilityGate(ref);
 *   useEffect(() => {
 *     if (!visible) return;
 *     const id = requestAnimationFrame(tick);
 *     return () => cancelAnimationFrame(id);
 *   }, [visible]);
 *
 * The returned boolean is `true` iff BOTH signals are true. When the
 * ref is null (panel not yet mounted) the default is `true` so the
 * first frame can paint; once the observer attaches, the real signal
 * takes over.
 *
 * The hook is inert in SSR / jsdom: `document` missing → `true`,
 * `IntersectionObserver` missing → just the document-visibility signal.
 * ─────────────────────────────────────────────────────────────────── */

export function useVisibilityGate(
    elRef: React.RefObject<HTMLElement | null>,
    options: IntersectionObserverInit = { threshold: 0.01 },
): boolean {
    // SSR-safe defaults — pretend visible until we can measure.
    const initialDocVisible =
        typeof document !== "undefined"
            ? document.visibilityState === "visible"
            : true;
    const [docVisible, setDocVisible]   = useState(initialDocVisible);
    const [intersects, setIntersects]   = useState(true);

    // Document-level visibility — window.addEventListener avoids a
    // stale-closure problem if the component re-renders.
    useEffect(() => {
        if (typeof document === "undefined") return;
        const onVis = () => setDocVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", onVis);
        // Sync once on mount in case we missed the initial event.
        onVis();
        return () => document.removeEventListener("visibilitychange", onVis);
    }, []);

    // IntersectionObserver — observes the host element. Missing IO
    // (rare outside SSR) collapses to "always intersects".
    const observedRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const el = elRef.current;
        if (!el) return;
        if (typeof IntersectionObserver === "undefined") {
            setIntersects(true);
            return;
        }
        observedRef.current = el;
        const obs = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.target === el) setIntersects(entry.isIntersecting);
            }
        }, options);
        obs.observe(el);
        return () => {
            obs.disconnect();
            observedRef.current = null;
        };
        // options is intentionally stable via default; we deliberately
        // don't list it to avoid re-observing on every parent render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [elRef]);

    return docVisible && intersects;
}
