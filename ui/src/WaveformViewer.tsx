import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "./ThemeContext";
import { useLiveWindow } from "./hooks/useLiveWindow";
import { useCycleCursor, useGoToCycleInput } from "./hooks/useCycleCursor";
// Round-6 T-3: coalesce ResizeObserver + cursor-driven redraws into a
// single RAF paint per frame (Perfetto raf-scheduler idiom).  A
// rapid-fire flex resize used to call draw() per observer tick; the
// scheduler reduces that to one paint per vsync.
import { useRafScheduler } from "./hooks/useRafScheduler";
import {
  Activity, ZoomIn, ZoomOut, Maximize2, Search, Download,
  Filter, X, Crosshair, Bookmark,
} from "lucide-react";

// ─── Signal model ────────────────────────────────────────────────────────────

type Radix = "bin" | "oct" | "hex" | "dec" | "ascii";

interface Event {
  /** Tick (raw VCD time unit, or cycle for demo data). */
  t: number;
  /** Value. For wires: 0/1/'x'/'z'. For buses: number / bit-string / state. */
  v: number | string;
}

interface Signal {
  id:    string;
  name:  string;
  scope: string;       // hierarchical path — ctrl / mat / cvo / mem …
  width: number;       // 1 for wires, N for buses
  radix: Radix;
  events: Event[];
}

interface Group {
  id: string;
  name: string;
  expanded: boolean;
  children: Signal[];
  /** Ordered list of dividers inserted between signals in this group.
   *  `afterSigId: null` means before the first signal. */
  separators?: Array<{ id: string; afterSigId: string | null; label: string }>;
}

// Payload shape returned by `parse_vcd_file` in pccx_core.
interface SignalMeta { id: string; name: string; scope: string; width: number; }
interface VcdChange  { sig_id: string; tick: number; value: string; }
interface WaveformDump {
  signals: SignalMeta[];
  events:  VcdChange[];
  timescale_ps: number | null;
}

// ─── Annotation model ────────────────────────────────────────────────────────
// Keyed by signal.id (not signal.name) to survive name collisions across
// different scopes (e.g., `clk` in `ctrl` vs another scope).

type AnnotationSeverity = "info" | "warning" | "error";

interface Annotation {
  cycle: number;
  text: string;
  severity: AnnotationSeverity;
}

// ─── Demo workload - configured pccx v002 one GEMV dispatch ──────────────────
// Used only when no real VCD has been loaded. First-run onboarding affordance.

function makeDemo(): Group[] {
  // 250 MHz AXI-Lite + 400 MHz core_clk, expressed in ps (resolution 1 ps).
  // 1 tick = 2500 ps on the AXI side, 2500 ps / 1.6 on the core side, but we
  // simplify and put every transition on an integer cycle.
  const CLK_HI = 1;
  const CLK_LO = 0;
  const N_CYC  = 200;

  const clkEvents: Event[] = [];
  const coreEvents: Event[] = [];
  for (let c = 0; c <= N_CYC; c++) {
    clkEvents.push({ t: c * 2, v: c % 2 ? CLK_HI : CLK_LO });
    coreEvents.push({ t: c * 1, v: c % 2 ? CLK_HI : CLK_LO });
  }

  const ctrl: Signal[] = [
    { id: "clk",          name: "clk",          scope: "ctrl", width: 1,  radix: "bin", events: clkEvents  },
    { id: "rst_n",        name: "rst_n",        scope: "ctrl", width: 1,  radix: "bin",
      events: [{ t: 0, v: 0 }, { t: 6, v: 1 }] },
  ];

  const axil: Signal[] = [
    { id: "s_axil_awvalid", name: "s_axil_awvalid", scope: "axil", width: 1, radix: "bin",
      events: step01(N_CYC, [10, 80, 140]) },
    { id: "s_axil_awready", name: "s_axil_awready", scope: "axil", width: 1, radix: "bin",
      events: step01(N_CYC, [11, 81, 141]) },
    { id: "s_axil_awaddr",  name: "s_axil_awaddr",  scope: "axil", width: 32, radix: "hex",
      events: bus(N_CYC, [ [10, 0x40000010], [12, "Z"], [80, 0x40000014], [82, "Z"], [140, 0x4000001C], [142, "Z"] ]) },
    { id: "s_axil_wdata",   name: "s_axil_wdata",   scope: "axil", width: 32, radix: "hex",
      events: bus(N_CYC, [ [12, 0xDEADBEEF], [14, "Z"], [82, 0xCAFEBABE], [84, "Z"], [142, 0x12345678], [144, "Z"] ]) },
    { id: "s_axil_wvalid",  name: "s_axil_wvalid",  scope: "axil", width: 1, radix: "bin",
      events: step01(N_CYC, [12, 82, 142]) },
    { id: "s_axil_wready",  name: "s_axil_wready",  scope: "axil", width: 1, radix: "bin",
      events: step01(N_CYC, [13, 83, 143]) },
  ];

  const frontend: Signal[] = [
    { id: "raw_instruction",     name: "raw_instruction",     scope: "frontend", width: 64, radix: "hex",
      events: bus(N_CYC, [
        [16, 0x000012345_6789ABCn ], [18, "Z"],    // OP_GEMV
        [84, 0x100012345_6789ABCn ], [86, "Z"],    // OP_GEMM
        [144, 0x2000A_BC0DEEF12n ], [146, "Z"],    // OP_MEMCPY
      ])},
    { id: "kick",               name: "kick",                 scope: "frontend", width: 1, radix: "bin",
      events: step01(N_CYC, [17, 85, 145]) },
    { id: "fetch_PC_ready",     name: "fetch_PC_ready",       scope: "frontend", width: 1, radix: "bin",
      events: [{ t: 0, v: 1 }] },
  ];

  const decoder: Signal[] = [
    { id: "OUT_GEMV_valid", name: "OUT_GEMV_valid",  scope: "decoder", width: 1, radix: "bin",
      events: step01(N_CYC, [18, 20]) },
    { id: "OUT_GEMM_valid", name: "OUT_GEMM_valid",  scope: "decoder", width: 1, radix: "bin",
      events: step01(N_CYC, [86, 88]) },
    { id: "OUT_memcpy_valid", name: "OUT_memcpy_valid", scope: "decoder", width: 1, radix: "bin",
      events: step01(N_CYC, [146, 148]) },
    { id: "OUT_op_x64",     name: "OUT_op_x64",      scope: "decoder", width: 60, radix: "hex",
      events: bus(N_CYC, [
        [18,  0x0012345_6789ABCn], [20, "Z"],
        [86,  0x0012345_6789ABCn], [88, "Z"],
        [146, 0x00A_BC0DEEF12n  ], [148, "Z"],
      ])},
  ];

  const mac: Signal[] = [
    { id: "mac_state", name: "mac_state",  scope: "mac", width: 3, radix: "dec",
      events: [
        { t: 0,   v: "IDLE"    },
        { t: 24,  v: "FETCH_W" },
        { t: 38,  v: "COMPUTE" },
        { t: 74,  v: "DRAIN"   },
        { t: 79,  v: "IDLE"    },
        { t: 92,  v: "FETCH_W" },
        { t: 98,  v: "COMPUTE" },
        { t: 132, v: "DRAIN"   },
        { t: 136, v: "IDLE"    },
      ]},
    { id: "weight_valid", name: "weight_valid",  scope: "mac", width: 1, radix: "bin",
      events: step01(N_CYC, [24, 74, 92, 132]) },
    { id: "p_accum[47:0]", name: "p_accum",       scope: "mac", width: 48, radix: "hex",
      events: (() => {
        const out: Event[] = [{ t: 0, v: 0 }];
        let acc = 0;
        for (let c = 38; c < 74; c += 2) { acc += 256; out.push({ t: c, v: acc }); }
        out.push({ t: 74, v: acc });
        for (let c = 98; c < 132; c += 2) { acc += 256; out.push({ t: c, v: acc }); }
        out.push({ t: 132, v: acc });
        return out;
      })() },
    { id: "mac_stall",    name: "mac_stall",      scope: "mac", width: 1, radix: "bin",
      events: step01(N_CYC, [38, 42, 70, 74, 98, 100, 130, 132]) },
  ];

  const cvo: Signal[] = [
    { id: "cvo_op", name: "cvo_op",  scope: "cvo", width: 3, radix: "dec",
      events: [
        { t: 0,   v: "idle"    },
        { t: 54,  v: "reduce"  },
        { t: 66,  v: "recip"   },
        { t: 72,  v: "idle"    },
        { t: 114, v: "exp"     },
        { t: 124, v: "scale"   },
        { t: 130, v: "idle"    },
      ]},
    { id: "cvo_valid", name: "cvo_valid",  scope: "cvo", width: 1, radix: "bin",
      events: step01(N_CYC, [54, 72, 114, 130]) },
  ];

  const mem: Signal[] = [
    { id: "hp0_bw",    name: "hp0_bw",     scope: "mem", width: 8, radix: "dec",
      events: bus(N_CYC, [ [0, 0], [24, 128], [74, 0], [92, 128], [132, 0] ]) },
    { id: "l2_access", name: "l2_access",  scope: "mem", width: 1, radix: "bin",
      events: step01(N_CYC, [22, 38, 72, 90, 132, 140]) },
  ];

  return [
    { id: "ctrl",     name: "Control",                  expanded: true,  children: ctrl     },
    { id: "axil",     name: "AXI-Lite (s_axil)",        expanded: false, children: axil     },
    { id: "frontend", name: "NPU Frontend",             expanded: true,  children: frontend },
    { id: "decoder",  name: "Decoder (ctrl_npu_decoder)", expanded: false, children: decoder },
    { id: "mac",      name: "MAT_CORE · GEMM MAC",      expanded: true,  children: mac      },
    { id: "cvo",      name: "CVO SFU",                  expanded: false, children: cvo      },
    { id: "mem",      name: "MEM_control",              expanded: false, children: mem      },
  ];
}

// ─── VCD → Group[] bridge ────────────────────────────────────────────────────

function dumpToGroups(dump: WaveformDump): Group[] {
  const bySig = new Map<string, Event[]>();
  for (const m of dump.signals) bySig.set(m.id, []);
  for (const ch of dump.events) {
    const arr = bySig.get(ch.sig_id);
    if (!arr) continue;
    arr.push({ t: ch.tick, v: bitstringToValue(ch.value) });
  }

  const byGroup = new Map<string, Signal[]>();
  for (const m of dump.signals) {
    const topScope = m.scope.split(".")[0] || "(root)";
    const radix: Radix = m.width === 1 ? "bin" : "hex";
    const sig: Signal = {
      id:    m.id,
      name:  m.name,
      scope: m.scope,
      width: m.width,
      radix,
      events: bySig.get(m.id) ?? [],
    };
    const g = byGroup.get(topScope);
    if (g) g.push(sig); else byGroup.set(topScope, [sig]);
  }

  const out: Group[] = [];
  let idx = 0;
  for (const [name, children] of byGroup) {
    out.push({ id: `vcd-${name}`, name, expanded: idx < 5, children });
    idx += 1;
  }
  return out;
}

function bitstringToValue(raw: string): number | string {
  if (raw.length === 0) return raw;
  if (raw.length === 1) {
    if (raw === "0") return 0;
    if (raw === "1") return 1;
    return raw.toUpperCase();
  }
  if (/^[01]+$/.test(raw)) {
    const n = BigInt("0b" + raw);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString();
  }
  return raw;
}

// ─── Helpers for demo data ──────────────────────────────────────────────────

function step01(_total: number, toggles: number[]): Event[] {
  const out: Event[] = [{ t: 0, v: 0 }];
  let v = 0;
  for (const c of toggles) {
    v = v ? 0 : 1;
    out.push({ t: c, v });
  }
  return out;
}

function bus(_total: number, patt: [number, number | bigint | string][]): Event[] {
  void _total;
  return patt.map(([t, v]) => ({ t, v: typeof v === "bigint" ? v.toString() : (v as number | string) }));
}

// ─── Binary search helpers ──────────────────────────────────────────────────

function eventIdxAtTick(events: Event[], t: number): number {
  if (events.length === 0) return -1;
  let lo = 0;
  let hi = events.length - 1;
  if (events[0].t > t) return -1;
  if (events[hi].t <= t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (events[mid].t <= t) lo = mid;
    else                     hi = mid - 1;
  }
  return lo;
}

function eventAtTick(s: Signal | null, t: number | null): Event | null {
  if (!s || t == null) return null;
  const idx = eventIdxAtTick(s.events, t);
  return idx < 0 ? null : s.events[idx];
}

function firstIdxAtOrAfter(events: Event[], t: number): number {
  if (events.length === 0) return 0;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].t < t) lo = mid + 1;
    else                   hi = mid;
  }
  return lo;
}

// ─── Bookmark persistence ───────────────────────────────────────────────────

const BOOKMARK_KEY = "pccx-waveform-bookmarks";
const MAX_BOOKMARKS = 16;

interface BookmarkItem { tick: number; label?: string; }

function loadBookmarks(): BookmarkItem[] {
  try {
    const raw = localStorage.getItem(BOOKMARK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(b => typeof b === "object" && typeof b.tick === "number")
      .slice(0, MAX_BOOKMARKS)
      .map(b => ({ tick: b.tick, label: b.label }));
  } catch {
    return [];
  }
}

function saveBookmarks(bs: BookmarkItem[]): void {
  try {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bs.slice(0, MAX_BOOKMARKS)));
  } catch { /* storage full — ignore */ }
}

// ─── Radix formatting ───────────────────────────────────────────────────────

function formatValue(v: number | string, radix: Radix, width: number): string {
  if (typeof v === "string") {
    if (v === "Z" || v === "z" || v === "X" || v === "x") return v.toUpperCase();
    const n = parseSafe(v);
    if (n == null) return v;
    return renderNumber(n, radix, width);
  }
  return renderNumber(v, radix, width);
}

function parseSafe(s: string): bigint | null {
  try {
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    if (/^[0-9a-fA-F]+$/.test(s) && s.length > 6)  return BigInt("0x" + s);
    if (/^-?\d+$/.test(s)) return BigInt(s);
  } catch { /* fallthrough */ }
  return null;
}

function renderNumber(n: number | bigint, radix: Radix, width: number): string {
  const bn = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  switch (radix) {
    case "bin":   return "0b" + bn.toString(2).padStart(Math.min(width, 16), "0");
    case "oct":   return "0o" + bn.toString(8);
    case "hex":   {
      const hexDigits = Math.max(1, Math.ceil(width / 4));
      return "0x" + bn.toString(16).toUpperCase().padStart(hexDigits, "0");
    }
    case "dec":   return bn.toString(10);
    case "ascii": {
      const bytes: string[] = [];
      let x = bn;
      while (x > 0n) {
        bytes.unshift(String.fromCharCode(Number(x & 0xffn)));
        x = x >> 8n;
      }
      return "\"" + bytes.join("").replace(/[^ -~]/g, ".") + "\"";
    }
  }
}

// ─── VCD export helper ───────────────────────────────────────────────────────
// Generates a minimal VCD text fragment from the in-memory groups for the
// visible tick range. Disabled in demo mode (no real VCD loaded).

function buildVcdRange(groups: Group[], startTick: number, endTick: number): string {
  const lines: string[] = [];
  lines.push("$timescale 1 ns $end");
  lines.push("$scope module waveform $end");
  const allSigs: Signal[] = [];
  for (const g of groups) for (const s of g.children) allSigs.push(s);
  for (const s of allSigs) {
    const type = s.width === 1 ? "wire" : "reg";
    lines.push(`$var ${type} ${s.width} ${s.id} ${s.name} $end`);
  }
  lines.push("$upscope $end");
  lines.push("$enddefinitions $end");
  lines.push("$dumpvars");
  // Initial values
  for (const s of allSigs) {
    const idx = eventIdxAtTick(s.events, startTick);
    if (idx < 0) continue;
    const v = s.events[idx].v;
    if (s.width === 1) lines.push(`${v} ${s.id}`);
    else lines.push(`b${typeof v === "number" ? v.toString(2) : v} ${s.id}`);
  }
  lines.push("$end");
  // Changes in range
  const allChanges: Array<{ t: number; sigId: string; v: number | string; w: number }> = [];
  for (const s of allSigs) {
    const start = firstIdxAtOrAfter(s.events, startTick + 1);
    for (let i = start; i < s.events.length; i++) {
      const ev = s.events[i];
      if (ev.t > endTick) break;
      allChanges.push({ t: ev.t, sigId: s.id, v: ev.v, w: s.width });
    }
  }
  allChanges.sort((a, b) => a.t - b.t);
  let lastT = -1;
  for (const ch of allChanges) {
    if (ch.t !== lastT) { lines.push(`#${ch.t}`); lastT = ch.t; }
    if (ch.w === 1) lines.push(`${ch.v} ${ch.sigId}`);
    else lines.push(`b${typeof ch.v === "number" ? ch.v.toString(2) : ch.v} ${ch.sigId}`);
  }
  return lines.join("\n");
}

// ─── Context menu overlay ────────────────────────────────────────────────────

// ─── Separator label input overlay ──────────────────────────────────────────

interface SeparatorInputProps {
  x: number;
  y: number;
  onCommit: (label: string) => void;
  onCancel: () => void;
  theme: ReturnType<typeof useTheme>;
}

const SeparatorInput = memo(function SeparatorInput({ x, y, onCommit, onCancel, theme }: SeparatorInputProps) {
  const [label, setLabel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const commit = () => { if (label.trim()) onCommit(label.trim()); else onCancel(); };
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: "absolute", left: x, top: y, zIndex: 203,
        background: theme.bgSurface, border: `1px solid ${theme.border}`,
        borderRadius: 6, boxShadow: theme.shadowMd, padding: "10px 12px",
        minWidth: 220, fontSize: 12, display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ color: theme.textMuted, fontSize: 11 }}>Group separator label</div>
      <input
        ref={inputRef}
        value={label}
        onChange={e => setLabel(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") onCancel(); }}
        placeholder="separator label…"
        style={{
          fontSize: 12, padding: "4px 8px",
          background: theme.bgInput, color: theme.text,
          border: `1px solid ${theme.border}`, borderRadius: 4, outline: "none", width: "100%",
        }}
      />
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "transparent", color: theme.textMuted, border: `1px solid ${theme.borderSubtle}`, cursor: "pointer" }}>cancel</button>
        <button onClick={commit}   style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: theme.accent, color: "#fff", border: "none", cursor: "pointer" }}>add</button>
      </div>
    </div>
  );
});

// ─── Context menu overlay ────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  cycle: number;
  sigId: string | null;
  onAddAnnotation: () => void;
  onAddBookmark: () => void;
  onAddSeparatorBelow: () => void;
  onClose: () => void;
  theme: ReturnType<typeof useTheme>;
}

const ContextMenu = memo(function ContextMenu({
  x, y, cycle, sigId, onAddAnnotation, onAddBookmark, onAddSeparatorBelow, onClose, theme,
}: ContextMenuProps) {
  const items: Array<{ label: string; action: () => void; disabled?: boolean }> = [
    { label: `Add annotation at cycle ${cycle}`, action: onAddAnnotation, disabled: !sigId },
    { label: `Add bookmark at cycle ${cycle}`,  action: onAddBookmark },
    { label: "Add separator below signal",       action: onAddSeparatorBelow, disabled: !sigId },
  ];
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 200,
        background: theme.bgSurface,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        boxShadow: theme.shadowMd,
        minWidth: 220,
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      {items.map(item => (
        <button
          key={item.label}
          disabled={item.disabled}
          onClick={() => { item.action(); onClose(); }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "7px 14px",
            background: "transparent",
            border: "none",
            color: item.disabled ? theme.textFaint : theme.text,
            cursor: item.disabled ? "not-allowed" : "pointer",
            fontFamily: theme.fontSans,
          }}
          onMouseEnter={e => { if (!item.disabled) (e.target as HTMLElement).style.background = theme.bgHover; }}
          onMouseLeave={e => { (e.target as HTMLElement).style.background = "transparent"; }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
});

// ─── Annotation input overlay ────────────────────────────────────────────────

interface AnnotationInputProps {
  x: number;
  y: number;
  cycle: number;
  onCommit: (text: string, severity: AnnotationSeverity) => void;
  onCancel: () => void;
  theme: ReturnType<typeof useTheme>;
}

const AnnotationInput = memo(function AnnotationInput({
  x, y, cycle, onCommit, onCancel, theme,
}: AnnotationInputProps) {
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<AnnotationSeverity>("info");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const commit = () => { if (text.trim()) onCommit(text.trim(), severity); else onCancel(); };

  const severityColor = (s: AnnotationSeverity) => {
    if (s === "warning") return theme.warning;
    if (s === "error")   return theme.error;
    return theme.info;
  };

  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: "absolute",
        left: x,
        top: y,
        zIndex: 201,
        background: theme.bgSurface,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        boxShadow: theme.shadowMd,
        padding: "10px 12px",
        minWidth: 260,
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ color: theme.textMuted, fontSize: 11 }}>
        Annotation at cycle {cycle}
      </div>
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="annotation text…"
        style={{
          fontSize: 12, padding: "4px 8px",
          background: theme.bgInput, color: theme.text,
          border: `1px solid ${theme.border}`, borderRadius: 4,
          outline: "none", width: "100%",
        }}
      />
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {(["info", "warning", "error"] as AnnotationSeverity[]).map(s => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 3,
              background: severity === s ? severityColor(s) : "transparent",
              color: severity === s ? "#fff" : severityColor(s),
              border: `1px solid ${severityColor(s)}`,
              cursor: "pointer",
            }}
          >{s}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={onCancel} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "transparent", color: theme.textMuted, border: `1px solid ${theme.borderSubtle}`, cursor: "pointer" }}>cancel</button>
        <button onClick={commit}   style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: theme.accent, color: "#fff", border: "none", cursor: "pointer" }}>add</button>
      </div>
    </div>
  );
});

// ─── Annotation tooltip overlay ──────────────────────────────────────────────

interface AnnotationTooltipProps {
  x: number;
  y: number;
  annotation: Annotation;
  theme: ReturnType<typeof useTheme>;
}

const AnnotationTooltip = memo(function AnnotationTooltip({ x, y, annotation, theme }: AnnotationTooltipProps) {
  const color =
    annotation.severity === "warning" ? theme.warning :
    annotation.severity === "error"   ? theme.error : theme.info;

  return (
    <div
      style={{
        position: "absolute",
        left: x + 8,
        top: y - 32,
        zIndex: 202,
        background: theme.bgSurface,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: "4px 10px",
        fontSize: 11,
        color: theme.text,
        pointerEvents: "none",
        boxShadow: theme.shadowSm,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color, fontWeight: 700, marginRight: 6 }}>[{annotation.severity}]</span>
      {annotation.text}
      <span style={{ color: theme.textMuted, marginLeft: 6 }}>cyc {annotation.cycle}</span>
    </div>
  );
});

// ─── Component ──────────────────────────────────────────────────────────────

export function WaveformViewer() {
  const theme = useTheme();
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastDimsRef  = useRef<{ w: number; h: number; dpr: number }>({ w: 0, h: 0, dpr: 0 });

  const [parsedDump, setParsedDump] = useState<WaveformDump | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("(demo)");
  const [loadError, setLoadError]   = useState<string | null>(null);

  const [demoGroups, setDemoGroups] = useState<Group[]>(makeDemo);
  const [vcdGroups,  setVcdGroups]  = useState<Group[] | null>(null);
  const groups: Group[] = vcdGroups ?? demoGroups;

  const { samples: liveSamples, hasTrace: liveHasTrace } = useLiveWindow();
  useEffect(() => {
    if (!liveHasTrace || vcdGroups) return;
    setDemoGroups(gs => gs.map(g => g.id !== "mac" ? g : {
      ...g,
      children: g.children.map(s => {
        if (s.name !== "p_accum") return s;
        const events: Event[] = [{ t: 0, v: 0 }];
        let acc = 0;
        liveSamples.forEach((sample, i) => {
          acc += Math.floor(sample.mac_util * 512);
          events.push({ t: 38 + i * 2, v: acc });
        });
        return { ...s, events };
      }),
    }));
  }, [liveSamples, liveHasTrace, vcdGroups]);

  const setGroups = useCallback((updater: (g: Group[]) => Group[]) => {
    if (vcdGroups) setVcdGroups(g => updater(g ?? []));
    else           setDemoGroups(g => updater(g));
  }, [vcdGroups]);

  const [filter, setFilter] = useState("");
  const [zoom, setZoom]     = useState(6);
  const [offset, setOffset] = useState(0);
  const [cursorA, setCursorA] = useState<number | null>(50);
  const [cursorB, setCursorB] = useState<number | null>(120);
  const [selectedSig, setSelectedSig] = useState<string | null>(null);
  const [globalRadix, setGlobalRadix] = useState<Radix>("hex");
  const [dragState, setDragState] = useState<null | {
    kind: "pan" | "cursorA" | "cursorB" | "reorder";
    startX: number;
    startY: number;
    startOffset: number;
    // reorder-specific
    sigId?: string;
    groupId?: string;
    currentY?: number;
  }>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(() => loadBookmarks());

  // ─── Annotation state ────────────────────────────────────────────────────
  // Map keyed by signal.id (unique); each entry is sorted by cycle.
  const [annotations, setAnnotations] = useState<Map<string, Annotation[]>>(new Map());

  // ─── Context menu + annotation input + separator input ──────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cycle: number; sigId: string | null } | null>(null);
  const [annotInput, setAnnotInput] = useState<{ x: number; y: number; cycle: number; sigId: string } | null>(null);
  const [sepInput, setSepInput] = useState<{ x: number; y: number; sigId: string; groupId: string } | null>(null);

  // ─── Annotation tooltip ──────────────────────────────────────────────────
  const [annotTooltip, setAnnotTooltip] = useState<{ x: number; y: number; annotation: Annotation } | null>(null);
  // Store marker hit-test rectangles for the last draw pass so mousemove
  // can find them without re-running draw. Updated inside `draw`.
  const annotMarkersRef = useRef<Array<{ x: number; y: number; sigId: string; ann: Annotation }>>([]);

  // ─── Measurement cursors (Ctrl-click=A, Ctrl+Shift-click=B) ─────────────
  // Ctrl+click / Ctrl+Shift+click are new; Alt-click / Shift-click remain.

  // ─── Selection rect for "zoom to selection" ──────────────────────────────
  const [selection, setSelection] = useState<{ startTick: number; endTick: number } | null>(null);
  const selDragRef = useRef<{ startTick: number; startX: number } | null>(null);

  // Round-6 T-1: shared cycle cursor.
  const cursor = useCycleCursor();
  const goTo   = useGoToCycleInput(cursor);

  // ─── Load VCD ────────────────────────────────────────────────────────────
  const loadVcdFromPath = useCallback(async (path: string) => {
    setLoadError(null);
    try {
      const dump = await invoke<WaveformDump>("parse_vcd_file", { path });
      const g    = dumpToGroups(dump);
      setParsedDump(dump);
      setVcdGroups(g);
      setSourceLabel(path.split(/[\\/]/).pop() ?? path);
      setOffset(0);
      setCursorA(0);
      setCursorB(null);
      setSelectedSig(null);
      setAnnotations(new Map());
      setSelection(null);
    } catch (e: any) {
      setLoadError(`${e}`);
    }
  }, []);

  const handleOpenVcd = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "Value Change Dump", extensions: ["vcd"] },
          { name: "All files",         extensions: ["*"]    },
        ],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : (picked as any).path;
      if (path) await loadVcdFromPath(path);
    } catch (e: any) {
      setLoadError(`dialog error: ${e}`);
    }
  }, [loadVcdFromPath]);

  useEffect(() => {
    const unlisten = listen<string | undefined>("pccx://open-vcd", (ev) => {
      if (ev.payload) loadVcdFromPath(ev.payload);
      else            handleOpenVcd();
    });
    return () => { unlisten.then(f => f()); };
  }, [handleOpenVcd, loadVcdFromPath]);

  // ─── Layout constants ─────────────────────────────────────────────────────
  const NAME_W    = 240;
  const HEADER_H  = 36;
  const GROUP_H   = 26;
  const ROW_H     = 24;
  const SEP_H     = 20;

  // ─── Flatten groups respecting expansion + filter ─────────────────────────
  const rows = useMemo(() => {
    const out: Array<
      | { kind: "group"; group: Group }
      | { kind: "signal"; sig: Signal; groupId: string }
      | { kind: "separator"; label: string; sepId: string; groupId: string }
    > = [];
    const needle = filter.trim().toLowerCase();
    const matches = (s: Signal) =>
      !needle ||
      s.name.toLowerCase().includes(needle) ||
      s.scope.toLowerCase().includes(needle);
    for (const g of groups) {
      const kids = g.children.filter(matches);
      if (needle && kids.length === 0) continue;
      out.push({ kind: "group", group: g });
      if (!g.expanded) continue;
      // Interleave separators and signals in the correct order.
      const seps = g.separators ?? [];
      // Separator with afterSigId===null is before first signal.
      for (const sep of seps.filter(s => s.afterSigId === null)) {
        out.push({ kind: "separator", label: sep.label, sepId: sep.id, groupId: g.id });
      }
      for (const s of kids) {
        out.push({ kind: "signal", sig: s, groupId: g.id });
        for (const sep of seps.filter(sep => sep.afterSigId === s.id)) {
          out.push({ kind: "separator", label: sep.label, sepId: sep.id, groupId: g.id });
        }
      }
    }
    return out;
  }, [groups, filter]);

  const totalTicks = useMemo(() => {
    if (parsedDump && parsedDump.events.length > 0) {
      const last = parsedDump.events[parsedDump.events.length - 1].tick;
      return Math.max(last, 1);
    }
    let m = 0;
    for (const g of groups) for (const s of g.children) {
      if (s.events.length === 0) continue;
      const t = s.events[s.events.length - 1].t;
      if (t > m) m = t;
    }
    return Math.max(m, 200);
  }, [parsedDump, groups]);

  // ─── Draw ─────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const cont   = containerRef.current;
    if (!canvas || !cont) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = cont.clientWidth, ch = cont.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    // Only reallocate GPU backing buffer when viewport changes size.
    const ld = lastDimsRef.current;
    if (ld.w !== cw || ld.h !== ch || ld.dpr !== dpr) {
      canvas.width  = cw * dpr;
      canvas.height = ch * dpr;
      canvas.style.width  = `${cw}px`;
      canvas.style.height = `${ch}px`;
      lastDimsRef.current = { w: cw, h: ch, dpr };
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    ctx.fillStyle = theme.bgSurface;
    ctx.fillRect(0, 0, NAME_W, ch);
    ctx.fillStyle = theme.bgPanel;
    ctx.fillRect(NAME_W, 0, cw - NAME_W, ch);

    ctx.fillStyle = theme.bgEditor;
    ctx.fillRect(0, 0, cw, HEADER_H);
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H); ctx.lineTo(cw, HEADER_H);
    ctx.moveTo(NAME_W, 0);   ctx.lineTo(NAME_W, ch);
    ctx.stroke();

    const tickToX = (t: number) => NAME_W + (t - offset) * zoom;
    const visibleStartTick = offset;
    const visibleEndTick   = offset + (cw - NAME_W) / zoom;

    // Ruler ticks
    ctx.fillStyle = theme.textMuted;
    ctx.strokeStyle = theme.borderDim;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const step = pickRulerStep(zoom);
    const firstTick = Math.ceil(offset / step) * step;
    for (let t = firstTick; tickToX(t) < cw; t += step) {
      const x = tickToX(t);
      if (x < NAME_W - 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H - 6);
      ctx.lineTo(x, HEADER_H);
      ctx.stroke();
      ctx.fillText(`${t} cyc`, x + 3, 4);
      ctx.strokeStyle = theme.borderDim;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H);
      ctx.lineTo(x, ch);
      ctx.stroke();
    }

    // Selection highlight
    if (selection) {
      const xs = tickToX(Math.min(selection.startTick, selection.endTick));
      const xe = tickToX(Math.max(selection.startTick, selection.endTick));
      if (xe > NAME_W && xs < cw) {
        const dx = Math.max(xs, NAME_W);
        const dw = Math.min(xe, cw) - dx;
        ctx.fillStyle = theme.accentBg;
        ctx.fillRect(dx, HEADER_H, dw, ch - HEADER_H);
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.moveTo(dx, HEADER_H); ctx.lineTo(dx, ch); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(Math.min(xe, cw), HEADER_H); ctx.lineTo(Math.min(xe, cw), ch); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }
    }

    // Rows
    let y = HEADER_H;
    ctx.textBaseline = "middle";
    const newMarkers: typeof annotMarkersRef.current = [];

    for (const row of rows) {
      if (row.kind === "group") {
        ctx.fillStyle = theme.bgHover;
        ctx.fillRect(0, y, cw, GROUP_H);
        ctx.fillStyle = theme.textDim;
        ctx.font = "11px Inter, sans-serif";
        ctx.fillText(`${row.group.expanded ? "▾" : "▸"}  ${row.group.name}`, 12, y + GROUP_H / 2);
        ctx.strokeStyle = theme.border;
        ctx.beginPath(); ctx.moveTo(0, y + GROUP_H); ctx.lineTo(cw, y + GROUP_H); ctx.stroke();
        y += GROUP_H;
      } else if (row.kind === "separator") {
        // Separator divider row
        ctx.fillStyle = theme.bgPanel;
        ctx.fillRect(0, y, cw, SEP_H);
        // Dashed horizontal rule
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(NAME_W + 4, y + SEP_H / 2); ctx.lineTo(cw - 4, y + SEP_H / 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        // Label
        ctx.fillStyle = theme.accent;
        ctx.font = "10px Inter, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(row.label, 26, y + SEP_H / 2);
        ctx.textAlign = "left";
        ctx.strokeStyle = theme.borderDim;
        ctx.beginPath(); ctx.moveTo(0, y + SEP_H); ctx.lineTo(cw, y + SEP_H); ctx.stroke();
        y += SEP_H;
      } else {
        const s = row.sig;
        const active = selectedSig === s.id;

        if (active) {
          ctx.fillStyle = theme.accentBg;
          ctx.fillRect(0, y, cw, ROW_H);
        }

        ctx.fillStyle = active ? theme.accent : theme.textDim;
        ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(s.name, 22, y + ROW_H / 2);
        if (s.width > 1) {
          ctx.fillStyle = theme.textFaint;
          ctx.textAlign = "right";
          ctx.fillText(`[${s.width - 1}:0] ${s.radix}`, NAME_W - 8, y + ROW_H / 2);
          ctx.textAlign = "left";
        } else {
          ctx.fillStyle = theme.textFaint;
          ctx.textAlign = "right";
          ctx.fillText(s.radix, NAME_W - 8, y + ROW_H / 2);
          ctx.textAlign = "left";
        }

        ctx.strokeStyle = theme.borderDim;
        ctx.beginPath(); ctx.moveTo(0, y + ROW_H); ctx.lineTo(cw, y + ROW_H); ctx.stroke();

        ctx.save();
        ctx.beginPath(); ctx.rect(NAME_W, y, cw - NAME_W, ROW_H); ctx.clip();

        if (s.width === 1) drawWire(ctx, s, y, ROW_H, tickToX, theme, cw, visibleStartTick, visibleEndTick);
        else              drawBus (ctx, s, y, ROW_H, tickToX, theme, cw, visibleStartTick, visibleEndTick);

        // Annotation markers — small filled triangles on the waveform.
        const sigAnns = annotations.get(s.id);
        if (sigAnns) {
          for (const ann of sigAnns) {
            if (ann.cycle < visibleStartTick - 1 || ann.cycle > visibleEndTick + 1) continue;
            const ax = tickToX(ann.cycle);
            const ay = y + ROW_H - 6;
            const markerColor =
              ann.severity === "warning" ? theme.warning :
              ann.severity === "error"   ? theme.error : theme.info;
            // Downward-pointing triangle
            ctx.fillStyle = markerColor;
            ctx.beginPath();
            ctx.moveTo(ax, ay + 6);
            ctx.lineTo(ax - 4, ay);
            ctx.lineTo(ax + 4, ay);
            ctx.closePath();
            ctx.fill();
            // Store for hover hit-test (canvas coords)
            newMarkers.push({ x: ax, y: ay + 3, sigId: s.id, ann });
          }
        }

        ctx.restore();
        y += ROW_H;
      }
      if (y > ch) break;
    }

    // Update marker hit-test list after draw
    annotMarkersRef.current = newMarkers;

    // Bookmarks
    for (const b of bookmarks) {
      const x = tickToX(b.tick);
      if (x < NAME_W - 1 || x > cw + 1) continue;
      ctx.strokeStyle = theme.success;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(x, HEADER_H); ctx.lineTo(x, ch); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.success;
      ctx.fillRect(x - 1, HEADER_H - 4, 2, 4);
    }

    // Cursors
    const drawCursor = (t: number | null, tag: "A" | "B", colour: string) => {
      if (t == null) return;
      const x = tickToX(t);
      if (x < NAME_W - 1 || x > cw + 1) return;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colour;
      ctx.fillRect(x - 9, 0, 18, 14);
      ctx.fillStyle = "#000";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.fillText(tag, x, 2);
      ctx.textAlign = "left";
    };
    drawCursor(cursorA, "A", theme.warning);
    drawCursor(cursorB, "B", theme.info);
  }, [rows, zoom, offset, cursorA, cursorB, selectedSig, theme, bookmarks, annotations, selection]);

  // RAF-coalesced draw scheduler
  const sched = useRafScheduler();
  const scheduleDraw = useCallback(() => {
    sched.schedule("waveform", draw);
  }, [sched, draw]);

  useEffect(() => { scheduleDraw(); }, [scheduleDraw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => scheduleDraw());
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  // ─── Mouse handling ───────────────────────────────────────────────────────

  // Close overlays on outside click
  useEffect(() => {
    if (!ctxMenu && !annotInput && !sepInput) return;
    const handler = () => { setCtxMenu(null); setAnnotInput(null); setSepInput(null); };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [ctxMenu, annotInput, sepInput]);

  // Hit-test which signal row is at canvas Y coordinate
  const sigAtY = useCallback((y: number): { sigId: string; groupId: string } | null => {
    let cy = HEADER_H;
    for (const row of rows) {
      if (row.kind === "group") cy += GROUP_H;
      else if (row.kind === "separator") cy += SEP_H;
      else {
        if (y >= cy && y < cy + ROW_H) return { sigId: row.sig.id, groupId: row.groupId };
        cy += ROW_H;
      }
    }
    return null;
  }, [rows]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    // Close any open overlay when clicking the canvas
    setCtxMenu(null);
    setAnnotInput(null);

    const r = containerRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;

    if (x < NAME_W) {
      handleNameClick(x, y, e);
      return;
    }

    const t = (x - NAME_W) / zoom + offset;
    const dA = cursorA == null ? Infinity : Math.abs(t - cursorA) * zoom;
    const dB = cursorB == null ? Infinity : Math.abs(t - cursorB) * zoom;

    // Ctrl+click = place cursor A; Ctrl+Shift+click = place cursor B.
    if (e.ctrlKey && e.shiftKey) {
      const snapped = Math.max(0, Math.round(t));
      setCursorB(snapped);
      return;
    }
    if (e.ctrlKey) {
      const snapped = Math.max(0, Math.round(t));
      setCursorA(snapped);
      cursor.setCycle(snapped);
      return;
    }

    // Dragging an existing cursor knob (within 8 px).
    if (dA < 8)      setDragState({ kind: "cursorA", startX: e.clientX, startY: y, startOffset: cursorA ?? 0 });
    else if (dB < 8) setDragState({ kind: "cursorB", startX: e.clientX, startY: y, startOffset: cursorB ?? 0 });
    else if (e.shiftKey) setCursorB(Math.max(0, Math.round(t)));
    else if (e.altKey) {
      const snapped = Math.max(0, Math.round(t));
      setCursorA(snapped);
      cursor.setCycle(snapped);
    } else {
      // Plain drag = pan, but also start a selection-rect on the ruler area.
      if (y <= HEADER_H) {
        selDragRef.current = { startTick: Math.max(0, Math.round(t)), startX: x };
        setSelection(null);
      } else {
        setDragState({ kind: "pan", startX: e.clientX, startY: y, startOffset: offset });
      }
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;

    // Selection rect drag on ruler
    if (selDragRef.current) {
      const t = Math.max(0, Math.round((mx - NAME_W) / zoom + offset));
      setSelection({ startTick: selDragRef.current.startTick, endTick: t });
      return;
    }

    if (dragState) {
      const dx = e.clientX - dragState.startX;
      if (dragState.kind === "pan") {
        setOffset(Math.max(0, dragState.startOffset - dx / zoom));
      } else if (dragState.kind === "cursorA" || dragState.kind === "cursorB") {
        const newT = Math.round(Math.max(0, dragState.startOffset + dx / zoom));
        if (dragState.kind === "cursorA") {
          setCursorA(newT);
          cursor.setCycle(newT);
        } else {
          setCursorB(newT);
        }
      } else if (dragState.kind === "reorder" && dragState.sigId && dragState.groupId) {
        // Update visual Y for ghost indicator
        setDragState(d => d ? { ...d, currentY: my } : null);
      }
      return;
    }

    // Annotation marker hover hit-test (6 px radius)
    const markers = annotMarkersRef.current;
    let found: typeof annotMarkersRef.current[0] | null = null;
    for (const m of markers) {
      if (Math.abs(mx - m.x) <= 6 && Math.abs(my - m.y) <= 6) { found = m; break; }
    }
    if (found) {
      setAnnotTooltip({ x: mx, y: my, annotation: found.ann });
    } else if (annotTooltip) {
      setAnnotTooltip(null);
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!containerRef.current) return;

    // Finish selection drag
    if (selDragRef.current) {
      selDragRef.current = null;
      return;
    }

    // Finish reorder drag — find drop target and reorder
    if (dragState?.kind === "reorder" && dragState.sigId && dragState.groupId) {
      const r = containerRef.current.getBoundingClientRect();
      const dropY = e.clientY - r.top;
      const dropTarget = sigAtY(dropY);
      if (dropTarget && dropTarget.groupId === dragState.groupId && dropTarget.sigId !== dragState.sigId) {
        const fromId = dragState.sigId;
        const toId   = dropTarget.sigId;
        setGroups(gs => gs.map(g => {
          if (g.id !== dragState.groupId) return g;
          const children = [...g.children];
          const fromIdx = children.findIndex(s => s.id === fromId);
          const toIdx   = children.findIndex(s => s.id === toId);
          if (fromIdx < 0 || toIdx < 0) return g;
          const [item] = children.splice(fromIdx, 1);
          children.splice(toIdx, 0, item);
          return { ...g, children };
        }));
      }
      setDragState(null);
      return;
    }

    setDragState(null);
  };

  const handleNameClick = (_x: number, y: number, e: React.MouseEvent) => {
    let cy = HEADER_H;
    for (const row of rows) {
      if (row.kind === "group") {
        const h = GROUP_H;
        if (y >= cy && y < cy + h) {
          setGroups(g => g.map(gg => gg.id === row.group.id ? { ...gg, expanded: !gg.expanded } : gg));
          return;
        }
        cy += h;
      } else if (row.kind === "separator") {
        cy += SEP_H;
      } else {
        if (y >= cy && y < cy + ROW_H) {
          if (e.ctrlKey || e.metaKey) {
            // Ctrl+drag to reorder — start reorder mode
            setDragState({ kind: "reorder", startX: e.clientX, startY: y, startOffset: 0, sigId: row.sig.id, groupId: row.groupId, currentY: y });
          } else {
            setSelectedSig(s => s === row.sig.id ? null : row.sig.id);
          }
          return;
        }
        cy += ROW_H;
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < NAME_W) return;
    // Zoom centered on mouse position (not viewport center).
    const t = (x - NAME_W) / zoom + offset;
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      const newZoom = Math.min(60, Math.max(0.25, zoom * factor));
      setOffset(Math.max(0, t - (x - NAME_W) / newZoom));
      setZoom(newZoom);
    } else {
      setOffset(o => Math.max(0, o + e.deltaX / zoom + (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY / zoom : 0)));
    }
  };

  // Right-click opens a context menu with "Add annotation" + "Add bookmark".
  const onContextMenu = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < NAME_W) return;
    e.preventDefault();
    const t = Math.max(0, Math.round((x - NAME_W) / zoom + offset));
    const hit = sigAtY(y);
    setCtxMenu({ x, y, cycle: t, sigId: hit?.sigId ?? null });
  };

  // ─── Annotation actions ──────────────────────────────────────────────────

  const commitAnnotation = useCallback((sigId: string, cycle: number, text: string, severity: AnnotationSeverity) => {
    setAnnotations(prev => {
      const next = new Map(prev);
      const existing = next.get(sigId) ?? [];
      const updated = [...existing, { cycle, text, severity }].sort((a, b) => a.cycle - b.cycle);
      next.set(sigId, updated);
      return next;
    });
    setAnnotInput(null);
  }, []);

  // ─── Separator actions ────────────────────────────────────────────────────

  const commitSeparator = useCallback((groupId: string, afterSigId: string, label: string) => {
    const id = `sep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setGroups(gs => gs.map(g => {
      if (g.id !== groupId) return g;
      return { ...g, separators: [...(g.separators ?? []), { id, afterSigId, label }] };
    }));
    setSepInput(null);
  }, [setGroups]);

  // ─── Derived: selected signal value at each cursor ────────────────────────
  const selectedSignal = useMemo(() => {
    if (!selectedSig) return null;
    for (const g of groups) for (const s of g.children) if (s.id === selectedSig) return s;
    return null;
  }, [groups, selectedSig]);

  const valueAt = (s: Signal | null, t: number | null): string => {
    const ev = eventAtTick(s, t);
    if (!s || !ev) return "—";
    return formatValue(ev.v, s.radix, s.width);
  };

  const setRadixForSignal = (id: string, r: Radix) =>
    setGroups(gs => gs.map(g => ({ ...g, children: g.children.map(s => s.id === id ? { ...s, radix: r } : s) })));

  const cycleRadix = (id: string) => {
    const order: Radix[] = ["hex", "dec", "bin", "oct", "ascii"];
    setGroups(gs => gs.map(g => ({ ...g, children: g.children.map(s => {
      if (s.id !== id) return s;
      const idx = (order.indexOf(s.radix) + 1) % order.length;
      return { ...s, radix: order[idx] };
    })})));
  };

  const applyGlobalRadix = (r: Radix) => {
    setGlobalRadix(r);
    setGroups(gs => gs.map(g => ({ ...g, children: g.children.map(s => s.width > 1 ? { ...s, radix: r } : s) })));
  };

  // ─── Bookmark actions ─────────────────────────────────────────────────────
  const addBookmark = useCallback((tick: number) => {
    setBookmarks(prev => {
      const filtered = prev.filter(b => b.tick !== tick);
      const next = [...filtered, { tick }].sort((a, b) => a.tick - b.tick).slice(0, MAX_BOOKMARKS);
      saveBookmarks(next);
      return next;
    });
  }, []);

  const removeBookmark = useCallback((tick: number) => {
    setBookmarks(prev => {
      const next = prev.filter(b => b.tick !== tick);
      saveBookmarks(next);
      return next;
    });
  }, []);

  const jumpNextBookmark = useCallback(() => {
    setBookmarks(prev => {
      if (prev.length === 0) return prev;
      const sorted = [...prev].sort((a, b) => a.tick - b.tick);
      const ref = cursorA ?? 0;
      const next = sorted.find(b => b.tick > ref) ?? sorted[0];
      setCursorA(next.tick);
      cursor.setCycle(next.tick);
      if (containerRef.current) {
        const cw = containerRef.current.clientWidth;
        const visible = (cw - NAME_W) / zoom;
        if (next.tick < offset || next.tick > offset + visible) {
          setOffset(Math.max(0, next.tick - visible / 2));
        }
      }
      return prev;
    });
  }, [cursorA, offset, zoom, cursor]);

  // Ctrl+B — jump to next bookmark
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b" && !e.shiftKey) {
        const root = containerRef.current;
        if (!root) return;
        const r = root.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        e.preventDefault();
        jumpNextBookmark();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jumpNextBookmark]);

  const focusedEdges = useMemo<number[]>(() => {
    const s = selectedSignal;
    if (!s || s.events.length === 0) return [];
    const ticks = s.events.map(e => e.t).slice().sort((a, b) => a - b);
    return ticks.filter((t, i) => i === 0 || t !== ticks[i - 1]);
  }, [selectedSignal]);

  useEffect(() => {
    if (cursorA !== cursor.cycle) setCursorA(cursor.cycle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.cycle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = containerRef.current;
      if (!root) return;
      const r = root.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isInput && !(e.ctrlKey || e.metaKey)) return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) cursor.stepBy(1);
        else            cursor.stepEdge(1, focusedEdges);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) cursor.stepBy(-1);
        else            cursor.stepEdge(-1, focusedEdges);
      } else if (e.key === ".") {
        e.preventDefault();
        cursor.stepEdge(1, focusedEdges);
      } else if (e.key === ",") {
        e.preventDefault();
        cursor.stepEdge(-1, focusedEdges);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g" && !e.shiftKey) {
        e.preventDefault();
        cursor.goToCyclePrompt();
      } else if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isInput) {
        e.preventDefault();
        cursor.goToCyclePrompt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, focusedEdges]);

  useEffect(() => {
    cursor.setTotalCycles(Math.max(1, totalTicks));
  }, [totalTicks, cursor]);

  const signalCount = groups.reduce((n, g) => n + g.children.length, 0);

  // ─── Export actions ────────────────────────────────────────────────────────

  const copyAsPng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.toBlob(async blob => {
        if (!blob) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch {
          // Clipboard write not available — fall back to download link
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = "waveform.png"; a.click();
          URL.revokeObjectURL(url);
        }
      }, "image/png");
    } catch { /* ignore */ }
  }, []);

  const copyVcdRange = useCallback(() => {
    if (!parsedDump) return; // disabled in demo mode
    const startTick = offset;
    const endTick   = offset + (containerRef.current ? (containerRef.current.clientWidth - NAME_W) / zoom : 200);
    const text = buildVcdRange(groups, Math.floor(startTick), Math.ceil(endTick));
    navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
  }, [parsedDump, offset, zoom, groups]);

  // ─── Zoom helpers ──────────────────────────────────────────────────────────

  const zoomToSelection = useCallback(() => {
    if (!selection || !containerRef.current) return;
    const { startTick, endTick } = selection;
    const lo = Math.min(startTick, endTick);
    const hi = Math.max(startTick, endTick);
    if (hi <= lo) return;
    const cw = containerRef.current.clientWidth;
    const newZoom = Math.max(0.25, Math.min(60, (cw - NAME_W) / (hi - lo)));
    setZoom(newZoom);
    setOffset(lo);
    setSelection(null);
  }, [selection]);

  const setZoomPreset = useCallback((preset: "fit" | 100 | 200 | 500) => {
    if (preset === "fit") {
      setZoom(6); setOffset(0);
    } else {
      // Treat preset as pixels-per-100-ticks: 100% → 6 px/tick, 200% → 12, 500% → 30
      const pxPerTick = (preset / 100) * 6;
      setZoom(pxPerTick);
    }
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <main role="main" aria-label="Waveform viewer" className="w-full h-full flex flex-col" style={{ background: theme.bgPanel }}>
      {/* Top toolbar */}
      <div role="toolbar" aria-label="Waveform toolbar" className="flex items-center px-3 shrink-0 gap-2"
           style={{ height: 44, borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgEditor }}>
        <Activity size={15} style={{ color: theme.accent }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>Waveform Analyser</span>
        <span style={{ fontSize: 10, color: theme.textMuted }}>
          {signalCount} signals ·
          {" "}{totalTicks.toLocaleString()} tick range ·
          {" "}<span style={{ color: parsedDump ? theme.success : theme.warning, fontWeight: 600 }}>
            {parsedDump ? `VCD: ${sourceLabel}` : "demo"}
          </span>
        </span>

        <div className="flex-1" />

        {/* Signal filter */}
        <div style={{
          display: "flex", alignItems: "center", gap: 4, padding: "3px 8px",
          background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 4,
        }}>
          <Search size={11} style={{ color: theme.textMuted }} />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter signals / scope…"
            style={{
              width: 180, fontSize: 11, padding: "1px 2px",
              background: "transparent", border: "none", outline: "none", color: theme.text,
            }}
          />
          {filter && (
            <button aria-label="Clear signal filter" onClick={() => setFilter("")}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: theme.textMuted, padding: 0 }}>
              <X size={10} />
            </button>
          )}
        </div>

        {/* Global radix */}
        <div style={{ display: "inline-flex", gap: 2, background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 4, padding: 2 }}>
          {(["bin", "oct", "hex", "dec", "ascii"] as Radix[]).map(r => (
            <button
              key={r}
              onClick={() => applyGlobalRadix(r)}
              title={`Set all buses to ${r.toUpperCase()}`}
              style={{
                fontSize: 10, padding: "2px 7px", borderRadius: 3,
                background: globalRadix === r ? theme.accent : "transparent",
                color: globalRadix === r ? "#fff" : theme.textMuted,
                border: "none", cursor: "pointer", fontWeight: globalRadix === r ? 700 : 500,
              }}
            >{r.toUpperCase()}</button>
          ))}
        </div>

        {/* Zoom presets */}
        <div style={{ display: "inline-flex", gap: 2, background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 4, padding: 2 }}>
          {([["fit", "Fit All"] as const, [100, "100%"] as const, [200, "200%"] as const, [500, "500%"] as const]).map(([val, label]) => (
            <button key={String(val)} onClick={() => setZoomPreset(val)} title={`Zoom preset: ${label}`}
              style={{ fontSize: 10, padding: "2px 7px", borderRadius: 3, background: "transparent", color: theme.textMuted, border: "none", cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>

        <button onClick={handleOpenVcd} style={iconBtn(theme)} title="Open .vcd file">Open VCD</button>
        <button aria-label="Zoom in"  onClick={() => setZoom(z => Math.min(60, z * 1.3))} style={iconBtn(theme)}><ZoomIn  size={12} /></button>
        <button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(0.25, z / 1.3))} style={iconBtn(theme)}><ZoomOut size={12} /></button>
        <button aria-label="Fit to viewport" onClick={() => { setZoom(6); setOffset(0); }} style={iconBtn(theme)}><Maximize2 size={12} /></button>
        {selection && (
          <button onClick={zoomToSelection} style={{ ...iconBtn(theme), color: theme.accent, borderColor: theme.accent }} title="Zoom to selection">
            Zoom to sel.
          </button>
        )}
        <button aria-label="Copy waveform as PNG" onClick={copyAsPng} style={iconBtn(theme)} title="Copy canvas as PNG (falls back to download)">
          PNG
        </button>
        <button
          aria-label="Copy visible VCD range to clipboard"
          onClick={copyVcdRange}
          disabled={!parsedDump}
          style={{ ...iconBtn(theme), opacity: parsedDump ? 1 : 0.4 }}
          title={parsedDump ? "Copy visible range as VCD text" : "Load a VCD file first"}
        >
          <Download size={12} /> VCD
        </button>
        <button
          aria-label="Clear measurement cursors"
          onClick={() => { setCursorA(null); setCursorB(null); }}
          style={iconBtn(theme)}
          title="Clear both measurement cursors"
        >
          Clear AB
        </button>
      </div>

      {/* Cursor readout + bookmark bar */}
      <div className="flex items-center px-3 shrink-0 gap-4"
           style={{ height: 26, borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgSurface, fontSize: 10 }}>
        <div style={{ color: theme.textMuted }}>
          <Crosshair size={10} style={{ marginRight: 4, verticalAlign: "middle" }} />
          drag=pan · <strong>Alt</strong>-click=A · <strong>Shift</strong>-click=B · <strong>Ctrl</strong>-click=A · <strong>Ctrl+Shift</strong>-click=B · right-click=menu · Ctrl+B=next bkm · <strong>Arrow</strong>=edge · <strong>Shift+Arrow</strong>=±1
        </div>
        <div className="flex-1" />
        <label style={{ color: theme.textMuted, display: "inline-flex", alignItems: "center", gap: 4 }}>
          go to
          <input
            type="number" min={0} max={Math.max(totalTicks, cursor.totalCycles)}
            placeholder={`0–${Math.max(totalTicks, cursor.totalCycles)}`}
            value={goTo.value}
            onChange={e => goTo.setValue(e.target.value)}
            onKeyDown={goTo.onKeyDown}
            onBlur={goTo.commit}
            style={{
              width: 74, height: 18, fontSize: 10, padding: "0 4px",
              background: theme.bgEditor, color: theme.text,
              border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 2, outline: "none",
            }}
          />
        </label>
        <Readout tag="A" colour={theme.warning} cycle={cursorA} value={valueAt(selectedSignal, cursorA)} sig={selectedSignal} />
        <Readout tag="B" colour={theme.info}    cycle={cursorB} value={valueAt(selectedSignal, cursorB)} sig={selectedSignal} />
        {cursorA != null && cursorB != null && (
          <span style={{ color: theme.accent, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
            {"Δ"} = {Math.abs(cursorB - cursorA).toLocaleString()} cyc
          </span>
        )}
      </div>

      {/* Bookmark strip */}
      {bookmarks.length > 0 && (
        <div className="flex items-center px-3 shrink-0 gap-2 overflow-x-auto"
             style={{ height: 24, borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bg, fontSize: 10 }}>
          <Bookmark size={11} style={{ color: theme.success, flexShrink: 0 }} />
          <span style={{ color: theme.textMuted, flexShrink: 0 }}>
            bookmarks ({bookmarks.length}/{MAX_BOOKMARKS}):
          </span>
          {bookmarks.map(b => (
            <button
              key={b.tick}
              onClick={() => { setCursorA(b.tick); cursor.setCycle(b.tick); setOffset(Math.max(0, b.tick - 40)); }}
              title={`jump cursor A to tick ${b.tick}. right-click to remove.`}
              onContextMenu={e => { e.preventDefault(); removeBookmark(b.tick); }}
              style={{
                padding: "1px 7px", borderRadius: 3,
                background: theme.bgSurface, color: theme.success,
                border: `0.5px solid ${theme.borderSubtle}`, cursor: "pointer",
                fontFamily: "ui-monospace, monospace", fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {b.tick.toLocaleString()}
            </button>
          ))}
          <button aria-label="Jump to next bookmark (Ctrl+B)" onClick={jumpNextBookmark} title="Ctrl+B"
            style={{ ...iconBtn(theme), padding: "1px 7px", flexShrink: 0 }}>next ▸</button>
        </div>
      )}

      {loadError && (
        <div style={{
          padding: "4px 12px", background: theme.bgSurface,
          borderBottom: `0.5px solid ${theme.borderSubtle}`, color: theme.error, fontSize: 11,
        }}>
          Failed to load VCD: {loadError}
        </div>
      )}

      {/* Per-signal radix strip */}
      {selectedSignal && selectedSignal.width > 1 && (
        <div className="flex items-center px-3 shrink-0 gap-2"
             style={{ height: 26, borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bg, fontSize: 10 }}>
          <Filter size={10} style={{ color: theme.textMuted }} />
          <span style={{ color: theme.textMuted }}>
            Selected: <strong style={{ color: theme.accent }}>{selectedSignal.scope}.{selectedSignal.name}</strong>
            {" "}[{selectedSignal.width - 1}:0]
          </span>
          <span style={{ color: theme.textMuted }}>radix</span>
          {(["bin","oct","hex","dec","ascii"] as Radix[]).map(r => (
            <button
              key={r}
              onClick={() => setRadixForSignal(selectedSignal.id, r)}
              style={{
                fontSize: 10, padding: "1px 6px", borderRadius: 3,
                background: selectedSignal.radix === r ? theme.accentBg : "transparent",
                color: selectedSignal.radix === r ? theme.accent : theme.textMuted,
                border: `0.5px solid ${selectedSignal.radix === r ? theme.accent : theme.borderSubtle}`,
                cursor: "pointer",
              }}
            >{r.toUpperCase()}</button>
          ))}
          <button
            onClick={() => cycleRadix(selectedSignal.id)}
            style={{
              fontSize: 10, padding: "1px 8px", borderRadius: 3,
              background: "transparent", color: theme.textMuted,
              border: `0.5px solid ${theme.borderSubtle}`, cursor: "pointer",
            }}
            title="Cycle through radixes"
          >cycle →</button>
        </div>
      )}

      {/* Canvas + DOM overlays */}
      <div
        ref={containerRef}
        className="flex-1 relative"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { setDragState(null); selDragRef.current = null; setAnnotTooltip(null); }}
        onContextMenu={onContextMenu}
        onDoubleClick={e => {
          if (!containerRef.current) return;
          const r = containerRef.current.getBoundingClientRect();
          const x = e.clientX - r.left;
          if (x < NAME_W) return;
          setOffset(0); setZoom(8);
        }}
        onWheel={onWheel}
        style={{ cursor: dragState?.kind === "pan" ? "grabbing" : (dragState ? "ew-resize" : "grab") }}
      >
        <canvas ref={canvasRef} className="absolute inset-0" />

        {/* Context menu */}
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            cycle={ctxMenu.cycle}
            sigId={ctxMenu.sigId}
            onAddAnnotation={() => {
              if (!ctxMenu.sigId) return;
              setAnnotInput({ x: ctxMenu.x, y: ctxMenu.y, cycle: ctxMenu.cycle, sigId: ctxMenu.sigId });
              setCtxMenu(null);
            }}
            onAddBookmark={() => { addBookmark(ctxMenu.cycle); setCtxMenu(null); }}
            onAddSeparatorBelow={() => {
              if (!ctxMenu.sigId) return;
              // Find which group this signal belongs to
              for (const g of groups) {
                if (g.children.some(s => s.id === ctxMenu.sigId)) {
                  setSepInput({ x: ctxMenu.x, y: ctxMenu.y, sigId: ctxMenu.sigId!, groupId: g.id });
                  setCtxMenu(null);
                  return;
                }
              }
            }}
            onClose={() => setCtxMenu(null)}
            theme={theme}
          />
        )}

        {/* Annotation input */}
        {annotInput && (
          <AnnotationInput
            x={annotInput.x}
            y={annotInput.y}
            cycle={annotInput.cycle}
            onCommit={(text, severity) => commitAnnotation(annotInput.sigId, annotInput.cycle, text, severity)}
            onCancel={() => setAnnotInput(null)}
            theme={theme}
          />
        )}

        {/* Separator label input */}
        {sepInput && (
          <SeparatorInput
            x={sepInput.x}
            y={sepInput.y}
            onCommit={label => commitSeparator(sepInput.groupId, sepInput.sigId, label)}
            onCancel={() => setSepInput(null)}
            theme={theme}
          />
        )}

        {/* Annotation tooltip on marker hover */}
        {annotTooltip && (
          <AnnotationTooltip
            x={annotTooltip.x}
            y={annotTooltip.y}
            annotation={annotTooltip.annotation}
            theme={theme}
          />
        )}
      </div>
    </main>
  );
}

// ─── Draw helpers ────────────────────────────────────────────────────────────

function drawWire(
  ctx: CanvasRenderingContext2D,
  s: Signal,
  yTop: number,
  h: number,
  x: (t: number) => number,
  theme: ReturnType<typeof useTheme>,
  cw: number,
  visStart: number,
  visEnd:   number,
) {
  if (s.events.length === 0) return;
  const lo = yTop + h * 0.78;
  const hi = yTop + h * 0.22;
  ctx.strokeStyle = s.name === "clk" ? theme.accent : theme.success;
  ctx.lineWidth = 1.4;
  ctx.beginPath();

  const firstVisIdx = Math.max(0, eventIdxAtTick(s.events, visStart));
  const startEv     = s.events[firstVisIdx];
  let lastY         = typeof startEv.v === "string"
    ? (yTop + h / 2)
    : (startEv.v === 1 ? hi : lo);
  ctx.moveTo(Math.min(x(startEv.t), cw), lastY);

  for (let i = firstVisIdx; i < s.events.length; i++) {
    const ev = s.events[i];
    if (ev.t > visEnd + 2) {
      const xt = x(ev.t);
      ctx.lineTo(xt, lastY);
      break;
    }
    const xt = x(ev.t);
    const yv = typeof ev.v === "string"
      ? (yTop + h / 2)
      : (ev.v === 1 ? hi : lo);
    ctx.lineTo(xt, lastY);
    ctx.lineTo(xt, yv);
    lastY = yv;
  }
  ctx.lineTo(cw, lastY);
  ctx.stroke();
}

function drawBus(
  ctx: CanvasRenderingContext2D,
  s: Signal,
  yTop: number,
  h: number,
  x: (t: number) => number,
  theme: ReturnType<typeof useTheme>,
  cw: number,
  visStart: number,
  visEnd:   number,
) {
  const lo = yTop + h * 0.78;
  const hi = yTop + h * 0.22;
  const mid = yTop + h / 2;

  const startIdx = Math.max(0, eventIdxAtTick(s.events, visStart));
  const endIdx   = firstIdxAtOrAfter(s.events, visEnd + 1);

  for (let i = startIdx; i < s.events.length && i <= endIdx; i++) {
    const cur  = s.events[i];
    const next = s.events[i + 1];
    const x1 = x(cur.t);
    const x2 = next ? x(next.t) : cw;
    if (x2 < 0 || x1 > cw) continue;
    const drawX = Math.max(0, x1);
    const drawW = Math.min(cw, x2) - drawX;
    if (drawW <= 0) continue;

    if (cur.v === "Z" || cur.v === "z") {
      ctx.strokeStyle = theme.warning;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(drawX, mid); ctx.lineTo(drawX + drawW, mid); ctx.stroke();
      continue;
    }
    if (cur.v === "X" || cur.v === "x") {
      ctx.fillStyle = theme.errorBg;
      ctx.fillRect(drawX, hi, drawW, lo - hi);
      continue;
    }

    ctx.fillStyle = theme.bgHover;
    ctx.strokeStyle = theme.info;
    ctx.lineWidth = 1;
    const slant = Math.min(4, drawW / 2);
    ctx.beginPath();
    ctx.moveTo(x1, mid);
    ctx.lineTo(x1 + slant, hi);
    ctx.lineTo(x2 - slant, hi);
    ctx.lineTo(x2, mid);
    ctx.lineTo(x2 - slant, lo);
    ctx.lineTo(x1 + slant, lo);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (drawW > 28) {
      ctx.save();
      ctx.beginPath(); ctx.rect(drawX, hi, drawW, lo - hi); ctx.clip();
      ctx.fillStyle = theme.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillText(formatValue(cur.v, s.radix, s.width), (drawX + drawX + drawW) / 2, mid);
      ctx.restore();
    }
  }
}

function pickRulerStep(zoom: number): number {
  const target = 100;
  const raw    = target / zoom;
  const mag    = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return mag * 10;
}

const Readout = memo(function Readout(
  { tag, colour, cycle, value, sig }:
  { tag: string; colour: string; cycle: number | null; value: string; sig: Signal | null }
) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 12, height: 12, background: colour, color: "#000", fontSize: 9, fontWeight: 700, textAlign: "center", lineHeight: "12px", borderRadius: 2 }}>{tag}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", color: colour }}>
        {cycle == null ? "—" : `${cycle} cyc`}
      </span>
      {sig && (
        <span style={{ fontFamily: "ui-monospace, monospace", color: "inherit" }}>
          = {value}
        </span>
      )}
    </span>
  );
});

function iconBtn(theme: ReturnType<typeof useTheme>) {
  return {
    display: "inline-flex" as const, alignItems: "center" as const, gap: 4,
    fontSize: 10, padding: "4px 8px",
    color: theme.textMuted, background: theme.bgSurface,
    border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 4,
    cursor: "pointer" as const,
  };
}
