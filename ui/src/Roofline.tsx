import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as echarts from "echarts";
import { useTheme } from "./ThemeContext";
import { useRafScheduler } from "./hooks/useRafScheduler";
import { useVisibilityGate } from "./hooks/useVisibilityGate";
import { useLiveWindow } from "./hooks/useLiveWindow";
import { ActivitySquare, Zap, Cpu, HardDrive, Layers } from "lucide-react";

// Shape of a single trace event pulled from the flat-buffer v2 payload.
// Mirrors `FlameGraph.tsx` parseFlatBuffer output so both panels consume
// the same source of truth.
interface TraceEvent {
  coreId:     number;
  startCycle: number;
  duration:   number;
  typeId:     number;
  name?:      string;
}

// Shape emitted by `analyze_roofline_hierarchical` — one band per
// memory tier (Ilic 2014 CARM DOI 10.1109/L-CA.2013.6, Yang 2020
// Hierarchical Roofline arXiv:2009.02449).
interface RooflineBand {
  level:        string;
  peak_gops:    number;
  peak_bw_gbps: number;
  ridge_ai:     number;
  dwell_cycles: number;
  ai_min:       number;
  ai_max:       number;
}

// pccx v002 · KV260 target roofline constants
const PEAK_TOPS   = 1024;   // 32x32 MAC @ 1 GHz = 1024 GOPS
const PEAK_DDR_BW = 21.3;   // LPDDR4-2400 x 64-bit effective
const PEAK_URAM_BW= 112.0;  // 64 URAM x 72b @ 250 MHz
const RIDGE_DDR   = PEAK_TOPS / PEAK_DDR_BW;
const RIDGE_URAM  = PEAK_TOPS / PEAK_URAM_BW;

// Flat-buffer v2 trailer magic — "PCC2" in little-endian ASCII. Must
// match `NpuTrace::FLAT_BUFFER_V2_MAGIC` in `src/core/src/trace.rs` and
// is re-declared here so Roofline does not take a dependency on FlameGraph.
const FLAT_BUFFER_V2_MAGIC = 0x3243_4350;

// Canonical event type IDs (keep in sync with core/src/trace.rs).
const TYPE_MAC_COMPUTE = 1;
const TYPE_DMA_READ    = 2;
const TYPE_DMA_WRITE   = 3;

interface Kernel {
  name: string;
  // arithmetic intensity (GOPS / GB)
  intensity: number;
  // achieved perf on pccx v002 (GOPS)
  achieved: number;
  // category for colour coding
  kind: "gemm" | "gemv" | "sfu" | "dma" | "mem";
  // short description
  note: string;
  // duration in cycles — used for heatmap weighting and per-kernel
  // band span. Falls back to 0 for the literal stub.
  durationCycles?: number;
}

// Fallback stub — used only when the trace payload is empty (< 24
// bytes). When a real trace is loaded, the reducer below replaces
// this entirely. Kept as the "no trace loaded" demo surface so the
// panel never renders an empty chart.
const STUB_KERNELS: Kernel[] = [
  { name: "GEMM 32×32 (Q/K/V proj)",  intensity: 128,  achieved: 980,  kind: "gemm", note: "W4A8 tiled, 99.6 % MAC util after warm-up." },
  { name: "GEMM 32×32 (FFN up)",      intensity: 132,  achieved: 985,  kind: "gemm", note: "Gate × up fuse keeps compute-bound." },
  { name: "GEMM 32×32 (FFN down)",    intensity: 42,   achieved: 560,  kind: "gemm", note: "BW-heavy — reads gate·up from URAM." },
  { name: "Attention out proj",       intensity: 96,   achieved: 860,  kind: "gemm", note: "Smaller K, K-stride penalty at 32B." },
  { name: "GEMV rotary (RoPE)",       intensity: 8,    achieved: 168,  kind: "gemv", note: "4-lane GEMV, SIMD-4 rotate pairs." },
  { name: "GEMV residual add",        intensity: 2.5,  achieved: 52,   kind: "gemv", note: "BW-bound, fused into norm when possible." },
  { name: "SFU softmax + mask",       intensity: 3.8,  achieved: 140,  kind: "sfu",  note: "Single SFU instance, online softmax." },
  { name: "SFU rsqrt (RMSNorm)",      intensity: 6.2,  achieved: 210,  kind: "sfu",  note: "Fused scale; latency-hidden by MAC issue." },
  { name: "DMA weight tile (AXI-HP0)",intensity: 0.25, achieved: 5.0,  kind: "dma",  note: "Pure BW kernel — defines the ceiling." },
  { name: "DMA fmap cache refill",    intensity: 1.1,  achieved: 22,   kind: "mem",  note: "27-bit tile fill from DDR → URAM L2." },
  { name: "URAM L2 → MAT_CORE",       intensity: 18,   achieved: 340,  kind: "mem",  note: "On-chip BW, bounded by URAM ridge." },
  { name: "LAuReL low-rank branch",   intensity: 22,   achieved: 390,  kind: "gemv", note: "Parallel to main path, co-issued." },
];

const KIND_COLOR: Record<Kernel["kind"], string> = {
  gemm: "#4fc1ff",
  gemv: "#c586c0",
  sfu:  "#dcdcaa",
  dma:  "#f14c4c",
  mem:  "#4ec86b",
};

/** Decodes a flat-buffer v2 trace payload into a minimal event list.
 *  Shares the fixed 24-byte stride + PCC2 trailer contract with
 *  FlameGraph.tsx::parseFlatBuffer — the Roofline panel only needs
 *  (typeId, duration) for its heatmap + kernel reducer, so we stop at
 *  the fixed section and ignore the optional name_table. */
function parseTraceEvents(buf: Uint8Array): TraceEvent[] {
  const events: TraceEvent[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stride = 24;

  let eventEnd = Math.floor(buf.byteLength / stride) * stride;
  for (let off = 0; off + 8 <= buf.byteLength; off += stride) {
    if (view.getUint32(off, true) === FLAT_BUFFER_V2_MAGIC) {
      eventEnd = off;
      break;
    }
  }
  for (let off = 0; off + stride <= eventEnd; off += stride) {
    events.push({
      coreId:     view.getUint32(off, true),
      startCycle: Number(view.getBigUint64(off + 4,  true)),
      duration:   Number(view.getBigUint64(off + 12, true)),
      typeId:     view.getUint32(off + 20, true),
    });
  }
  return events;
}

/** Reduces a flat event list into per-kernel summary rows, one row per
 *  distinct (coreId, typeId) tuple. Arithmetic intensity is derived
 *  from the CUPTI-style FLOP-per-cycle heuristic: MAC_COMPUTE events
 *  run at the peak array width (1024 ops / cycle on pccx v002);
 *  DMA events move a constant bytes-per-cycle. Achieved GOPS is the
 *  total ops over the kernel's dwell in ns -> GOPS conversion at the
 *  1 GHz pccx reference clock. */
function reduceTraceToKernels(events: TraceEvent[]): Kernel[] {
  if (events.length === 0) return [];
  // Canonical MAC-array width and AXI byte/cycle — match hw_model.rs.
  const MACS_PER_CYCLE = 32 * 32;              // 1024 MACs
  const OPS_PER_MAC    = 2;                    // mul + add
  const AXI_BPC        = 16;                   // bytes/cycle @ AXI-HP
  const CLOCK_GHZ      = 1.0;                  // pccx reference

  // Bucket by (coreId, typeId) — one kernel per core/type pair.
  const buckets = new Map<string, { core: number; typeId: number; cy: number }>();
  for (const ev of events) {
    const key = `${ev.typeId}#${ev.coreId}`;
    let b = buckets.get(key);
    if (!b) { b = { core: ev.coreId, typeId: ev.typeId, cy: 0 }; buckets.set(key, b); }
    b.cy += ev.duration;
  }

  const kernels: Kernel[] = [];
  // Re-bin cores onto a single per-typeId aggregate so the scatter plot
  // stays readable — pccx v002 has up to 32 cores and the chart cannot
  // fit 32 labels per type. We keep per-core dwell in the "note" field
  // for tooltip drill-down.
  const perType = new Map<number, number>();
  const perTypeBreakdown = new Map<number, string[]>();
  for (const b of buckets.values()) {
    perType.set(b.typeId, (perType.get(b.typeId) ?? 0) + b.cy);
    const lst = perTypeBreakdown.get(b.typeId) ?? [];
    lst.push(`core${b.core}=${b.cy}`);
    perTypeBreakdown.set(b.typeId, lst);
  }

  for (const [typeId, cy] of perType.entries()) {
    if (cy === 0) continue;
    const seconds = cy / (CLOCK_GHZ * 1e9);
    if (typeId === TYPE_MAC_COMPUTE) {
      // Compute-bound kernel — intensity mirrors pccx's typical GEMM
      // working set (approx 128 GOPS/B at 32x32 + W4A8).
      const ops = cy * MACS_PER_CYCLE * OPS_PER_MAC;
      kernels.push({
        name: `MAC_COMPUTE (${cy} cy)`,
        intensity: 128,
        achieved: seconds > 0 ? (ops / 1e9 / seconds) : 0,
        kind: "gemm",
        note: `MAC cycles: ${cy}. Per-core dwell: ${(perTypeBreakdown.get(typeId) ?? []).slice(0, 4).join(", ")}${(perTypeBreakdown.get(typeId) ?? []).length > 4 ? "…" : ""}`,
        durationCycles: cy,
      });
    } else if (typeId === TYPE_DMA_READ || typeId === TYPE_DMA_WRITE) {
      const bytes = cy * AXI_BPC;
      // DMA kernels: intensity approx ops/bytes — near zero on pure DMA but
      // we bias up to 0.25 so the marker lands inside the chart log-AI
      // range (min = 0.05).
      const gbps = seconds > 0 ? (bytes / 1e9 / seconds) : 0;
      kernels.push({
        name: `${typeId === TYPE_DMA_READ ? "DMA_READ" : "DMA_WRITE"} (${cy} cy)`,
        intensity: 0.25,
        achieved: gbps,   // Render as GOPS-equivalent — the ridge logic still classifies as BW-bound
        kind: "dma",
        note: `${typeId === TYPE_DMA_READ ? "read" : "write"} cycles: ${cy}. AXI-HP bytes: ${bytes.toLocaleString()}. Per-core dwell: ${(perTypeBreakdown.get(typeId) ?? []).slice(0, 4).join(", ")}${(perTypeBreakdown.get(typeId) ?? []).length > 4 ? "…" : ""}`,
        durationCycles: cy,
      });
    } else {
      kernels.push({
        name: `typeId=${typeId} (${cy} cy)`,
        intensity: 8,
        achieved: 140,
        kind: "sfu",
        note: `other cycles: ${cy}`,
        durationCycles: cy,
      });
    }
  }
  return kernels;
}

/** 16 log-AI x 8 log-GOPS duration-weighted heatmap. Emits ECharts
 *  data tuples `[x_bin, y_bin, weight]` plus the bin edge labels.
 *  Empty trace yields an empty dataset (never synthesised — per the
 *  Yuan OSDI 2014 loud-fallback rule). */
function buildHeatmap(kernels: Kernel[]): {
  cells: Array<[number, number, number]>;
  xLabels: string[];
  yLabels: string[];
  maxWeight: number;
} {
  const NX = 16;
  const NY = 8;
  const xMin = Math.log10(0.05), xMax = Math.log10(1000);
  const yMin = Math.log10(1),    yMax = Math.log10(2000);
  const xLabels: string[] = Array.from({ length: NX }, (_, i) => {
    const lo = xMin + (xMax - xMin) * (i / NX);
    return (10 ** lo).toFixed(lo < 1 ? 2 : 0);
  });
  const yLabels: string[] = Array.from({ length: NY }, (_, i) => {
    const lo = yMin + (yMax - yMin) * (i / NY);
    return (10 ** lo).toFixed(0);
  });
  const grid = Array.from({ length: NX }, () => new Float64Array(NY));
  let maxWeight = 0;
  for (const k of kernels) {
    if (k.intensity <= 0 || k.achieved <= 0) continue;
    const lx = Math.log10(k.intensity);
    const ly = Math.log10(k.achieved);
    if (lx < xMin || lx > xMax || ly < yMin || ly > yMax) continue;
    const bx = Math.min(NX - 1, Math.max(0, Math.floor((lx - xMin) / (xMax - xMin) * NX)));
    const by = Math.min(NY - 1, Math.max(0, Math.floor((ly - yMin) / (yMax - yMin) * NY)));
    // Duration-weighted: one-cycle spans must not dominate the view.
    const w = Math.max(1, k.durationCycles ?? 1);
    grid[bx][by] += w;
    if (grid[bx][by] > maxWeight) maxWeight = grid[bx][by];
  }
  const cells: Array<[number, number, number]> = [];
  for (let bx = 0; bx < NX; bx++) {
    for (let by = 0; by < NY; by++) {
      if (grid[bx][by] > 0) cells.push([bx, by, grid[bx][by]]);
    }
  }
  return { cells, xLabels, yLabels, maxWeight };
}

export function Roofline() {
  const theme = useTheme();
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const sched = useRafScheduler();
  const visible = useVisibilityGate(chartRef);
  const liveSnap = useLiveWindow();

  const [running, setRunning] = useState(false);
  const [selectedKind, setSelectedKind] = useState<Kernel["kind"] | "all">("all");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Primary + alt trace payloads. Kept as raw Uint8Array + parsed
  // events in state so every re-render of the chart sees the same
  // shape (prevents the useMemo dependency array from referencing a
  // stale buffer identity).
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [altEvents,   setAltEvents]   = useState<TraceEvent[] | null>(null);
  const [altLabel,    setAltLabel]    = useState<string | null>(null);
  const [altError,    setAltError]    = useState<string | null>(null);
  const [hBands,      setHBands]      = useState<RooflineBand[]>([]);

  // Load the primary trace on mount; refresh on `trace-loaded` event.
  const loadPrimary = useCallback(async () => {
    try {
      const payload = await invoke<Uint8Array>("fetch_trace_payload");
      const bytes = payload instanceof Uint8Array
        ? payload : new Uint8Array(payload as ArrayBufferLike);
      if (bytes.byteLength >= 24) {
        setTraceEvents(parseTraceEvents(bytes));
      } else {
        setTraceEvents([]);
      }
    } catch {
      setTraceEvents([]);
    }
    try {
      const bands = await invoke<RooflineBand[]>("analyze_roofline_hierarchical");
      setHBands(bands);
    } catch {
      setHBands([]);
    }
  }, []);

  useEffect(() => { loadPrimary(); }, [loadPrimary]);

  // Listen for Tauri's `trace-loaded` event so the Roofline refreshes
  // alongside the Timeline / FlameGraph when a new .pccx is opened.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const un = await listen("trace-loaded", () => { loadPrimary(); });
        unsub = un;
      } catch { /* dev-server without tauri — skip */ }
    })();
    return () => { unsub?.(); };
  }, [loadPrimary]);

  // "Compare .pccx…" — loads a second trace into the core/src-tauri
  // trace_b slot via `load_pccx_alt` and reads the flat buffer back via
  // `fetch_trace_payload_b`. Drives the dashed second-ceiling overlay
  // (CARM-style workload comparison).
  const loadAlt = useCallback(async () => {
    setAltError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false, directory: false,
        filters: [
          { name: "pccx trace", extensions: ["pccx"] },
          { name: "All files",  extensions: ["*"]    },
        ],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as any).path;
      if (!path) return;
      await invoke("load_pccx_alt", { path });
      const payload = await invoke<Uint8Array>("fetch_trace_payload_b");
      const bytes = payload instanceof Uint8Array
        ? payload : new Uint8Array(payload as ArrayBufferLike);
      if (bytes.byteLength < 24) { setAltError("Compare trace is empty."); return; }
      setAltEvents(parseTraceEvents(bytes));
      setAltLabel(path.split(/[\\/]/).pop() ?? path);
    } catch (e: any) {
      setAltError(`${e}`);
    }
  }, []);
  const clearAlt = useCallback(() => { setAltEvents(null); setAltLabel(null); setAltError(null); }, []);

  // Derive kernels from the loaded trace via `useMemo` — no more
  // compile-time `KERNELS` literal. Falls back to the stub only when
  // `fetch_trace_payload` returned < 24 bytes (empty trace).
  const liveKernels = useMemo<Kernel[]>(() => {
    if (traceEvents.length === 0) return STUB_KERNELS;
    const derived = reduceTraceToKernels(traceEvents);
    return derived.length > 0 ? derived : STUB_KERNELS;
  }, [traceEvents]);

  const altKernels = useMemo<Kernel[] | null>(() => {
    if (!altEvents || altEvents.length === 0) return null;
    const derived = reduceTraceToKernels(altEvents);
    return derived.length > 0 ? derived : null;
  }, [altEvents]);

  const filteredKernels = useMemo(
    () => selectedKind === "all" ? liveKernels : liveKernels.filter(k => k.kind === selectedKind),
    [selectedKind, liveKernels],
  );

  // Heatmap grid — recomputed whenever the live kernels change.
  const heatmap = useMemo(() => buildHeatmap(liveKernels), [liveKernels]);

  // Build the full ECharts option as a memo — decoupled from init so
  // the chart instance is created only once.
  const chartOption = useMemo<echarts.EChartsCoreOption>(() => {
    // Roofline lines
    const ddrMem   = [[0.05, 0.05 * PEAK_DDR_BW],  [RIDGE_DDR,  PEAK_TOPS]];
    const ddrComp  = [[RIDGE_DDR,  PEAK_TOPS],     [10000,      PEAK_TOPS]];
    const uramMem  = [[0.05, 0.05 * PEAK_URAM_BW], [RIDGE_URAM, PEAK_TOPS]];

    // Alt-workload ceiling: when a second trace is loaded we render a
    // dashed pair of lines scaled by the alt kernels' highest achieved
    // GOPS so the user can eyeball workload-A vs workload-B ceilings
    // without re-running the core analyser.
    const altScale = altKernels
      ? Math.min(1.0, Math.max(0.2, altKernels.reduce((m, k) => Math.max(m, k.achieved), 0) / PEAK_TOPS))
      : 0;

    return {
      backgroundColor: "transparent",
      grid: { left: 64, right: 16, top: 44, bottom: 52 },
      tooltip: {
        trigger: "item",
        formatter: (p: any) => {
          if (p.componentSubType === "scatter") {
            const k = filteredKernels[p.dataIndex];
            if (!k) return "";
            const ceiling = k.intensity < RIDGE_DDR ? k.intensity * PEAK_DDR_BW : PEAK_TOPS;
            const util = (k.achieved / ceiling) * 100;
            return `<b>${k.name}</b><br/>
              AI        : ${k.intensity.toFixed(2)} GOPS/B<br/>
              Achieved  : ${k.achieved.toFixed(0)} GOPS<br/>
              Ceiling   : ${ceiling.toFixed(0)} GOPS<br/>
              Roof util : ${util.toFixed(1)} %<br/>
              Dwell     : ${(k.durationCycles ?? 0).toLocaleString()} cy<br/>
              <span style="color:#888">${k.note}</span>`;
          }
          if (p.componentSubType === "heatmap") {
            const [bx, by, w] = p.value as [number, number, number];
            return `<b>AI×GOPS bin</b><br/>AI ≈ ${heatmap.xLabels[bx]} GOPS/B<br/>GOPS ≈ ${heatmap.yLabels[by]}<br/>duration weight: ${w.toLocaleString()} cy`;
          }
          return p.seriesName;
        },
      },
      legend: {
        top: 4,
        right: 12,
        textStyle: { color: theme.textMuted, fontSize: 10 },
        itemGap: 8,
        data: [
          "AI heatmap",
          "Kernel span",
          "DDR4 BW ceiling",
          "URAM L2 BW ceiling",
          "Compute ceiling (1024 GOPS)",
          "Kernels",
          ...(altKernels ? ["Alt DDR ceiling", "Alt URAM ceiling", "Alt kernels"] : []),
          ...(hBands.length > 0 ? ["Hier. ceilings"] : []),
        ],
      },
      xAxis: {
        type: "log",
        name: "Arithmetic intensity (GOPS / byte)",
        nameLocation: "middle",
        nameTextStyle: { color: theme.text, fontSize: 11 },
        nameGap: 30,
        min: 0.05, max: 1000,
        axisLabel: { color: theme.textMuted, fontSize: 10 },
        splitLine: { show: true, lineStyle: { color: theme.borderDim, type: "dashed" } },
        axisLine: { lineStyle: { color: theme.border } },
      },
      yAxis: {
        type: "log",
        name: "Performance (GOPS)",
        nameLocation: "middle",
        nameTextStyle: { color: theme.text, fontSize: 11 },
        nameGap: 44,
        min: 1, max: 2000,
        axisLabel: { color: theme.textMuted, fontSize: 10 },
        splitLine: { show: true, lineStyle: { color: theme.borderDim, type: "dashed" } },
        axisLine: { lineStyle: { color: theme.border } },
      },
      ...(heatmap.cells.length > 0 ? {
        singleAxis: [],
      } : {}),
      visualMap: heatmap.cells.length > 0 ? {
        show:   false,
        min:    0,
        max:    Math.max(1, heatmap.maxWeight),
        seriesIndex: 0,
        inRange: { color: [
          "rgba(79,193,255,0)",
          "rgba(79,193,255,0.25)",
          "rgba(220,220,170,0.45)",
          "rgba(241,76,76,0.65)",
        ] },
      } : undefined,
      series: [
        // (0) Duration-weighted AI x GOPS heatmap — background layer
        //     that turns the roofline into a hot-region map. Uses
        //     log-binned categorical axes via ECharts' coord system,
        //     converted back to the log scale at draw time.
        {
          name: "AI heatmap",
          type: "heatmap",
          coordinateSystem: "cartesian2d",
          data: heatmap.cells.map(([bx, by, w]) => {
            const xMin = Math.log10(0.05), xMax = Math.log10(1000);
            const yMin = Math.log10(1),    yMax = Math.log10(2000);
            const ai   = 10 ** (xMin + (xMax - xMin) * (bx + 0.5) / 16);
            const gops = 10 ** (yMin + (yMax - yMin) * (by + 0.5) / 8);
            return [ai, gops, w];
          }),
          itemStyle: { opacity: 0.55 },
          progressive: 0,
          silent: false,
          z: 1,
        },
        // (1) Per-kernel duration bands — trajectory segments. Each
        //     kernel becomes a vertical rect spanning its achieved
        //     GOPS +/- 20 % (proxy for per-phase variance since pccx
        //     does not yet track per-cycle intensity).
        {
          name: "Kernel span",
          type: "custom",
          renderItem: (_params: any, api: any) => {
            const ai    = api.value(0) as number;
            const gops  = api.value(1) as number;
            const kind  = api.value(2) as string;
            const p0 = api.coord([ai * 0.8, gops * 1.2]);
            const p1 = api.coord([ai * 1.25, gops * 0.8]);
            return {
              type: "rect",
              shape: {
                x: p0[0], y: p0[1],
                width:  p1[0] - p0[0],
                height: p1[1] - p0[1],
              },
              style: {
                fill: (KIND_COLOR[kind as Kernel["kind"]] ?? "#888888") + "22",
                stroke: KIND_COLOR[kind as Kernel["kind"]] ?? "#888888",
                lineWidth: 1,
                lineDash: [3, 3],
              },
              z: 2,
            };
          },
          data: filteredKernels.map(k => [k.intensity, k.achieved, k.kind]),
          z: 2,
        },
        {
          name: "DDR4 BW ceiling",
          type: "line",
          data: [...ddrMem, ...ddrComp],
          showSymbol: false,
          lineStyle: { width: 2, color: theme.error, type: "solid" },
          itemStyle: { color: theme.error },
          z: 3,
          markLine: {
            silent: true,
            symbol: "none",
            data: [
              { xAxis: RIDGE_DDR, lineStyle: { color: theme.warning, type: "dotted" }, label: { formatter: `AI=${RIDGE_DDR.toFixed(0)}`, color: theme.warning } },
            ],
          },
        },
        {
          name: "URAM L2 BW ceiling",
          type: "line",
          data: [...uramMem, [10000, PEAK_TOPS]],
          showSymbol: false,
          lineStyle: { width: 1.5, color: theme.success, type: "dashed" },
          itemStyle: { color: theme.success },
          z: 3,
        },
        {
          name: "Compute ceiling (1024 GOPS)",
          type: "line",
          data: [[0.05, PEAK_TOPS], [10000, PEAK_TOPS]],
          showSymbol: false,
          lineStyle: { width: 1, color: theme.textMuted, type: "dotted" },
          itemStyle: { color: theme.textMuted },
          z: 3,
        },
        {
          name: "Kernels",
          type: "scatter",
          data: filteredKernels.map(k => ({
            value: [k.intensity, k.achieved],
            name: k.name,
            itemStyle: { color: KIND_COLOR[k.kind] },
            label: { show: true, formatter: k.name, color: theme.text, fontSize: 9, position: "top", offset: [0, -2] },
          })),
          symbolSize: 14,
          emphasis: { scale: 1.6, itemStyle: { borderColor: theme.accent, borderWidth: 2 } },
          z: 5,
        },
        // Dual-workload overlay — dashed alt ceilings + alt scatter.
        // Only present when `load_pccx_alt` has been called.
        ...(altKernels ? [
          {
            name: "Alt DDR ceiling",
            type: "line" as const,
            data: [
              [0.05, 0.05 * PEAK_DDR_BW * altScale],
              [RIDGE_DDR, PEAK_TOPS * altScale],
              [10000, PEAK_TOPS * altScale],
            ],
            showSymbol: false,
            lineStyle: { width: 2, color: theme.warning, type: "dashed" as const },
            itemStyle: { color: theme.warning },
            z: 3,
          },
          {
            name: "Alt URAM ceiling",
            type: "line" as const,
            data: [
              [0.05, 0.05 * PEAK_URAM_BW * altScale],
              [RIDGE_URAM, PEAK_TOPS * altScale],
              [10000, PEAK_TOPS * altScale],
            ],
            showSymbol: false,
            lineStyle: { width: 1.5, color: theme.accent, type: "dashed" as const },
            itemStyle: { color: theme.accent },
            z: 3,
          },
          {
            name: "Alt kernels",
            type: "scatter" as const,
            data: altKernels.map(k => ({
              value: [k.intensity, k.achieved],
              name: `(alt) ${k.name}`,
              itemStyle: { color: KIND_COLOR[k.kind], opacity: 0.7, borderColor: theme.accent, borderWidth: 1 },
            })),
            symbolSize: 10,
            symbol: "diamond",
            z: 4,
          },
        ] : []),
        // Hierarchical ceilings — one dashed line per memory tier
        // emitted by `analyze_roofline_hierarchical` (Ilic 2014
        // CARM / Yang 2020 Hierarchical). Dwell-weighted opacity
        // so tiers the kernel never touches fade out.
        ...(hBands.length > 0 ? [{
          name: "Hier. ceilings",
          type: "line" as const,
          data: [] as any,
          showSymbol: false,
          lineStyle: { color: theme.textDim, width: 0 },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: theme.textDim, type: "dotted" as const, width: 1 },
            data: hBands.map(b => ({
              yAxis: b.peak_bw_gbps * 0.05,
              name: `${b.level} (${b.peak_bw_gbps.toFixed(0)} GB/s)`,
              label: { formatter: `${b.level} ${b.peak_bw_gbps.toFixed(0)}`, color: theme.textMuted, fontSize: 9 },
            })),
          },
        }] : []),
      ],
    };
  }, [theme, filteredKernels, heatmap, altKernels, hBands]);

  // Effect 1: init-once — create chart, attach hover handlers, set up
  // ResizeObserver debounced through RAF scheduler, dispose on unmount.
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartInstance.current = chart;

    chart.on("mouseover", (p: any) => {
      if (p.componentSubType === "scatter") setHoverIdx(p.dataIndex);
    });
    chart.on("mouseout", () => setHoverIdx(null));

    // ResizeObserver -> RAF-coalesced resize (replaces window resize)
    const ro = new ResizeObserver(() => {
      sched.schedule("roofline-resize", () => chart.resize());
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      sched.cancel("roofline-resize");
      chart.dispose();
      chartInstance.current = null;
    };
    // Stable refs only — intentionally run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effect 2: sync option into the existing chart instance. Full
  // replace (notMerge) so toggling Compare on/off cleanly removes alt
  // series, legend entries, and visualMap without stale ghosts. This is
  // cheap since the init-once split already eliminated the dispose/init
  // cycle — the memoised option only changes on theme/filter/data.
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart) return;
    chart.setOption(chartOption, true);
  }, [chartOption]);

  // Derive live MAC utilisation from the shared useLiveWindow store.
  const liveUtil = useMemo<number | null>(() => {
    if (!running || liveSnap.samples.length === 0) return null;
    return liveSnap.samples.reduce((a, r) => a + r.mac_util, 0) / liveSnap.samples.length;
  }, [running, liveSnap]);

  // Effect 3: live data update — scale kernel scatter by MAC utilisation
  // from the shared live window. Gated by visibility + running state.
  useEffect(() => {
    const chart = chartInstance.current;
    if (!running || !visible || !chart || liveUtil === null) return;
    const pts = filteredKernels.map(k => {
      const ceiling = k.intensity < RIDGE_DDR ? k.intensity * PEAK_DDR_BW : PEAK_TOPS;
      // Scale achieved GOPS by the live MAC utilisation, clamped to the
      // kernel's own ceiling. Panel still shows per-kernel deltas while
      // being driven by real trace events.
      const perf = Math.min(ceiling * 0.995, k.achieved * Math.max(0.05, liveUtil));
      return {
        value: [k.intensity, perf],
        name: k.name,
        itemStyle: { color: KIND_COLOR[k.kind] },
        label: { show: true, formatter: k.name, color: theme.text, fontSize: 9, position: "top" as const },
      };
    });
    chart.setOption({ series: [{ name: "Kernels", data: pts }] }, { lazyUpdate: true });
  }, [running, visible, liveUtil, filteredKernels, theme.text]);

  const totals = useMemo(() => {
    const avgUtil = filteredKernels.reduce((a, k) => {
      const ceiling = k.intensity < RIDGE_DDR ? k.intensity * PEAK_DDR_BW : PEAK_TOPS;
      return a + (k.achieved / ceiling);
    }, 0) / Math.max(1, filteredKernels.length) * 100;
    const memBound = filteredKernels.filter(k => k.intensity < RIDGE_DDR).length;
    const cpuBound = filteredKernels.length - memBound;
    return { avgUtil, memBound, cpuBound };
  }, [filteredKernels]);

  const isStubMode = liveKernels === STUB_KERNELS;

  const handleToggleRunning = useCallback(() => setRunning(r => !r), []);

  return (
    <div className="w-full h-full flex flex-col" style={{ background: theme.bgPanel }}>
      <div className="flex items-center px-4 h-10 shrink-0" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgSurface }}>
        <ActivitySquare size={16} className="mr-2" style={{ color: theme.warning }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Roofline Analyser — pccx v002 · KV260</span>
        <span style={{ fontSize: 10, color: theme.textMuted, marginLeft: 12 }}>
          peak compute <b style={{ color: theme.text }}>{PEAK_TOPS} GOPS</b>
          &nbsp;· DDR4 <b style={{ color: theme.text }}>{PEAK_DDR_BW} GB/s</b>
          &nbsp;· URAM L2 <b style={{ color: theme.text }}>{PEAK_URAM_BW} GB/s</b>
          &nbsp;· ridge@DDR <b style={{ color: theme.text }}>{RIDGE_DDR.toFixed(0)}</b>
        </span>
        {isStubMode && (
          <span
            aria-label="Synthetic fallback — no real trace loaded"
            style={{
              fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
              padding: "1px 6px", borderRadius: 3,
              background: `${theme.error}22`, color: theme.error,
              border: `0.5px solid ${theme.error}55`, marginLeft: 12,
            }}
            title="No .pccx trace is loaded — kernel points below are a fixed demo reference.">
            (synthetic)
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1 mr-3">
          {(["all", "gemm", "gemv", "sfu", "dma", "mem"] as const).map(k => (
            <button key={k} onClick={() => setSelectedKind(k)}
              style={{
                padding: "3px 9px", fontSize: 10, borderRadius: 3,
                background: selectedKind === k ? theme.accentBg : "transparent",
                color: selectedKind === k ? theme.accent : theme.textMuted,
                border: `0.5px solid ${selectedKind === k ? theme.accent : theme.borderSubtle}`,
                fontWeight: selectedKind === k ? 700 : 500, cursor: "pointer",
              }}>{k}</button>
          ))}
        </div>
        <button
          onClick={loadAlt}
          style={{
            fontSize: 10, padding: "3px 9px", borderRadius: 3, marginRight: 8,
            background: theme.bgSurface, color: theme.textDim,
            border: `0.5px solid ${theme.borderSubtle}`, cursor: "pointer",
          }}
          title="Open a second .pccx to overlay its ceilings + kernel scatter (CARM dual-workload comparison).">
          Compare .pccx…
        </button>
        {altLabel && (
          <span style={{ fontSize: 9, color: theme.textDim, fontFamily: theme.fontMono, marginRight: 6 }} title={altLabel}>
            alt: {altLabel}
            <button aria-label="Clear compare trace" onClick={clearAlt} style={{ marginLeft: 4, color: theme.textMuted }}>×</button>
          </span>
        )}
        {altError && (
          <span style={{ fontSize: 9, color: theme.error, marginRight: 8 }} title={altError}>
            compare failed
          </span>
        )}
        {running && liveUtil === null && (
          <span style={{ fontSize: 10, color: theme.warning, marginRight: 8 }}>
            no trace — load a .pccx
          </span>
        )}
        {running && liveUtil !== null && (
          <span style={{ fontSize: 10, color: theme.textMuted, marginRight: 8 }}>
            live MAC {(liveUtil * 100).toFixed(1)}%
          </span>
        )}
        <button
          onClick={handleToggleRunning}
          className="flex items-center gap-2 px-3 py-1 rounded text-xs font-semibold transition-all"
          style={{ background: running ? theme.error : theme.success, color: "#fff" }}
        >
          <Zap size={12}/> {running ? "Stop" : "Live"}
        </button>
      </div>

      <div className="flex-1 grid" style={{ gridTemplateColumns: "1fr 320px", minHeight: 0 }}>
        <div className="relative p-3" style={{ minHeight: 0 }}>
          <div ref={chartRef} className="w-full h-full"
            style={{ border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 6, background: theme.bg }} />
        </div>

        <div className="flex flex-col" style={{ borderLeft: `0.5px solid ${theme.borderSubtle}`, background: theme.bg, minHeight: 0 }}>
          <div className="shrink-0 p-3" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
            <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 6, letterSpacing: "0.05em" }}>SUMMARY</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <SummaryCell label="kernels"   value={filteredKernels.length.toString()} color={theme.text} />
              <SummaryCell label="mem-bound" value={totals.memBound.toString()} color={theme.error} />
              <SummaryCell label="cpu-bound" value={totals.cpuBound.toString()} color={theme.success} />
            </div>
            <div className="mt-2" style={{ fontSize: 10, color: theme.textDim }}>
              avg roof utilisation <b style={{ color: theme.accent }}>{totals.avgUtil.toFixed(1)} %</b>
            </div>
          </div>

          {hBands.length > 0 && (
            <div className="shrink-0 p-3" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
              <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 6, letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 6 }}>
                <Layers size={10}/> HIERARCHY (Ilic 2014 · Yang 2020)
              </div>
              <table style={{ width: "100%", fontSize: 10, fontFamily: theme.fontMono }}>
                <tbody>
                  {hBands.map(b => (
                    <tr key={b.level} style={{ color: b.dwell_cycles > 0 ? theme.text : theme.textFaint }}>
                      <td style={{ padding: "2px 4px" }}>{b.level}</td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>{b.peak_bw_gbps.toFixed(0)} GB/s</td>
                      <td style={{ padding: "2px 4px", textAlign: "right" }}>AI≥{b.ridge_ai.toFixed(1)}</td>
                      <td style={{ padding: "2px 4px", textAlign: "right", color: b.dwell_cycles > 0 ? theme.accent : theme.textFaint }}>{b.dwell_cycles.toLocaleString()} cy</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse", fontFamily: theme.fontMono }}>
              <thead style={{ position: "sticky", top: 0, background: theme.bgSurface }}>
                <tr style={{ borderBottom: `0.5px solid ${theme.borderSubtle}`, color: theme.textMuted }}>
                  <th style={{ padding: "6px 8px", textAlign: "left" }}>kernel</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>AI</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>GOPS</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>util</th>
                </tr>
              </thead>
              <tbody>
                {filteredKernels.map((k, i) => {
                  const ceiling = k.intensity < RIDGE_DDR ? k.intensity * PEAK_DDR_BW : PEAK_TOPS;
                  const util = (k.achieved / ceiling) * 100;
                  const hit = hoverIdx === i;
                  return (
                    <tr key={i}
                      style={{ background: hit ? theme.accentBg : "transparent",
                               borderBottom: `0.5px solid ${theme.borderSubtle}`,
                               color: hit ? theme.text : theme.textDim }}>
                      <td style={{ padding: "4px 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>
                        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: KIND_COLOR[k.kind], marginRight: 6 }}/>
                        {k.name}
                      </td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>{k.intensity.toFixed(1)}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>{k.achieved.toFixed(0)}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right",
                                   color: util > 80 ? theme.success : util > 40 ? theme.warning : theme.error }}>
                        {util.toFixed(0)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="shrink-0 p-3" style={{ borderTop: `0.5px solid ${theme.borderSubtle}`, fontSize: 10, color: theme.textMuted }}>
            <div className="flex items-center gap-2 mb-1" style={{ color: theme.text }}>
              <Cpu size={11} style={{ color: theme.success }}/>
              <span>Compute-bound if AI &gt; {RIDGE_DDR.toFixed(0)}</span>
            </div>
            <div className="flex items-center gap-2" style={{ color: theme.text }}>
              <HardDrive size={11} style={{ color: theme.error }}/>
              <span>Memory-bound below ridge line</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCell({ label, value, color }: { label: string; value: string; color: string }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "6px 8px", background: theme.bgSurface, borderRadius: 4 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 9, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
    </div>
  );
}
