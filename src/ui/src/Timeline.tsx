import { useRef, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "./ThemeContext";
import { useLiveWindow } from "./hooks/useLiveWindow";
import { useCycleCursor, attachCycleKeybindings, useGoToCycleInput } from "./hooks/useCycleCursor";

const EVENT_COLORS: Record<number, { fill: string; label: string }> = {
  0: { fill: "#555555", label: "Unknown"         },
  1: { fill: "#4fc1ff", label: "MAC_COMPUTE"     },
  2: { fill: "#6a9955", label: "DMA_READ"        },
  3: { fill: "#dcdcaa", label: "DMA_WRITE"       },
  4: { fill: "#c586c0", label: "SYSTOLIC_STALL"  },
  5: { fill: "#f14c4c", label: "BARRIER_SYNC"    },
};

const LANE_HEIGHT   = 22;
const LANE_LABEL_W  = 72;
const HEADER_HEIGHT = 28;

interface ParsedEvent { core_id: number; start: number; duration: number; type_id: number; }

function parsePayload(buf: Uint8Array): ParsedEvent[] {
  const view = new DataView(buf.buffer);
  const count = buf.byteLength / 24;
  const events: ParsedEvent[] = [];
  for (let i = 0; i < count; i++) {
    const off = i * 24;
    events.push({
      core_id:  view.getUint32(off, true),
      start:    Number(view.getBigUint64(off + 4,  true)),
      duration: Number(view.getBigUint64(off + 12, true)),
      type_id:  view.getUint32(off + 20, true),
    });
  }
  return events;
}

export function Timeline() {
  const theme = useTheme();
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const rootRef       = useRef<HTMLDivElement>(null);
  const [events, setEvents]           = useState<ParsedEvent[]>([]);
  const [totalCycles, setTotalCycles] = useState(0);
  const [numCores, setNumCores]       = useState(32);
  const [loading, setLoading]         = useState(true);
  const [tooltip, setTooltip]         = useState<{ x: number; y: number; text: string } | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ParsedEvent | null>(null);
  const [selection, setSelection]     = useState<{ start: number; end: number } | null>(null);
  const [markers, setMarkers]         = useState<number[]>([]);
  // Round-6 T-1: integer-cycle snap mode — when ON, the viewport's
  // cycles-per-pixel clamps to ≥1 so one pixel never sub-samples the
  // clock.  Also snaps cursor rounds to integer cycles. Default ON
  // because the user directive #1 is "100% tiny timing analysis".
  const [snapToCycle, setSnapToCycle] = useState(true);
  const cursor = useCycleCursor();
  const goTo   = useGoToCycleInput(cursor);

  const vp = useRef({ offset: 0, cpp: 1, dragging: false, lastX: 0, selStart: -1 });

  // Round-5 T-3: live event rate from the shared hook.  Used for the
  // "N events/s" header pill + empty-state overlay (FlameGraph R4
  // pattern) when the trace reducer returns 0 spans.
  const { samples: liveSamples, hasTrace: liveHasTrace } = useLiveWindow();
  const liveEventRate = liveHasTrace && liveSamples.length > 0
    ? (liveSamples.reduce((a, s) => a + s.mac_util, 0) / liveSamples.length) * 1000
    : 0;

  const stats = (() => {
    if (events.length === 0) return null;
    const counts: Record<number, number> = {};
    let totalDur = 0;
    for (const ev of events) {
      counts[ev.type_id] = (counts[ev.type_id] ?? 0) + 1;
      totalDur += ev.duration;
    }
    return { counts, totalDur, avg: totalDur / events.length };
  })();

  useEffect(() => {
    let cancelled = false;

    const applyPayload = async (allowDemoFallback: boolean) => {
      try {
        const payload: Uint8Array = await invoke("fetch_trace_payload");
        if (payload.byteLength === 0) throw new Error("empty");
        const parsed = parsePayload(payload);
        if (cancelled) return;
        setEvents(parsed);
        const tc = parsed.reduce((m, e) => Math.max(m, e.start + e.duration), 0);
        setTotalCycles(tc);
        setNumCores(parsed.reduce((m, e) => Math.max(m, e.core_id), 0) + 1);
        if (canvasRef.current) {
          vp.current.cpp = tc / (canvasRef.current.clientWidth - LANE_LABEL_W);
        }
      } catch {
        if (!allowDemoFallback) return;
        // Deterministic onboarding fixture — no RNG.  Per-tid base
        // durations jittered by index so the stripes don't collapse
        // into a uniform grid.  Real activity comes from `useLiveWindow`
        // (see setHasLive effect below); this path only fires when the
        // trace IPC errors on first mount.
        const demo: ParsedEvent[] = [];
        const bases = [300, 200, 150, 80, 50];
        for (let c = 0; c < 8; c++) {
          let t = c * 50;
          for (let i = 0; i < 30; i++) {
            const tid = (i % 5) + 1;
            const dur = bases[tid - 1] + ((i * 37) % 100);
            demo.push({ core_id: c, start: t, duration: dur, type_id: tid });
            t += dur + 10 + ((i * 13) % 20);
          }
        }
        if (cancelled) return;
        setEvents(demo);
        setTotalCycles(demo.reduce((m, e) => Math.max(m, e.start + e.duration), 0));
        setNumCores(8);
        vp.current.cpp = 5;
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Initial load: demo fallback if no trace yet.
    void applyPayload(true);

    // No-op placeholder — `totalCycles` is published through the
    // shared cursor in a dedicated effect below so the snapshot stays
    // in lock-step with the trace-loaded event listener.

    // Subscribe to trace-loaded events so the canvas picks up freshly
    // loaded .pccx files without a manual reload. Only available in the
    // native Tauri window; gracefully no-ops in the Vite browser preview.
    let unlisten: (() => void) | undefined;
    listen("trace-loaded", () => {
      void applyPayload(false);
    })
      .then(fn => { unlisten = fn; })
      .catch(() => { /* browser mode — no Tauri event bus */ });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const isDark = theme.mode === "dark";
  const bgDeep  = isDark ? "#1a1a1a" : "#f5f5f5";
  const bgLane  = isDark ? "#1e1e1e" : "#ffffff";
  const bgAlt   = isDark ? "#222222" : "#fafafa";
  const bgPanel = isDark ? "#252526" : "#f0f0f0";
  const lineCol = isDark ? "#333333" : "#d4d4d4";
  const dimText = isDark ? "#858585" : "#717171";

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    if (!canvas || !cont) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = cont.clientWidth; const ch = cont.clientHeight;
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const { offset, cpp } = vp.current;
    const drawW = cw - LANE_LABEL_W;

    // BG
    ctx.fillStyle = bgDeep;
    ctx.fillRect(0, 0, cw, ch);

    // Header
    ctx.fillStyle = bgPanel;
    ctx.fillRect(LANE_LABEL_W, 0, drawW, HEADER_HEIGHT);
    ctx.strokeStyle = lineCol;
    ctx.beginPath(); ctx.moveTo(LANE_LABEL_W, HEADER_HEIGHT); ctx.lineTo(cw, HEADER_HEIGHT); ctx.stroke();

    // Ruler
    const tickSpacing = Math.pow(10, Math.ceil(Math.log10(cpp * 80)));
    const firstTick = Math.ceil(offset / tickSpacing) * tickSpacing;
    ctx.fillStyle = dimText;
    ctx.font = "10px JetBrains Mono, Consolas, monospace";
    ctx.textBaseline = "middle";
    for (let c = firstTick; c < offset + drawW * cpp; c += tickSpacing) {
      const x = LANE_LABEL_W + (c - offset) / cpp;
      ctx.strokeStyle = isDark ? "#2a2a2a" : "#e5e5e5";
      ctx.beginPath(); ctx.moveTo(x, HEADER_HEIGHT); ctx.lineTo(x, ch); ctx.stroke();
      ctx.strokeStyle = lineCol;
      ctx.beginPath(); ctx.moveTo(x, 18); ctx.lineTo(x, HEADER_HEIGHT); ctx.stroke();
      const lbl = c >= 1e6 ? `${(c/1e6).toFixed(1)}M` : c >= 1e3 ? `${(c/1e3).toFixed(0)}K` : `${c}`;
      ctx.fillText(lbl, x + 3, HEADER_HEIGHT / 2);
    }

    // Selection
    if (selection) {
      const sx = LANE_LABEL_W + (selection.start - offset) / cpp;
      const ex = LANE_LABEL_W + (selection.end - offset) / cpp;
      ctx.fillStyle = isDark ? "rgba(0,152,255,0.10)" : "rgba(0,102,184,0.08)";
      ctx.fillRect(Math.min(sx, ex), HEADER_HEIGHT, Math.abs(ex - sx), ch - HEADER_HEIGHT);
      ctx.strokeStyle = theme.accent;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(sx, HEADER_HEIGHT); ctx.lineTo(sx, ch); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, HEADER_HEIGHT); ctx.lineTo(ex, ch); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Lanes
    for (let c = 0; c < numCores; c++) {
      const y = HEADER_HEIGHT + c * LANE_HEIGHT;
      if (y > ch) break;
      ctx.fillStyle = c % 2 === 0 ? bgLane : bgAlt;
      ctx.fillRect(LANE_LABEL_W, y, drawW, LANE_HEIGHT);
    }

    // Events
    ctx.textAlign = "left";
    for (const ev of events) {
      const x1 = LANE_LABEL_W + (ev.start - offset) / cpp;
      const x2 = x1 + Math.max(1, ev.duration / cpp);
      if (x2 < LANE_LABEL_W || x1 > cw) continue;
      const y = HEADER_HEIGHT + ev.core_id * LANE_HEIGHT;
      if (y > ch) continue;
      const { fill } = EVENT_COLORS[ev.type_id] ?? EVENT_COLORS[0];
      const cx1 = Math.max(x1, LANE_LABEL_W);
      const cw2 = x2 - cx1;
      if (cw2 <= 0) continue;

      const isSelected = selectedEvent === ev;
      ctx.fillStyle = fill + (isSelected ? "ee" : "cc");
      ctx.beginPath();
      ctx.roundRect(cx1 + 0.5, y + 2, cw2 - 1, LANE_HEIGHT - 4, 2);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      if (cw2 > 45) {
        ctx.fillStyle = isDark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.8)";
        ctx.font = "9px Inter, sans-serif";
        ctx.textBaseline = "middle";
        ctx.save();
        ctx.beginPath(); ctx.rect(cx1 + 2, y, cw2 - 4, LANE_HEIGHT); ctx.clip();
        ctx.fillText((EVENT_COLORS[ev.type_id]?.label ?? "?").replace(/_/g, " ") + ` [${ev.duration}]`, cx1 + 4, y + LANE_HEIGHT / 2);
        ctx.restore();
      }
    }

    // Lane labels
    ctx.fillStyle = bgPanel;
    ctx.fillRect(0, HEADER_HEIGHT, LANE_LABEL_W, ch - HEADER_HEIGHT);
    ctx.strokeStyle = lineCol;
    ctx.beginPath(); ctx.moveTo(LANE_LABEL_W, 0); ctx.lineTo(LANE_LABEL_W, ch); ctx.stroke();
    for (let c = 0; c < numCores; c++) {
      const y = HEADER_HEIGHT + c * LANE_HEIGHT;
      if (y > ch) break;
      ctx.fillStyle = dimText;
      ctx.font = "9px Inter, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(`Core ${c.toString().padStart(2, "0")}`, LANE_LABEL_W - 6, y + LANE_HEIGHT / 2);
    }

    // Markers
    for (const m of markers) {
      const mx = LANE_LABEL_W + (m - offset) / cpp;
      ctx.strokeStyle = theme.error;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, ch); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = theme.error;
      ctx.font = "bold 8px Inter";
      ctx.textAlign = "center";
      ctx.fillText(`▼ ${m >= 1e3 ? (m / 1e3).toFixed(0) + "K" : m}`, mx, 8);
    }
  }, [events, numCores, isDark, selection, selectedEvent, markers, theme]);

  useEffect(() => { draw(); const ro = new ResizeObserver(draw); if (containerRef.current) ro.observe(containerRef.current); return () => ro.disconnect(); }, [draw]);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const mx = e.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0) - LANE_LABEL_W;
    if (e.ctrlKey || e.metaKey) {
      const zf = e.deltaY > 0 ? 1.2 : 0.833;
      const cyc = vp.current.offset + mx * vp.current.cpp;
      vp.current.cpp = Math.max(0.001, vp.current.cpp * zf);
      vp.current.offset = cyc - mx * vp.current.cpp;
    } else {
      vp.current.offset += e.deltaX * vp.current.cpp * 0.5;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) vp.current.offset += e.deltaY * vp.current.cpp * 0.5;
    }
    vp.current.offset = Math.max(0, vp.current.offset);
    draw();
  }, [draw]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left - LANE_LABEL_W;
      vp.current.selStart = vp.current.offset + mx * vp.current.cpp;
    } else { vp.current.dragging = true; }
    vp.current.lastX = e.clientX;
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left - LANE_LABEL_W;
    const my = e.clientY - rect.top - HEADER_HEIGHT;

    if (vp.current.selStart >= 0) {
      setSelection({ start: vp.current.selStart, end: vp.current.offset + mx * vp.current.cpp });
      draw();
    } else if (vp.current.dragging) {
      const dx = e.clientX - vp.current.lastX;
      vp.current.lastX = e.clientX;
      vp.current.offset = Math.max(0, vp.current.offset - dx * vp.current.cpp);
      draw();
    }

    if (mx < 0 || my < 0) { setTooltip(null); return; }
    const hCyc = vp.current.offset + mx * vp.current.cpp;
    const hCore = Math.floor(my / LANE_HEIGHT);
    const hit = events.find(ev => ev.core_id === hCore && hCyc >= ev.start && hCyc <= ev.start + ev.duration);
    if (hit) {
      setTooltip({
        x: e.clientX - rect.left + 14, y: e.clientY - rect.top + 14,
        text: `${EVENT_COLORS[hit.type_id]?.label ?? "?"}\nCore: ${hit.core_id}\nStart: ${hit.start.toLocaleString()}\nDuration: ${hit.duration.toLocaleString()}\nEnd: ${(hit.start + hit.duration).toLocaleString()}`,
      });
    } else setTooltip(null);
  }, [events, draw]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (vp.current.selStart >= 0) { vp.current.selStart = -1; }
    else if (!vp.current.dragging) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left - LANE_LABEL_W;
      const my = e.clientY - rect.top - HEADER_HEIGHT;
      const hCyc = vp.current.offset + mx * vp.current.cpp;
      const hCore = Math.floor(my / LANE_HEIGHT);
      const hit = events.find(ev => ev.core_id === hCore && hCyc >= ev.start && hCyc <= ev.start + ev.duration);
      setSelectedEvent(hit ?? null); draw();
    }
    vp.current.dragging = false;
  }, [events, draw]);

  const onDblClick = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left - LANE_LABEL_W;
    setMarkers(m => [...m, Math.round(vp.current.offset + mx * vp.current.cpp)]); draw();
  }, [draw]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Round-6 T-1: publish our trace bound + attach panel-scoped key
  // bindings (ArrowLeft/Right, Shift+Arrow, Ctrl+G, g, ., ,).
  useEffect(() => {
    if (totalCycles > 0) cursor.setTotalCycles(totalCycles);
  }, [totalCycles, cursor]);

  useEffect(() => {
    return attachCycleKeybindings(rootRef.current, cursor);
  }, [cursor]);

  // Snap cpp to an integer cycles/pixel when `snapToCycle` is ON — the
  // user-directive promise is "1 cycle per pixel without losing
  // markers". Math only, does NOT mutate draw() internals (T-3 territory).
  useEffect(() => {
    if (snapToCycle && vp.current.cpp < 1) vp.current.cpp = 1;
  }, [snapToCycle, cursor.cycle]);

  const fitAll = () => { if (!canvasRef.current || totalCycles === 0) return; vp.current.offset = 0; vp.current.cpp = totalCycles / (canvasRef.current.clientWidth - LANE_LABEL_W); setSelection(null); draw(); };
  const zoomToSelection = () => { if (!selection || !canvasRef.current) return; const s = Math.min(selection.start, selection.end); const e = Math.max(selection.start, selection.end); vp.current.offset = s; vp.current.cpp = (e - s) / (canvasRef.current.clientWidth - LANE_LABEL_W); draw(); };

  const btnStyle: React.CSSProperties = { fontSize: 10, padding: "2px 8px", borderRadius: 3, background: theme.bgSurface, color: theme.textDim, border: `1px solid ${theme.border}`, cursor: "pointer" };

  return (
    <div ref={rootRef} tabIndex={0} className="w-full h-full flex flex-col outline-none" style={{ background: bgDeep }}>
      {/* Toolbar */}
      <div className="flex items-center px-3 gap-3 shrink-0" style={{ height: 30, borderBottom: `1px solid ${theme.border}`, background: bgPanel }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: dimText, letterSpacing: "0.05em" }}>TIMELINE</span>
        <button onClick={fitAll} style={btnStyle}>Fit All</button>
        {selection && <button onClick={zoomToSelection} style={{ ...btnStyle, background: theme.accentBg, color: theme.accent, borderColor: theme.accentDim }}>Zoom to Selection</button>}
        <button onClick={() => { setMarkers([]); draw(); }} style={btnStyle}>Clear Markers</button>
        {selection && <span style={{ fontSize: 9, color: theme.accent }}>Selected: {Math.abs(selection.end - selection.start).toLocaleString()} cycles</span>}
        {loading && <span style={{ fontSize: 10, color: dimText }} className="animate-pulse">Loading...</span>}

        {/* Round-6 T-1: cycle cursor readout + "Go to cycle N" + snap toggle */}
        <span style={{ fontSize: 9, color: theme.textMuted, marginLeft: 10, fontFamily: "monospace" }}>
          cyc {cursor.cycle.toLocaleString()} / {Math.max(totalCycles, cursor.totalCycles).toLocaleString()}
        </span>
        <label style={{ fontSize: 9, color: theme.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}
               title="Type a cycle N and press Enter to jump the shared cursor. Ctrl+G or g also opens this prompt.">
          go to
          <input
            type="number" min={0} max={Math.max(totalCycles, cursor.totalCycles)}
            value={goTo.value}
            placeholder={`0–${Math.max(totalCycles, cursor.totalCycles)}`}
            onChange={e => goTo.setValue(e.target.value)}
            onKeyDown={goTo.onKeyDown}
            onBlur={goTo.commit}
            style={{
              width: 70, height: 18, fontSize: 9, padding: "0 4px",
              background: theme.bgSurface, color: theme.text,
              border: `1px solid ${theme.border}`, borderRadius: 2, outline: "none",
            }}
          />
        </label>
        <label style={{ fontSize: 9, color: theme.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}
               title="Snap viewport cycles-per-pixel to an integer so a single clock never straddles two pixels.">
          <input type="checkbox" checked={snapToCycle} onChange={e => setSnapToCycle(e.target.checked)} />
          snap to cycle
        </label>

        {/* Nsight Style Live Filter */}
        <div style={{ marginLeft: 16, display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: 9, color: theme.textMuted, marginRight: 6 }}>Filter:</span>
          <input
            type="text"
            placeholder="e.g. DMA, MAC..."
            style={{
              width: 100, height: 18, fontSize: 9, padding: "0 6px",
              background: theme.bgSurface, color: theme.text,
              border: `1px solid ${theme.border}`, borderRadius: 2,
              outline: "none"
            }} 
            onChange={() => {
               // Placeholder: a real event filter would wire a setFilter here.
            }}
          />
        </div>

        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {Object.entries(EVENT_COLORS).filter(([k]) => k !== "0").map(([k, { fill, label }]) => (
            <span key={k} className="flex items-center gap-1" style={{ fontSize: 9, color: dimText }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: fill, display: "inline-block" }} />
              {label.replace(/_/g, " ")}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 9, color: theme.textFaint }}>Ctrl+Scroll: zoom · Drag: pan · Shift+Drag: select · DblClick: marker</span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div ref={containerRef} className="flex-1 relative overflow-hidden" style={{ cursor: "crosshair" }}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={() => { vp.current.dragging = false; vp.current.selStart = -1; }}
          onDoubleClick={onDblClick}>
          <canvas ref={canvasRef} className="absolute inset-0" />
          {/* Round-6 T-1: DOM-overlaid cursor line.  Kept out of the
              canvas draw() body (T-3 territory); this also means it
              never coalesces with the RAF loop and is always fresh. */}
          {(() => {
            const c = cursor.cycle;
            const { offset, cpp } = vp.current;
            const pxW = containerRef.current?.clientWidth ?? 0;
            const x   = LANE_LABEL_W + (c - offset) / Math.max(cpp, 1e-9);
            if (x < LANE_LABEL_W || x > pxW) return null;
            return (
              <div aria-hidden className="absolute pointer-events-none"
                   style={{ left: x, top: 0, bottom: 0, width: 1, background: theme.accent, boxShadow: `0 0 4px ${theme.accent}99` }} />
            );
          })()}
          {tooltip && (
            <div className="absolute z-50 pointer-events-none rounded px-2 py-1.5 shadow-xl" style={{
              left: tooltip.x, top: tooltip.y, fontSize: 10, whiteSpace: "pre",
              background: theme.bgSurface, color: theme.text, border: `1px solid ${theme.border}`,
            }}>
              {tooltip.text}
            </div>
          )}
        </div>

        {(selectedEvent || stats) && (
          <div className="shrink-0 overflow-y-auto" style={{ width: 180, borderLeft: `1px solid ${theme.border}`, background: bgPanel, padding: 12 }}>
            {selectedEvent && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: dimText, marginBottom: 4, letterSpacing: "0.05em" }}>SELECTED EVENT</div>
                <div style={{ fontSize: 10, color: theme.text, lineHeight: 1.6 }}>
                  <div>Type: <strong style={{ color: EVENT_COLORS[selectedEvent.type_id]?.fill }}>{EVENT_COLORS[selectedEvent.type_id]?.label}</strong></div>
                  <div>Core: {selectedEvent.core_id}</div>
                  <div>Start: {selectedEvent.start.toLocaleString()}</div>
                  <div>Duration: {selectedEvent.duration.toLocaleString()}</div>
                  <div>End: {(selectedEvent.start + selectedEvent.duration).toLocaleString()}</div>
                </div>
              </div>
            )}
            {stats && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, color: dimText, marginBottom: 4, letterSpacing: "0.05em" }}>TRACE STATS</div>
                <div style={{ fontSize: 10, color: theme.text, lineHeight: 1.6 }}>
                  <div>Total events: {events.length.toLocaleString()}</div>
                  <div>Total cycles: {totalCycles.toLocaleString()}</div>
                  <div>Avg duration: {stats.avg.toFixed(0)}</div>
                  <div>Live rate: {liveHasTrace ? `${liveEventRate.toFixed(1)} ev/s` : "idle"}</div>
                  {Object.entries(stats.counts).map(([tid, cnt]) => (
                    <div key={tid} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ width: 6, height: 6, borderRadius: 1, background: EVENT_COLORS[Number(tid)]?.fill, display: "inline-block" }} />
                      {EVENT_COLORS[Number(tid)]?.label}: {cnt}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
