import { useState, useEffect, useRef, useMemo } from "react";
import { useTheme } from "./ThemeContext";
import { Play, Pause, SkipForward, SkipBack, RotateCcw, Cpu, ChevronRight, ChevronDown, Search } from "lucide-react";
import ELK, { type ElkNode, type ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import { invoke } from "@tauri-apps/api/core";
import { useCycleCursor, attachCycleKeybindings, useGoToCycleInput } from "./hooks/useCycleCursor";
import { useRafScheduler } from "./hooks/useRafScheduler";
import { useVisibilityGate } from "./hooks/useVisibilityGate";

/* ─────────────────────────────────────────────────────────────────────────
 * pccx v002 KV260 module hierarchy.
 * Modelled from hw/rtl/ in pccx-FPGA-NPU-LLM-kv260.  Each leaf module
 * carries its known signal surface (ports) + a "what it does" blurb.
 * The x/y/w/h coordinates describe its slot in the block-diagram canvas
 * at depth N; sub-modules are drawn nested inside their parent's box.
 * ─────────────────────────────────────────────────────────────────────── */

type Kind = "ctrl" | "mat" | "vec" | "sfu" | "mem" | "bus" | "io";

interface Module {
  id: string;
  name: string;
  rtl?: string;            // relative path to the SV source
  kind: Kind;
  purpose: string;
  ports?: string[];        // short port list (not full — just interesting)
  children?: Module[];
}

const HIERARCHY: Module = {
  id: "NPU_Top", name: "NPU_Top", rtl: "hw/rtl/NPU_Top.sv", kind: "ctrl",
  purpose: "pccx v002 top wrapper — AXI-Lite CSR + AXI-HP data path + clock/reset.",
  ports: ["i_clk", "i_rst_n", "s_axil[*]", "m_axi_hp0[*]", "m_axi_hp1[*]", "o_irq"],
  children: [
    {
      id: "Frontend", name: "ctrl_npu_frontend", rtl: "hw/rtl/FRONTEND/ctrl_npu_frontend.sv", kind: "ctrl",
      purpose: "Decodes AXI-Lite writes to the command queue, handles CSR reads, raises irq on completion.",
      ports: ["AXIL_CMD_IN", "AXIL_STAT_OUT"],
      children: [
        { id: "CmdQueue", name: "cmd_queue_fifo",     kind: "ctrl", purpose: "32-deep command FIFO." },
        { id: "Decoder",  name: "ctrl_npu_decoder",   rtl: "hw/rtl/FRONTEND/ctrl_npu_decoder.sv", kind: "ctrl",
          purpose: "ISA decode. Splits 32-bit packed opcodes into dispatch tokens." },
      ],
    },
    {
      id: "Dispatcher", name: "cu_npu_dispatcher", rtl: "hw/rtl/FRONTEND/cu_npu_dispatcher.sv", kind: "ctrl",
      purpose: "Routes decoded tokens to MAT_CORE / VEC_CORE / MEM_control + manages dispatch credits.",
      ports: ["token_in", "mat_token_out", "vec_token_out", "mem_token_out", "barrier_sync"],
    },
    {
      id: "MAT_CORE", name: "MAT_CORE", rtl: "hw/rtl/MAT_CORE/", kind: "mat",
      purpose: "32×32 systolic MAC array, W4A8 GEMM. 1024 DSP48E2 instances arranged on a Xilinx tile.",
      ports: ["instr_in", "fmap_in[31:0]", "weight_in[31:0]", "accum_out[31:0]"],
      children: [
        { id: "GemmSys",  name: "GEMM_systolic_top",        rtl: "hw/rtl/MAT_CORE/GEMM_systolic_top.sv",        kind: "mat", purpose: "32×32 DSP48E2 tile, staggered fmap feed." },
        { id: "WeightDisp", name: "GEMM_weight_dispatcher", rtl: "hw/rtl/MAT_CORE/GEMM_weight_dispatcher.sv",   kind: "mat", purpose: "Reorders K-major weight tiles to match the systolic schedule." },
        { id: "InstrDisp", name: "GEMM_instruction_dispatcher", rtl: "hw/rtl/MAT_CORE/GEMM_instruction_dispatcher.sv", kind: "mat", purpose: "Issues MAC opcodes + accumulator roll signals." },
        { id: "FmapStag", name: "GEMM_fmap_staggered_delay", rtl: "hw/rtl/MAT_CORE/GEMM_fmap_staggered_delay.sv", kind: "mat", purpose: "Inserts per-column delays to keep the array pipelined." },
        { id: "Accum",    name: "GEMM_accumulator",          rtl: "hw/rtl/MAT_CORE/GEMM_accumulator.sv",         kind: "mat", purpose: "Signed accumulator with overflow detect + roll." },
        { id: "Norm",     name: "mat_result_normalizer",     rtl: "hw/rtl/MAT_CORE/mat_result_normalizer.sv",    kind: "mat", purpose: "Scales + clamps 32b accum to BF16/INT8 output." },
        { id: "Packer",   name: "FROM_mat_result_packer",    rtl: "hw/rtl/MAT_CORE/FROM_mat_result_packer.sv",   kind: "mat", purpose: "Packs 4 normalized lanes per beat into the result FIFO." },
      ],
    },
    {
      id: "VEC_CORE", name: "VEC_CORE", rtl: "hw/rtl/VEC_CORE/", kind: "vec",
      purpose: "4-lane GEMV + SIMD elementwise. 5-stage pipeline, BF16.",
      ports: ["instr_in", "vec_in", "vec_out"],
      children: [
        { id: "GemvLane0", name: "gemv_lane[0]", kind: "vec", purpose: "Lane 0 — dot-product unit w/ reduce tree." },
        { id: "GemvLane1", name: "gemv_lane[1]", kind: "vec", purpose: "Lane 1." },
        { id: "GemvLane2", name: "gemv_lane[2]", kind: "vec", purpose: "Lane 2." },
        { id: "GemvLane3", name: "gemv_lane[3]", kind: "vec", purpose: "Lane 3." },
        { id: "Rotary",    name: "rotary_unit", kind: "vec", purpose: "RoPE pair-rotate, sin/cos table in BRAM scratchpad." },
        { id: "Residual",  name: "residual_add", kind: "vec", purpose: "32-lane BF16 add, fused with next-RMSNorm scale." },
      ],
    },
    {
      id: "SFU", name: "CVO (SFU)", rtl: "hw/rtl/SFU/", kind: "sfu",
      purpose: "Single special-function-unit instance — softmax / rsqrt / SiLU / exp approximations.",
      ports: ["op_kind", "vec_in", "vec_out", "ready"],
      children: [
        { id: "Softmax", name: "softmax_online", kind: "sfu", purpose: "Online softmax (Milakov & Gimelshein 2018) for attention scores." },
        { id: "Rsqrt",   name: "rsqrt_lut",      kind: "sfu", purpose: "Leading-zero + Newton-refine for 1/sqrt." },
        { id: "SiLU",    name: "silu_piecewise", kind: "sfu", purpose: "SiLU(x) = x·σ(x), piecewise-linear approx." },
      ],
    },
    {
      id: "MEM", name: "MEM_control", rtl: "hw/rtl/MEM_control/", kind: "mem",
      purpose: "Weight/fmap routing, URAM L2, HP Buffer FIFO, AXI master.",
      ports: ["token_in", "m_axi_hp0[*]", "m_axi_hp1[*]", "uram_rw[*]"],
      children: [
        { id: "AddrGen",   name: "mem_addr_gen_unit",   rtl: "hw/rtl/MEM_control/mem_addr_gen_unit.sv", kind: "mem", purpose: "Generates AXI addresses from tile descriptors." },
        { id: "OpQueue",   name: "mem_u_operation_queue", rtl: "hw/rtl/MEM_control/mem_u_operation_queue.sv", kind: "mem", purpose: "Queues memory ops; handles back-pressure." },
        { id: "FmapCache", name: "fmap_cache",          kind: "mem", purpose: "27-bit fmap cache (48 KB direct-mapped)." },
        { id: "URAM_L2",   name: "weight_uram_l2",      kind: "mem", purpose: "64 × Xilinx URAM, 1.75 MB, 72b × 4096." },
        { id: "HPBuf",     name: "hp_buffer_fifo",      kind: "mem", purpose: "Hide AXI-HP DRAM latency; 512-deep." },
      ],
    },
    {
      id: "AXI", name: "AXI SmartConnect", kind: "bus",
      purpose: "PS ↔ PL bus fabric. 3 HP ports + 1 ACP + 1 AXI-Lite.",
      children: [
        { id: "HP0", name: "m_axi_hp0", kind: "bus", purpose: "Weight stream read (AXI-HP, 128b)." },
        { id: "HP1", name: "m_axi_hp1", kind: "bus", purpose: "Activation read/write (AXI-HP, 128b)." },
        { id: "HP2", name: "m_axi_hp2", kind: "bus", purpose: "Result write-back (AXI-HP, 128b)." },
        { id: "ACP", name: "m_axi_acp", kind: "bus", purpose: "Latency-critical path to CPU cache (32b)." },
        { id: "AXIL", name: "s_axil",   kind: "bus", purpose: "Control / status register slave." },
      ],
    },
  ],
};

const KIND_COLOR: Record<Kind, string> = {
  ctrl: "#f59e0b",
  mat:  "#4fc1ff",
  vec:  "#c586c0",
  sfu:  "#dcdcaa",
  mem:  "#4ec86b",
  bus:  "#6b7280",
  io:   "#3b82f6",
};

/* ─── Cycle script — what each module is doing at a given cycle ─── */

type UnitState = "idle" | "busy" | "stall" | "done";

// Keyed by module id. Each entry is a list of (cycle, state, note?) spans.
const CYCLE_SCRIPT: Record<string, { start: number; end: number; state: UnitState; note?: string }[]> = {
  "Frontend":   [{ start:  0, end:  30, state: "busy", note: "AXIL write → cmd_queue" }, { start: 30, end: 1024, state: "idle" }],
  "Decoder":    [{ start: 30, end:  40, state: "busy", note: "decode GEMM.32x32" }, { start: 40, end: 1024, state: "idle" }],
  "Dispatcher": [{ start: 40, end:  60, state: "busy", note: "issue to MAT_CORE + MEM" }, { start: 60, end: 1024, state: "idle" }],
  "MAT_CORE":   [{ start: 60, end: 150, state: "stall", note: "waiting on first weight tile" }, { start: 150, end: 950, state: "busy", note: "1024 MAC × 32 rows" }, { start: 950, end: 1024, state: "done" }],
  "GemmSys":    [{ start: 150, end: 950, state: "busy", note: "systolic flow" }],
  "WeightDisp": [{ start: 60, end: 900, state: "busy", note: "K-major tile feed" }],
  "InstrDisp":  [{ start: 60, end: 950, state: "busy" }],
  "Accum":      [{ start: 150, end: 950, state: "busy", note: "rolling accumulate" }],
  "Norm":       [{ start: 950, end: 980, state: "busy", note: "BF16 normalize" }],
  "Packer":     [{ start: 980, end: 1000, state: "busy" }],
  "VEC_CORE":   [{ start: 400, end: 600, state: "busy", note: "co-issued RoPE" }],
  "Rotary":     [{ start: 400, end: 600, state: "busy" }],
  "SFU":        [{ start: 700, end: 820, state: "busy", note: "online softmax" }],
  "Softmax":    [{ start: 700, end: 820, state: "busy" }],
  "MEM":        [{ start: 60, end: 1024, state: "busy" }],
  "AddrGen":    [{ start: 60, end: 1024, state: "busy" }],
  "OpQueue":    [{ start: 60, end: 1024, state: "busy" }],
  "FmapCache":  [{ start: 100, end: 900, state: "busy" }],
  "URAM_L2":    [{ start: 60, end: 900, state: "busy" }],
  "HPBuf":      [{ start: 0, end: 300, state: "stall", note: "DRAM warm-up" }, { start: 300, end: 1024, state: "busy" }],
  "AXI":        [{ start: 0, end: 1024, state: "busy" }],
  "HP0":        [{ start: 0, end: 900, state: "busy", note: "weight stream" }],
  "HP1":        [{ start: 60, end: 1024, state: "busy", note: "fmap r/w" }],
  "HP2":        [{ start: 950, end: 1024, state: "busy", note: "result write-back" }],
};

function stateAtCycle(id: string, cyc: number): { state: UnitState; note?: string } {
  const spans = CYCLE_SCRIPT[id];
  if (!spans) return { state: "idle" };
  for (const s of spans) {
    if (cyc >= s.start && cyc < s.end) return { state: s.state, note: s.note };
  }
  return { state: "idle" };
}

function stateColor(s: UnitState, t: ReturnType<typeof useTheme>): string {
  if (s === "busy")  return t.accent;
  if (s === "stall") return t.error;
  if (s === "done")  return t.success;
  return t.borderDim;
}

/* ─── Block-diagram topology (node-id only; coords come from ELK) ────
 * Per Schulze/Spönemann/von Hanxleden ACM TOCHI 2014 (doi:10.1145/2629477)
 * and Gansner/Koutsofios/North/Vo IEEE TSE 1993, the four-phase layered
 * algorithm produces stable positions from structure alone. Sizes are
 * kind-driven (control lanes narrow, cores tall). Edges carry the
 * `event_type` id they belong to so trace events can light them up.  */

// Event type IDs must match `src/core/src/trace.rs::event_type_id`.
const EV_MAC_COMPUTE    = 1;
const EV_DMA_READ       = 2;
const EV_DMA_WRITE      = 3;
const EV_SYSTOLIC_STALL = 4;
const EV_BARRIER_SYNC   = 5;

interface DiagramNode { id: string; w: number; h: number; }
interface DiagramEdge {
  from: string; to: string; label?: string;
  eventTypes: number[];                  // trace-driven alive()
  fallback: (c: number) => boolean;       // old literal range
}

const DIAGRAM_NODES: DiagramNode[] = [
  { id: "Frontend",   w: 196, h: 46 },
  { id: "Decoder",    w: 196, h: 40 },
  { id: "Dispatcher", w: 196, h: 40 },
  { id: "MAT_CORE",   w: 240, h: 96 },
  { id: "VEC_CORE",   w: 240, h: 60 },
  { id: "SFU",        w: 240, h: 60 },
  { id: "MEM",        w: 240, h: 116 },
  { id: "AXI",        w: 240, h: 80 },
  { id: "HP0",        w: 64,  h: 24 },
  { id: "HP1",        w: 64,  h: 24 },
  { id: "HP2",        w: 64,  h: 24 },
  { id: "AXIL",       w: 64,  h: 24 },
];

const DIAGRAM_EDGES: DiagramEdge[] = [
  { from: "Frontend",   to: "Decoder",    eventTypes: [EV_BARRIER_SYNC],              fallback: c => c >= 20 && c < 60 },
  { from: "Decoder",    to: "Dispatcher", eventTypes: [EV_BARRIER_SYNC],              fallback: c => c >= 30 && c < 80 },
  { from: "Dispatcher", to: "MAT_CORE",   eventTypes: [EV_MAC_COMPUTE, EV_SYSTOLIC_STALL], fallback: c => c >= 40 && c < 950 },
  { from: "Dispatcher", to: "VEC_CORE",   eventTypes: [EV_BARRIER_SYNC],              fallback: c => c >= 400 && c < 600, label: "RoPE" },
  { from: "Dispatcher", to: "SFU",        eventTypes: [EV_BARRIER_SYNC],              fallback: c => c >= 700 && c < 820, label: "softmax" },
  { from: "Dispatcher", to: "MEM",        eventTypes: [EV_DMA_READ, EV_DMA_WRITE],    fallback: c => c >= 40 && c < 1024 },
  { from: "MEM",        to: "MAT_CORE",   eventTypes: [EV_DMA_READ],                  fallback: c => c >= 60 && c < 900, label: "weight/fmap" },
  { from: "MAT_CORE",   to: "MEM",        eventTypes: [EV_DMA_WRITE],                 fallback: c => c >= 950 && c < 1024, label: "result" },
  { from: "MEM",        to: "AXI",        eventTypes: [EV_DMA_READ, EV_DMA_WRITE],    fallback: c => c >= 0 && c < 1024 },
  { from: "AXI",        to: "HP0",        eventTypes: [EV_DMA_READ],                  fallback: c => c >= 0 && c < 900 },
  { from: "AXI",        to: "HP1",        eventTypes: [EV_DMA_READ, EV_DMA_WRITE],    fallback: c => c >= 60 && c < 1024 },
  { from: "AXI",        to: "HP2",        eventTypes: [EV_DMA_WRITE],                 fallback: c => c >= 950 && c < 1024 },
  { from: "AXI",        to: "AXIL",       eventTypes: [EV_BARRIER_SYNC],              fallback: c => c >= 0 && c < 30 },
];

/** ELK-layered graph factory. Uses algorithm=layered + FIXED_SIDE ports
 * (Schulze 2014) so AXI-HP / ACP pins stay on the right side mirroring
 * AMD UG904 device-view convention. */
function buildElkGraph(viewportW: number, viewportH: number): ElkNode {
  const children: ElkNode[] = DIAGRAM_NODES.map(n => ({
    id: n.id, width: n.w, height: n.h,
  }));
  const edges: ElkExtendedEdge[] = DIAGRAM_EDGES.map((e, i) => ({
    id: `e${i}`, sources: [e.from], targets: [e.to],
  }));
  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.spacing.nodeNode": "18",
      "elk.padding": "[top=26,left=20,bottom=20,right=20]",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.aspectRatio": String(Math.max(1, viewportW / Math.max(1, viewportH))),
    },
    children, edges,
  };
}

// Minimal trace event shape; mirrors FlameGraph parser.
interface TraceEv { coreId: number; startCycle: number; duration: number; typeId: number; }

// Keep in sync with `NpuTrace::FLAT_BUFFER_V2_MAGIC` ("PCC2" LE).
const FLAT_BUFFER_V2_MAGIC = 0x3243_4350;

function parseTraceFlat(buf: Uint8Array): TraceEv[] {
  const out: TraceEv[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stride = 24;

  // V2: stop at trailer magic if present; HardwareVisualizer only
  // needs the event-array fields, not the name_table.
  let eventEnd = Math.floor(buf.byteLength / stride) * stride;
  for (let off = 0; off + 8 <= buf.byteLength; off += stride) {
    if (view.getUint32(off, true) === FLAT_BUFFER_V2_MAGIC) {
      eventEnd = off;
      break;
    }
  }

  for (let off = 0; off + stride <= eventEnd; off += stride) {
    out.push({
      coreId:     view.getUint32(off, true),
      startCycle: Number(view.getBigUint64(off + 4, true)),
      duration:   Number(view.getBigUint64(off + 12, true)),
      typeId:     view.getUint32(off + 20, true),
    });
  }
  return out;
}

/** Trace-driven alive(): edge lights up when an event of a matching
 * `typeId` is within [cycle-16, cycle+16]. Falls back to the literal
 * cycle window when no trace has loaded. */
function edgeAlive(edge: DiagramEdge, cycle: number, events: TraceEv[]): boolean {
  if (events.length === 0) return edge.fallback(cycle);
  const lo = cycle - 16, hi = cycle + 16;
  const wanted = edge.eventTypes;
  for (const ev of events) {
    if (!wanted.includes(ev.typeId)) continue;
    const s = ev.startCycle, e = ev.startCycle + ev.duration;
    if (e >= lo && s <= hi) return true;
  }
  return false;
}

/* ─── Flatten helpers ──────────────────────────────────────────────── */

function walk(m: Module, depth: number, out: { m: Module; depth: number }[]) {
  out.push({ m, depth });
  for (const c of m.children ?? []) walk(c, depth + 1, out);
}

export function HardwareVisualizer() {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // Round-6 T-3: two-layer canvas — `staticCanvasRef` paints the ELK
  // box + label geometry once per layout change; `canvasRef` is the
  // dynamic overlay redrawn per RAF (packet dot, state dots, cursor
  // line).  Perfetto's "grid vs slice" compositing pattern, applied to
  // the same HardwareVisualizer panel.
  const staticCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const rootRef      = useRef<HTMLDivElement>(null);
  // Round-6 T-3: visibility gate — pauses the RAF loop when the panel
  // is hidden (tab switched / docked panel collapsed).  Matches
  // MDN Page Visibility + IntersectionObserver spec semantics; a tab
  // switch stops CPU usage within one frame.  See useVisibilityGate.ts.
  const panelVisible = useVisibilityGate(rootRef);
  // Round-6 T-3: per-frame RAF scheduler.  Replaces both the legacy
  // 50-ms interval cycle tick AND the full-canvas redraw effect with a
  // coalesced dirty-commit pattern (Perfetto raf-scheduler idiom).
  // See useRafScheduler.ts.
  const sched = useRafScheduler();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ NPU_Top: true, MAT_CORE: true, MEM: true });
  const [selected, setSelected] = useState<string>("MAT_CORE");
  const [filter,   setFilter]   = useState("");
  // ─── Round-6 T-1: unified cycle cursor ─────────────────────────────
  // Single source of truth shared with Timeline / Waveform / FlameGraph
  // so "go to cycle N" and Arrow-key stepping stay in lock-step across
  // every time-domain panel. Keyboard bindings (ArrowLeft/Right,
  // Shift+Arrow, Ctrl+G / g, ., ,) are attached further down via
  // `attachCycleKeybindings` on `rootRef`.
  const cursor = useCycleCursor();
  const cycle  = cursor.cycle;
  const setCycle = cursor.setCycle;
  const [playing,  setPlaying]  = useState(true);
  const [speed,    setSpeed]    = useState(1);
  // Cycles-per-tick: 1 cycle at 1× speed, user-editable — replaces the
  // old `Math.floor(4 * speed)` residue that made Shift-stepping drift.
  const [cyclesPerTick, setCyclesPerTick] = useState(1);
  // ELK-computed node rectangles.  Populated on mount + on resize.
  const [layout, setLayout] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  // Trace events (drives edgeAlive); empty → edges fall back to cycle ranges.
  const [traceEvents, setTraceEvents] = useState<TraceEv[]>([]);

  // Derive max cycle from the trace when present — fall back to 1024
  // when the panel is still in onboarding / demo mode.  Also pushes
  // into the shared `useCycleCursor` store so every other panel sees
  // the same upper bound.
  const maxCycle = useMemo(() => {
    if (traceEvents.length === 0) return 1024;
    let m = 0;
    for (const ev of traceEvents) {
      const end = ev.startCycle + ev.duration;
      if (end > m) m = end;
    }
    return Math.max(m, 1);
  }, [traceEvents]);

  useEffect(() => {
    cursor.setTotalCycles(maxCycle);
  }, [maxCycle, cursor]);

  // Stable ref to the current cycle — sampled inside the RAF loop so
  // the rAF closure doesn't have to depend on `cycle` (which would
  // cancel + re-subscribe on every tick and leak callbacks).
  const cycleRef = useRef(cycle);
  useEffect(() => { cycleRef.current = cycle; }, [cycle]);

  // Round-6 T-3: auto-advance is driven by a `requestAnimationFrame`
  // loop using `performance.now()` delta rather than the legacy
  // 50-ms interval.  Decouples cycle advancement from frame rate
  // (browsers throttle RAF to 60 Hz; off-screen tabs pause
  // automatically per MDN spec + our `useVisibilityGate` guard).
  // Cycle value semantics stay identical to T-1: at 1× speed and
  // default `cyclesPerTick=1`, we advance exactly 1 cycle per 1/60 s.
  // See Perfetto raf-scheduler idiom (perfetto.dev/docs/contributing/ui-plugins).
  useEffect(() => {
    if (!playing || !panelVisible) return;
    const stepBase = Math.max(1, Math.floor(cyclesPerTick));
    // Target the same ~20 Hz cycle-advance rate as the old 50 ms
    // interval — step once per 50 ms-equivalent of elapsed wall-clock.
    // Multiplied by `speed` to match the legacy semantics.
    const CYCLE_PERIOD_MS = 50;
    let lastTs = performance.now();
    let rafId = 0;
    const tick = (ts: number) => {
      const dt = ts - lastTs;
      if (dt >= CYCLE_PERIOD_MS) {
        const ticks = Math.floor(dt / CYCLE_PERIOD_MS);
        lastTs += ticks * CYCLE_PERIOD_MS;
        const delta = Math.max(1, Math.round(stepBase * speed)) * ticks;
        const next = (cycleRef.current + delta) % Math.max(1, maxCycle);
        setCycle(next);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, panelVisible, speed, cyclesPerTick, maxCycle, setCycle]);

  // Attach panel-scoped keyboard bindings for single-cycle control.
  useEffect(() => {
    return attachCycleKeybindings(rootRef.current, cursor);
  }, [cursor]);

  // Numeric "go to cycle N" input sharing the shared cursor's clamp.
  const goTo = useGoToCycleInput(cursor);

  const flat = useMemo(() => {
    const out: { m: Module; depth: number }[] = [];
    walk(HIERARCHY, 0, out);
    return out;
  }, []);

  const visible = useMemo(() => {
    const out: { m: Module; depth: number }[] = [];
    const visit = (m: Module, depth: number) => {
      const match = !filter || m.name.toLowerCase().includes(filter.toLowerCase()) || m.id.toLowerCase().includes(filter.toLowerCase());
      if (match) out.push({ m, depth });
      if (expanded[m.id] || filter) for (const c of m.children ?? []) visit(c, depth + 1);
    };
    visit(HIERARCHY, 0);
    return out;
  }, [expanded, filter]);

  const selectedMod = useMemo(() => flat.find(n => n.m.id === selected)?.m ?? HIERARCHY, [flat, selected]);
  const selState = stateAtCycle(selected, cycle);

  /* ─── Trace events (once on mount) ───────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await invoke<Uint8Array>("fetch_trace_payload");
        const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload as ArrayBufferLike);
        if (bytes.byteLength >= 24 && !cancelled) {
          setTraceEvents(parseTraceFlat(bytes));
        }
      } catch { /* keep empty; edges fall back to literal cycle windows */ }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ─── ELK auto-layout (mount + resize) ─────────────────────────
   * Builds a `layered` graph from DIAGRAM_NODES/EDGES and stores the
   * computed x/y/w/h per id. On throw we keep the last successful
   * layout (empty → draw cycle pauses gracefully).  */
  useEffect(() => {
    const wrap = containerRef.current;
    if (!wrap) return;
    const elk = new ELK();

    const runLayout = async () => {
      const rect = wrap.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const graph = buildElkGraph(rect.width, rect.height);
      try {
        const res = await elk.layout(graph);
        const next: Record<string, { x: number; y: number; w: number; h: number }> = {};
        for (const c of res.children ?? []) {
          next[c.id] = {
            x: c.x ?? 0, y: c.y ?? 0,
            w: c.width ?? 100, h: c.height ?? 40,
          };
        }
        setLayout(next);
      } catch { /* keep previous layout on error */ }
    };

    runLayout();
    const ro = new ResizeObserver(() => { runLayout(); });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  /* ─── Block-diagram canvas — Round-6 T-3 two-layer compositing ──
   *
   * Layer (a) — STATIC: painted exactly once per layout/theme/selected
   * change into the back canvas (`staticCanvasRef`).  Contains the
   * ELK-laid module boxes, header strips, text, and edge geometry.
   * A `console.count('static-redraw')` hook stays in place during
   * development; removed before commit.
   *
   * Layer (b) — DYNAMIC: painted per RAF into the front canvas
   * (`canvasRef`).  Contains only what depends on `cycle` — edge
   * "alive" highlight, packet dots, state dots / busy-pulse, cursor
   * line, cycle label.  Coalesced through `sched.schedule("hwvis-dyn")`
   * so mouse-driven cycle changes never fire more than one RAF draw.
   *
   * See research_findings.md T-C (Perfetto "grid vs slice" compositing)
   * and MDN Page Visibility API — hidden tabs pause both layers via
   * `useVisibilityGate`. */

  // ── Static layer: ELK boxes + labels + edge geometry ────────────
  useEffect(() => {
    const canvas = staticCanvasRef.current;
    const wrap = containerRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width  = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width  = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (Object.keys(layout).length === 0) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillText("ELK auto-layout pending…", 16, 22);
      return;
    }

    // Edge geometry — drawn "dim" here; the dynamic layer overlays
    // the live highlight so we don't have to repaint this per cycle.
    for (const e of DIAGRAM_EDGES) {
      const a = layout[e.from]; const b = layout[e.to];
      if (!a || !b) continue;
      ctx.strokeStyle = theme.borderDim;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x + a.w, a.y + a.h / 2);
      const mx = (a.x + a.w + b.x) / 2;
      ctx.bezierCurveTo(mx, a.y + a.h / 2, mx, b.y + b.h / 2, b.x, b.y + b.h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Module boxes + labels — static part (everything except state dot).
    ctx.font = "11px Inter, sans-serif";
    ctx.textBaseline = "middle";
    for (const [id, p] of Object.entries(layout)) {
      const mod = flat.find(n => n.m.id === id)?.m;
      const baseColor = mod ? KIND_COLOR[mod.kind] : theme.borderDim;
      const stroke = id === selected ? theme.accent : theme.border;

      ctx.fillStyle = theme.bgSurface;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = id === selected ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, 6);
      ctx.fill();
      ctx.stroke();

      // Dim header — dynamic layer will repaint in full colour when
      // the module is active at the current cycle.
      ctx.fillStyle = baseColor + "55";
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, 18, [6, 6, 0, 0]);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(mod?.name ?? id, p.x + 6, p.y + 9);
    }
  }, [theme, selected, flat, layout]);

  // ── Dynamic layer draw fn — captures latest cycle/traceEvents/etc.
  // via closure, scheduled through RAF coalescer.
  // Perfetto raf-scheduler idiom, see hooks/useRafScheduler.ts.
  useEffect(() => {
    const paint = () => {
      const canvas = canvasRef.current;
      const wrap = containerRef.current;
      if (!canvas || !wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = wrap.getBoundingClientRect();
      if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width  = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width  = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      ctx.save();
      ctx.scale(dpr, dpr);

      if (Object.keys(layout).length === 0) { ctx.restore(); return; }

      // Live edge highlight + packet dot (dynamic overlay on top of
      // the dim geometry painted by the static layer).
      for (const e of DIAGRAM_EDGES) {
        const a = layout[e.from]; const b = layout[e.to];
        if (!a || !b) continue;
        if (!edgeAlive(e, cycle, traceEvents)) continue;
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(a.x + a.w, a.y + a.h / 2);
        const mx = (a.x + a.w + b.x) / 2;
        ctx.bezierCurveTo(mx, a.y + a.h / 2, mx, b.y + b.h / 2, b.x, b.y + b.h / 2);
        ctx.stroke();

        if (e.label) {
          ctx.fillStyle = theme.accent;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(e.label, mx - 20, (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 4);
        }

        // Packet dot — ornamental, along the bezier midpoint.
        const phase = (cycle / 40) % 1;
        const t = phase;
        const ax = a.x + a.w, ay = a.y + a.h / 2;
        const bx = b.x, by = b.y + b.h / 2;
        const x = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * mx + t * t * bx;
        const y = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * ay + t * t * by;
        ctx.fillStyle = theme.accent;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      }

      // Active-module header recolour + state dot + pulse.
      ctx.font = "11px Inter, sans-serif";
      ctx.textBaseline = "middle";
      for (const [id, p] of Object.entries(layout)) {
        const state = stateAtCycle(id, cycle);
        const mod = flat.find(n => n.m.id === id)?.m;
        const baseColor = mod ? KIND_COLOR[mod.kind] : theme.borderDim;
        const isActive = state.state === "busy" || state.state === "stall" || state.state === "done";

        if (isActive) {
          // Repaint header in full colour on top of the static dim strip.
          ctx.fillStyle = baseColor;
          ctx.beginPath();
          ctx.roundRect(p.x, p.y, p.w, 18, [6, 6, 0, 0]);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "left";
          ctx.fillText(mod?.name ?? id, p.x + 6, p.y + 9);
        }

        const dotColor = stateColor(state.state, theme);
        ctx.fillStyle = dotColor;
        ctx.beginPath(); ctx.arc(p.x + p.w - 10, p.y + 9, 4, 0, Math.PI * 2); ctx.fill();
        if (state.state === "busy") {
          const pulse = playing ? 0.5 + 0.5 * Math.sin(cycle * 0.2) : 1.0;
          ctx.globalAlpha = pulse * 0.4;
          ctx.beginPath(); ctx.arc(p.x + p.w - 10, p.y + 9, 7, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }

        if (p.h > 30) {
          ctx.fillStyle = theme.textDim;
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(state.note ?? state.state, p.x + 6, p.y + 32);
          ctx.font = "11px Inter, sans-serif";
        }
      }

      ctx.fillStyle = theme.textMuted;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(`cycle ${cycle}`, rect.width - 90, rect.height - 10);
      ctx.restore();
    };

    // Schedule through the RAF coalescer — repeated cycle changes
    // within a single frame collapse to one paint.
    sched.schedule("hwvis-dyn", paint);
    return () => sched.cancel("hwvis-dyn");
  }, [cycle, theme, selected, flat, layout, traceEvents, playing, sched]);

  return (
    <div ref={rootRef} tabIndex={0} className="w-full h-full flex flex-col outline-none" style={{ background: theme.bgPanel }}>
      {/* Header */}
      <div className="flex items-center px-4 shrink-0 gap-3" style={{ height: 40, borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
        <Cpu size={16} style={{ color: theme.accent }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>System Simulator — pccx v002 / KV260 ZU5EV</span>
        <span style={{ fontSize: 10, color: theme.textMuted }}>
          6 top modules · {flat.length} total · 1 GHz core · cycle-accurate script
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1 mr-3">
          <button
            aria-label="Skip back one cycle (Shift-click: 32 cycles)"
            title="Click: -1 cycle · Shift-click: -32 cycles · Arrow ← also steps"
            onClick={(e) => setCycle(Math.max(0, cycle - (e.shiftKey ? 32 : 1)))}
            style={iconBtn(theme)}><SkipBack size={12}/></button>
          <button onClick={() => setPlaying(p => !p)} style={{ ...iconBtn(theme), background: playing ? theme.warning : theme.success, color: "#fff" }}>
            {playing ? <Pause size={12}/> : <Play size={12}/>}
          </button>
          <button
            aria-label="Skip forward one cycle (Shift-click: 32 cycles)"
            title="Click: +1 cycle · Shift-click: +32 cycles · Arrow → also steps"
            onClick={(e) => setCycle(Math.min(maxCycle, cycle + (e.shiftKey ? 32 : 1)))}
            style={iconBtn(theme)}><SkipForward size={12}/></button>
          <button onClick={() => { setCycle(0); setPlaying(false); }} style={iconBtn(theme)}><RotateCcw size={12}/></button>
          <select value={speed} onChange={e => setSpeed(Number(e.target.value))}
                  style={{ marginLeft: 6, fontSize: 10, padding: "2px 4px", background: theme.bgInput, border: `0.5px solid ${theme.borderSubtle}`, color: theme.text, borderRadius: 3 }}>
            <option value={0.25}>0.25×</option><option value={0.5}>0.5×</option>
            <option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option>
          </select>
          <label style={{ fontSize: 9, color: theme.textMuted, marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 4 }}
                 title="Cycles advanced per auto-tick. 1 = honest single-clock stepping.">
            cy/tick
            <input
              type="number" min={1} step={1} value={cyclesPerTick}
              onChange={e => setCyclesPerTick(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              style={{ width: 46, fontSize: 10, padding: "1px 4px", background: theme.bgInput, border: `0.5px solid ${theme.borderSubtle}`, color: theme.text, borderRadius: 3 }}
            />
          </label>
          <label style={{ fontSize: 9, color: theme.textMuted, marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 4 }}
                 title="Go to cycle N — Enter to commit. Ctrl+G or g opens a prompt from anywhere in this panel.">
            go to
            <input
              type="number" min={0} max={maxCycle} placeholder={`0–${maxCycle}`}
              value={goTo.value}
              onChange={e => goTo.setValue(e.target.value)}
              onKeyDown={goTo.onKeyDown}
              onBlur={goTo.commit}
              style={{ width: 70, fontSize: 10, padding: "1px 4px", background: theme.bgInput, border: `0.5px solid ${theme.borderSubtle}`, color: theme.text, borderRadius: 3 }}
            />
          </label>
        </div>
      </div>

      {/* Scrubber */}
      <div className="px-4 py-2 shrink-0 flex items-center gap-3" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgSurface }}>
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: theme.fontMono, width: 100 }}>cyc {cycle.toString().padStart(4, "0")} / {maxCycle}</span>
        <input
          type="range" min={0} max={maxCycle} value={cycle}
          // Shift held → step 1 cycle at a time (honest single-clock
          // resolution).  Plain drag uses the `step` prop of 1 too,
          // so every pixel resolves a cycle. Round-6 T-1 user directive.
          step={1}
          onChange={e => setCycle(Number(e.target.value))}
          style={{ flex: 1, accentColor: theme.accent }}/>
        <span style={{ fontSize: 9, color: theme.textMuted }}>{(cycle / 1000).toFixed(3)} µs @ 1 GHz</span>
      </div>

      <div className="flex-1 grid overflow-hidden" style={{ gridTemplateColumns: "260px 1fr 320px" }}>
        {/* Left: hierarchy tree */}
        <div className="flex flex-col overflow-hidden" style={{ borderRight: `0.5px solid ${theme.borderSubtle}`, background: theme.bgEditor }}>
          <div className="flex items-center gap-2 px-2 py-1.5" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgPanel }}>
            <Search size={12} style={{ color: theme.textMuted }}/>
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter modules"
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 10, color: theme.text }}/>
          </div>
          <div className="flex-1 overflow-auto py-1" style={{ fontSize: 11 }}>
            {visible.map(({ m, depth }) => {
              const st = stateAtCycle(m.id, cycle);
              const hasKids = (m.children?.length ?? 0) > 0;
              const isOpen = !!expanded[m.id] || !!filter;
              return (
                <div key={m.id}
                  onClick={() => setSelected(m.id)}
                  style={{
                    display: "flex", alignItems: "center",
                    padding: `3px 6px 3px ${8 + depth * 14}px`,
                    cursor: "pointer",
                    background: m.id === selected ? theme.accentBg : "transparent",
                    color: m.id === selected ? theme.accent : theme.text,
                    borderLeft: m.id === selected ? `2px solid ${theme.accent}` : "2px solid transparent",
                  }}>
                  {hasKids ? (
                    <span onClick={e => { e.stopPropagation(); setExpanded(x => ({ ...x, [m.id]: !x[m.id] })); }}
                      style={{ marginRight: 3, color: theme.textMuted, display: "inline-flex" }}>
                      {isOpen ? <ChevronDown size={10}/> : <ChevronRight size={10}/>}
                    </span>
                  ) : <span style={{ width: 13, display: "inline-block" }}/>}
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: KIND_COLOR[m.kind], marginRight: 6 }}/>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</span>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor(st.state, theme), marginLeft: 4, opacity: st.state === "idle" ? 0.3 : 1 }}/>
                </div>
              );
            })}
          </div>
        </div>

        {/* Center: live block diagram — Round-6 T-3 two-layer compositing.
            Static layer (module geometry + labels) paints once per layout
            change; dynamic layer (cycle-driven highlight, packet dot,
            pulse, cycle label) paints per RAF via useRafScheduler.  */}
        <div ref={containerRef} className="relative overflow-hidden" style={{ background: theme.bg }}>
          <canvas ref={staticCanvasRef} className="absolute inset-0" />
          <canvas ref={canvasRef} className="absolute inset-0" />
        </div>

        {/* Right: inspector */}
        <div className="flex flex-col overflow-auto" style={{ borderLeft: `0.5px solid ${theme.borderSubtle}`, background: theme.bgEditor }}>
          <div style={{ padding: "8px 12px", borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgPanel }}>
            <div style={{ fontSize: 9, color: theme.textMuted, letterSpacing: "0.05em" }}>INSPECTOR</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: KIND_COLOR[selectedMod.kind] }}/>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: theme.text }}>{selectedMod.name}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, padding: "1px 6px", borderRadius: 3, background: stateColor(selState.state, theme), color: "#fff", fontWeight: 700 }}>
                {selState.state.toUpperCase()}
              </span>
            </div>
            {selectedMod.rtl && (
              <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>{selectedMod.rtl}</div>
            )}
          </div>
          <div className="p-3 space-y-3" style={{ fontSize: 11, color: theme.textDim }}>
            <section>
              <SectionTitle>Purpose</SectionTitle>
              <p style={{ lineHeight: 1.5, color: theme.text }}>{selectedMod.purpose}</p>
            </section>
            {selState.note && (
              <section>
                <SectionTitle>What it's doing now</SectionTitle>
                <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, color: theme.accent }}>{selState.note}</p>
              </section>
            )}
            {selectedMod.ports && (
              <section>
                <SectionTitle>Ports (selected)</SectionTitle>
                <ul style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, lineHeight: 1.6 }}>
                  {selectedMod.ports.map(p => (
                    <li key={p} style={{ color: theme.textDim }}>
                      <span style={{ color: p.startsWith("i_") ? theme.success : p.startsWith("o_") ? theme.warning : theme.textMuted }}>{p}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <SectionTitle>Activity timeline</SectionTitle>
              <div style={{ height: 20, background: theme.bgSurface, borderRadius: 3, position: "relative", overflow: "hidden" }}>
                {(CYCLE_SCRIPT[selected] ?? []).map((s, i) => (
                  <div key={i} style={{
                    position: "absolute",
                    left: `${(s.start / 1024) * 100}%`,
                    width: `${((s.end - s.start) / 1024) * 100}%`,
                    top: 0, bottom: 0,
                    background: stateColor(s.state, theme),
                    opacity: s.state === "idle" ? 0.15 : 0.7,
                  }} title={`${s.start}–${s.end} ${s.state}`} />
                ))}
                <div style={{ position: "absolute", left: `${(cycle / 1024) * 100}%`, top: 0, bottom: 0, width: 2, background: "#fff" }}/>
              </div>
            </section>
            {(selectedMod.children?.length ?? 0) > 0 && (
              <section>
                <SectionTitle>Sub-modules ({selectedMod.children!.length})</SectionTitle>
                <ul style={{ fontSize: 10, lineHeight: 1.5 }}>
                  {selectedMod.children!.map(c => {
                    const cs = stateAtCycle(c.id, cycle);
                    return (
                      <li key={c.id} onClick={() => setSelected(c.id)}
                          style={{ cursor: "pointer", padding: "2px 4px", display: "flex", alignItems: "center", gap: 6, borderRadius: 3 }}
                          className="hover:bg-white/5">
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: KIND_COLOR[c.kind] }}/>
                        <span style={{ fontFamily: "ui-monospace, monospace", flex: 1, color: theme.text }}>{c.name}</span>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: stateColor(cs.state, theme), opacity: cs.state === "idle" ? 0.3 : 1 }}/>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="shrink-0 flex items-center gap-4 px-4 py-1.5" style={{ borderTop: `0.5px solid ${theme.borderSubtle}`, background: theme.bgSurface, fontSize: 10, color: theme.textMuted }}>
        <Legend color={theme.accent}  label="busy"/>
        <Legend color={theme.error}   label="stall"/>
        <Legend color={theme.success} label="done"/>
        <Legend color={theme.borderDim} label="idle"/>
        <div className="flex-1" />
        <span>pccx v002 · W4A8 GEMM · BF16 GEMV · cycle-scripted</span>
      </div>
    </div>
  );
}

function iconBtn(theme: ReturnType<typeof useTheme>): React.CSSProperties {
  return {
    padding: "4px 6px", fontSize: 10, background: theme.bgSurface,
    border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 3,
    color: theme.textDim, cursor: "pointer",
    display: "inline-flex", alignItems: "center", gap: 4,
  };
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <div style={{
      fontSize: 9, color: theme.textMuted, marginBottom: 4,
      letterSpacing: "0.05em", textTransform: "uppercase",
    }}>{children}</div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }}/>
      {label}
    </span>
  );
}
