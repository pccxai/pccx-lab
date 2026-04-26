import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./ThemeContext";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TerminalSquare, ShieldCheck, Bug, Activity, Cpu } from "lucide-react";
import { SynthStatusCard } from "./SynthStatusCard";
import { VerificationRunner } from "./VerificationRunner";
import { RooflineCard } from "./RooflineCard";
import { BottleneckCard } from "./BottleneckCard";

// Default fixtures shipped under hw/sim/coverage/fixtures/ — resolved
// relative to the Tauri binary working directory. Override via
// VerificationSuite props when embedding elsewhere.
const DEFAULT_RUNS = [
  "../../../../hw/sim/coverage/fixtures/run_a.jsonl",
  "../../../../hw/sim/coverage/fixtures/run_b.jsonl",
  "../../../../hw/sim/coverage/fixtures/run_c.jsonl",
];

interface CovBin    { id: string; hits: number; goal: number; }
interface CovGroup  { name: string; bins: CovBin[]; }
interface CrossTuple { a_group: string; b_group: string; a_bin: string; b_bin: string; hits: number; goal: number; }
interface MergedCoverage { groups: CovGroup[]; crosses: CrossTuple[]; }

type VerifyTab = "isa" | "api" | "uvm" | "synth";

const DEFAULT_UTIL_PATH =
  "../../../../pccx-FPGA-NPU-LLM-kv260/hw/build/reports/utilization_post_synth.rpt";
const DEFAULT_TIMING_PATH =
  "../../../../pccx-FPGA-NPU-LLM-kv260/hw/build/reports/timing_summary_post_synth.rpt";
const DEFAULT_REPO_PATH =
  "../../../../pccx-FPGA-NPU-LLM-kv260";

// Matches pccx_core::isa_replay::IsaResult.  The Tauri command
// `validate_isa_trace(path)` populates this from a real Spike-style
// commit log (no more literal arrays).
interface IsaResult {
  inst:            string;
  opcode:          string;
  expected_cycles: number;
  actual_cycles:   number;
  status:          "PASS" | "FAIL" | "WARN";
  decode:          string;
}

// Matches pccx_core::api_ring::ApiCall.  The Tauri command
// `list_api_calls` populates this from a ring populated by the
// cached trace's API boundary crossings (synthetic fallback when
// no trace is loaded).
interface ApiCall {
  api:            string;
  kind:           string;
  p99_latency_ns: number;
  drops:          number;
  status:         "OK" | "WARN" | "FAIL";
}

// Default log path — override via explicit user action in the UI.
// For now we ship no default; the panel shows an empty "no trace"
// state and the user opens a file to populate.
const DEFAULT_ISA_LOG_PATH = "";

export function VerificationSuite() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<VerifyTab>("isa");
  const [log,         setLog]         = useState<string[]>([]);
  const [isaRows,     setIsaRows]     = useState<IsaResult[] | null>(null);
  const [isaErr,      setIsaErr]      = useState<string | null>(null);
  const [isaLogPath,  setIsaLogPath]  = useState<string>(DEFAULT_ISA_LOG_PATH);

  // Kick off an ISA-log replay when a path is present.  Empty path
  // keeps `isaRows === null` which renders the honest "no trace
  // loaded" state rather than silently synthesising rows.
  useEffect(() => {
    if (!isaLogPath) { setIsaRows(null); setIsaErr(null); return; }
    invoke<IsaResult[]>("validate_isa_trace", { path: isaLogPath })
      .then((rows) => { setIsaRows(rows); setIsaErr(null); })
      .catch((e)   => { setIsaRows(null); setIsaErr(String(e)); });
  }, [isaLogPath]);

  const getStatusColor = (s: string) => {
    if (s === "PASS" || s === "OK") return theme.success;
    if (s === "FAIL") return theme.error;
    return theme.warning;
  };

  return (
    <div className="w-full h-full flex flex-col" style={{ background: theme.bg }}>
      {/* Verification Top Toolbar */}
      <div className="flex items-center px-4 h-12 shrink-0 border-b" style={{ borderColor: theme.border, background: theme.bgSurface }}>
        <ShieldCheck size={18} className="mr-2" style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13, marginRight: 24 }}>Verification Suite</span>
        
        <div className="flex rounded p-1 gap-1" style={{ border: `0.5px solid ${theme.borderSubtle}`, background: theme.bg }}>
          {[
            { id: "isa",   label: "ISA Dashboard", icon: <TerminalSquare size={14} /> },
            { id: "api",   label: "API Integrity", icon: <Activity size={14} />       },
            { id: "uvm",   label: "UVM Coverage",  icon: <Bug size={14} />            },
            { id: "synth", label: "Synth Status",  icon: <Cpu size={14} />            },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as VerifyTab)}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-medium transition-all"
              style={{
                background: activeTab === t.id ? theme.accentBg : "transparent",
                color: activeTab === t.id ? theme.accent : theme.textMuted
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />
        {activeTab === "isa" && (
          <input
            type="text"
            placeholder="ISA commit log path (e.g. hw/sim/work/tb_X/commit.log)"
            value={isaLogPath}
            onChange={(e) => setIsaLogPath(e.target.value)}
            aria-label="ISA commit log path"
            className="px-3 py-1.5 rounded text-xs font-mono"
            style={{
              width: 360,
              background: theme.bg,
              color: theme.text,
              border: `0.5px solid ${theme.borderSubtle}`,
            }}
          />
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Module Views */}
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          
          {activeTab === "isa" && (
            <div className="flex flex-col h-full">
              <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                <TerminalSquare size={16} /> ISA Cycle-Accurate Validation Matrix
              </h3>
              <div className="flex-1 rounded border overflow-hidden flex flex-col" style={{ borderColor: theme.border, background: theme.bgPanel }}>
                {isaErr && (
                  <div className="p-3 text-xs" style={{ color: theme.error }}>
                    validate_isa_trace failed: {isaErr}
                  </div>
                )}
                {!isaErr && !isaRows && (
                  <div className="p-4 text-xs" style={{ color: theme.textMuted }}>
                    No ISA commit log loaded. Paste a path to a Spike
                    <code className="mx-1" style={{ color: theme.accent }}>--log-commits</code>
                    file in the toolbar above to populate this table.
                  </div>
                )}
                {!isaErr && isaRows && isaRows.length === 0 && (
                  <div className="p-4 text-xs" style={{ color: theme.textMuted }}>
                    Loaded log contains no parsable commit lines.
                  </div>
                )}
                {!isaErr && isaRows && isaRows.length > 0 && (
                  <IsaVirtualTable rows={isaRows} getStatusColor={getStatusColor} />
                )}
              </div>
            </div>
          )}

          {activeTab === "api" && <APIIntegrityPanel />}

          {activeTab === "uvm" && <UVMCoveragePanel />}

          {activeTab === "synth" && (
            <div className="flex flex-col h-full gap-3">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Cpu size={16} /> pccx-FPGA Verification Dashboard
              </h3>
              <VerificationRunner repoPath={DEFAULT_REPO_PATH} />
              <SynthStatusCard
                utilizationPath={DEFAULT_UTIL_PATH}
                timingPath={DEFAULT_TIMING_PATH}
              />
              <RooflineCard />
              <BottleneckCard />
              <p className="text-[11px] mt-1" style={{ color: theme.textMuted }}>
                Paths are relative to the <code>pccx-lab</code> binary's working directory.
                Override via props when embedding this widget elsewhere.
              </p>
            </div>
          )}
        </div>

        {/* Verification Run Log — reserved for real IPC-emitted
            events (no timer-based fake content).  Populated when
            `run_verification` / `validate_isa_trace` wiring lands. */}
        <div className="w-[300px] border-l flex flex-col" style={{ borderColor: theme.border, background: theme.bgPanel }}>
           <div className="p-3 border-b text-xs font-bold flex justify-between" style={{ borderColor: theme.border }}>
             <span>Run Log</span>
             <button onClick={() => setLog([])} style={{ color: theme.textMuted }} aria-label="Clear run log">Clear</button>
           </div>
           <RunLogVirtual log={log} />
        </div>
      </div>
    </div>
  );
}

/* ─── UVM Coverage Panel ──────────────────────────────────────────────────── */
// Data is fetched from `invoke('merge_coverage', { runs })`. The legacy
// hard-coded coverpoint / regression-history literal arrays were removed
// in T-2 — do not reintroduce.

type CovSubTab = "heatmap" | "cross";

function UVMCoveragePanel() {
  const theme = useTheme();
  const [merged, setMerged] = useState<MergedCoverage | null>(null);
  const [err, setErr]       = useState<string | null>(null);
  const [sub, setSub]       = useState<CovSubTab>("heatmap");

  useEffect(() => {
    invoke<MergedCoverage>("merge_coverage", { runs: DEFAULT_RUNS })
      .then(setMerged)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err)    return <div style={{ color: theme.error, fontSize: 12 }}>merge_coverage failed: {err}</div>;
  if (!merged) return <div style={{ color: theme.textMuted, fontSize: 12 }}>Loading coverage…</div>;

  const totalBins = merged.groups.reduce((a, g) => a + g.bins.length, 0);
  const hitBins   = merged.groups.reduce(
    (a, g) => a + g.bins.filter((b) => b.hits > 0).length, 0);
  const pct = totalBins === 0 ? 0 : (hitBins / totalBins) * 100;

  return (
    <div className="flex flex-col h-full gap-4">
      <h3 className="text-sm font-bold flex items-center gap-2">
        <Bug size={16} /> UVM Coverage — pccx v002 (merged {DEFAULT_RUNS.length} runs)
      </h3>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label="functional"   value={`${pct.toFixed(1)}%`} tone={pct > 95 ? "ok" : pct > 80 ? "warn" : "bad"} />
        <StatCard label="bins covered" value={`${hitBins} / ${totalBins}`} />
        <StatCard label="groups"       value={`${merged.groups.length}`} />
        <StatCard label="cross tuples" value={`${merged.crosses.length}`} />
      </div>

      <div className="flex rounded p-1 gap-1 self-start" style={{ border: `0.5px solid ${theme.borderSubtle}`, background: theme.bg }}>
        {(["heatmap", "cross"] as CovSubTab[]).map((id) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className="px-3 py-1 rounded text-[11px] font-medium"
            style={{
              background: sub === id ? theme.accentBg : "transparent",
              color: sub === id ? theme.accent : theme.textMuted,
            }}
          >
            {id === "heatmap" ? "Group Heatmap" : "Cross Heatmap"}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {sub === "heatmap" ? <GroupHeatmap groups={merged.groups} /> :
                             <CrossHeatmap crosses={merged.crosses} />}
      </div>
    </div>
  );
}

function GroupHeatmap({ groups }: { groups: CovGroup[] }) {
  const theme = useTheme();
  return (
    <div className="rounded border overflow-hidden flex flex-col h-full" style={{ borderColor: theme.border, background: theme.bgPanel }}>
      <div className="flex items-center justify-between" style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: theme.textMuted, letterSpacing: "0.05em", borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
        <span>COVERPOINT HEATMAP — hits / goal per bin</span>
        <span style={{ color: theme.textDim, fontWeight: 500 }}>goal% turns red &lt; 80</span>
      </div>
      <div className="flex-1 overflow-auto p-3 grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
        {groups.map((g) => {
          const totalHits = g.bins.reduce((a, b) => a + b.hits, 0);
          const totalGoal = g.bins.reduce((a, b) => a + b.goal, 0);
          const covPct    = totalGoal === 0
            ? (g.bins.length ? 100 : 0)
            : Math.min(100, (totalHits / totalGoal) * 100);
          const isRed     = totalGoal > 0 && totalHits / totalGoal < 0.8;
          const bgColor   = isRed ? "#ef4444" : covPct === 100 ? "#22c55e" : "#eab308";
          return (
            <div key={g.name} style={{
              background: bgColor + "22", border: `1px solid ${bgColor}66`,
              borderRadius: 4, padding: "6px 8px", fontSize: 10,
            }}>
              <div style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.text, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</div>
              <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 2 }}>{g.bins.length} bins</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                <span style={{ color: bgColor, fontWeight: 700 }}>{covPct.toFixed(0)}%</span>
                <span style={{ color: theme.textDim, fontFamily: theme.fontMono }}>{totalHits}/{totalGoal}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 4 }}>
                {g.bins.map((b) => {
                  const binPct  = b.goal === 0 ? (b.hits > 0 ? 100 : 0) : Math.min(100, (b.hits / b.goal) * 100);
                  const binRed  = b.goal > 0 && b.hits / b.goal < 0.8;
                  const binCol  = binRed ? "#ef4444" : binPct === 100 ? "#22c55e" : "#eab308";
                  return (
                    <span key={b.id}
                      title={`${b.id}: ${b.hits}/${b.goal} (${binPct.toFixed(0)}%)`}
                      style={{ width: 8, height: 8, borderRadius: 1, background: binCol }}/>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CrossHeatmap({ crosses }: { crosses: CrossTuple[] }) {
  const theme = useTheme();
  // Filter the canonical (gemm_k_stride × mem_hp_backpressure) cross.
  const rel = crosses.filter(
    (c) => c.a_group === "gemm_k_stride" && c.b_group === "mem_hp_backpressure");
  const aBins = ["1", "2", "4", "8", "16", "32", "64", "128"];            // 8
  const bBins = ["lo", "mid", "hi", "critical"];                          // 4
  const cell  = (a: string, b: string) => rel.find((c) => c.a_bin === a && c.b_bin === b);

  return (
    <div className="rounded border overflow-hidden flex flex-col h-full" style={{ borderColor: theme.border, background: theme.bgPanel }}>
      <div className="flex items-center justify-between" style={{ padding: "8px 12px", fontSize: 10, fontWeight: 700, color: theme.textMuted, letterSpacing: "0.05em", borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
        <span>CROSS HEATMAP — gemm_k_stride × mem_hp_backpressure (8 × 4)</span>
        <span style={{ color: theme.textDim, fontWeight: 500 }}>goal% &lt; 80 → red</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <table style={{ borderCollapse: "separate", borderSpacing: 2, fontSize: 10 }}>
          <thead>
            <tr>
              <th style={{ color: theme.textMuted, padding: "0 6px" }}>stride \ bp</th>
              {bBins.map((b) => (
                <th key={b} style={{ color: theme.textDim, fontFamily: theme.fontMono, padding: "0 8px" }}>{b}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {aBins.map((a) => (
              <tr key={a}>
                <td style={{ color: theme.textDim, fontFamily: theme.fontMono, padding: "0 6px" }}>{a}</td>
                {bBins.map((b) => {
                  const c     = cell(a, b);
                  const hits  = c?.hits ?? 0;
                  const goal  = c?.goal ?? 0;
                  const ratio = goal === 0 ? (hits > 0 ? 1 : 0) : hits / goal;
                  const pct   = Math.min(100, ratio * 100);
                  const isRed = goal > 0 && ratio < 0.8;
                  const col   = isRed ? "#ef4444" : ratio >= 1 ? "#22c55e" : "#eab308";
                  const tip   = `(${a}, ${b}) — ${hits}/${goal} hits, ${pct.toFixed(0)}%${isRed ? " — below 80% goal" : ""}`;
                  return (
                    <td key={b} title={tip}
                        style={{
                          width: 52, height: 34, textAlign: "center",
                          background: col + "33", border: `1px solid ${col}88`,
                          color: col, fontWeight: 700, borderRadius: 3,
                          cursor: "help",
                        }}>
                      {hits}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 p-2 rounded" style={{ background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, fontSize: 10, color: theme.textDim }}>
          Each cell shows merged hits across run_a + run_b + run_c.
          Hover for (a_bin, b_bin, hits, goal%). Red = &lt; 80% goal.
        </div>
      </div>
    </div>
  );
}

/* ─── API Integrity Panel ─────────────────────────────────────────────────── */
// Rows come from `invoke('list_api_calls')` — backed by the core's
// ApiRing (fed from the cached trace, or a synthetic fallback when
// no trace is loaded).  No literal arrays.

function formatLatency(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000)     return `${(ns / 1_000    ).toFixed(2)} µs`;
  return `${ns} ns`;
}

function APIIntegrityPanel() {
  const theme = useTheme();
  const [rows, setRows] = useState<ApiCall[] | null>(null);
  const [err,  setErr ] = useState<string | null>(null);

  useEffect(() => {
    invoke<ApiCall[]>("list_api_calls")
      .then(setRows)
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return <div style={{ color: theme.error, fontSize: 12 }}>list_api_calls failed: {err}</div>;
  }
  if (!rows) {
    return <div style={{ color: theme.textMuted, fontSize: 12 }}>Loading API calls…</div>;
  }
  if (rows.length === 0) {
    return (
      <div style={{ color: theme.textMuted, fontSize: 12 }}>
        No trace loaded — open a .pccx file to populate the API integrity ring.
      </div>
    );
  }

  const okCount = rows.filter((r) => r.status === "OK").length;
  const totalDrops = rows.reduce((a, r) => a + r.drops, 0);

  return (
    <div className="flex flex-col h-full gap-4">
      <h3 className="text-sm font-bold flex items-center gap-2">
        <Activity size={16} /> API Integrity — <code style={{ color: theme.accent }}>uca_*</code> driver surface
      </h3>
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="APIs checked"   value={`${rows.length}`} />
        <StatCard label="passing"        value={`${okCount}`} tone="ok" />
        <StatCard label="dropped events" value={`${totalDrops}`} />
        <StatCard label="samples"        value={`${rows.length}`} />
      </div>
      <ApiVirtualTable rows={rows} />
    </div>
  );
}

/* ─── Virtualized ISA Table ──────────────────────────────────────────────── */

const ISA_COL_GRID = "minmax(100px,1.2fr) minmax(90px,1fr) minmax(120px,1.5fr) 80px 80px 70px";
const ISA_ROW_HEIGHT = 32;

function IsaVirtualTable({ rows, getStatusColor }: { rows: IsaResult[]; getStatusColor: (s: string) => string }) {
  const theme = useTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ISA_ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ fontSize: 11 }}>
      {/* Header */}
      <div style={{
        display: "grid", gridTemplateColumns: ISA_COL_GRID,
        background: theme.bgSurface, borderBottom: `0.5px solid ${theme.borderSubtle}`,
        color: theme.textDim,
      }}>
        <div className="p-2">MNEMONIC</div>
        <div className="p-2">OPCODE</div>
        <div className="p-2">DECODE</div>
        <div className="p-2 text-right">EXP CYCLES</div>
        <div className="p-2 text-right">ACT CYCLES</div>
        <div className="p-2 text-center">STATUS</div>
      </div>
      {/* Scrollable body */}
      <div ref={parentRef} className="flex-1 overflow-auto min-h-0">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <div
                key={vi.index}
                style={{
                  position: "absolute", top: 0, left: 0, width: "100%",
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                  display: "grid", gridTemplateColumns: ISA_COL_GRID,
                  borderBottom: `0.5px solid ${theme.borderSubtle}`,
                  alignItems: "center",
                }}
              >
                <div className="p-2 font-mono" style={{ color: theme.accent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.inst}</div>
                <div className="p-2 font-mono" style={{ color: theme.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.opcode}</div>
                <div className="p-2" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.decode}</div>
                <div className="p-2 text-right">{row.expected_cycles}</div>
                <div className="p-2 text-right font-bold" style={{ color: row.expected_cycles !== row.actual_cycles ? theme.error : theme.text }}>{row.actual_cycles}</div>
                <div className="p-2 text-center">
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: `${getStatusColor(row.status)}22`, color: getStatusColor(row.status), border: `1px solid ${getStatusColor(row.status)}44` }}>
                    {row.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Virtualized API Table ──────────────────────────────────────────────── */

const API_COL_GRID = "minmax(120px,1.5fr) minmax(80px,1fr) 100px 60px 70px";
const API_ROW_HEIGHT = 34;

function ApiVirtualTable({ rows }: { rows: ApiCall[] }) {
  const theme = useTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => API_ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div className="flex-1 rounded border overflow-hidden flex flex-col min-h-0" style={{ borderColor: theme.border, background: theme.bgPanel, fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
      {/* Header */}
      <div style={{
        display: "grid", gridTemplateColumns: API_COL_GRID,
        background: theme.bgSurface, color: theme.textMuted,
        borderBottom: `0.5px solid ${theme.borderSubtle}`,
      }}>
        <div style={{ padding: "6px 10px", textAlign: "left" }}>API</div>
        <div style={{ padding: "6px 10px", textAlign: "left" }}>Kind</div>
        <div style={{ padding: "6px 10px", textAlign: "right" }}>p99 Latency</div>
        <div style={{ padding: "6px 10px", textAlign: "right" }}>Drops</div>
        <div style={{ padding: "6px 10px", textAlign: "left" }}>Status</div>
      </div>
      {/* Scrollable body */}
      <div ref={parentRef} className="flex-1 overflow-auto min-h-0">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const r = rows[vi.index];
            const col = r.status === "OK" ? theme.success : r.status === "WARN" ? theme.warning : theme.error;
            return (
              <div
                key={vi.index}
                style={{
                  position: "absolute", top: 0, left: 0, width: "100%",
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                  display: "grid", gridTemplateColumns: API_COL_GRID,
                  borderBottom: `0.5px solid ${theme.borderSubtle}`,
                  color: theme.text, alignItems: "center",
                }}
              >
                <div style={{ padding: "6px 10px", color: theme.accent }}>{r.api}</div>
                <div style={{ padding: "6px 10px", color: theme.textDim }}>{r.kind}</div>
                <div style={{ padding: "6px 10px", textAlign: "right" }}>{formatLatency(r.p99_latency_ns)}</div>
                <div style={{ padding: "6px 10px", textAlign: "right", color: r.drops > 0 ? theme.warning : theme.textDim }}>{r.drops}</div>
                <div style={{ padding: "6px 10px" }}>
                  <span style={{ padding: "1px 8px", border: `1px solid ${col}66`, borderRadius: 3, color: col, fontSize: 10, fontWeight: 700 }}>
                    {r.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Virtualized Run Log ────────────────────────────────────────────────── */

const LOG_LINE_HEIGHT = 18;

function RunLogVirtual({ log }: { log: string[] }) {
  const theme = useTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: log.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LOG_LINE_HEIGHT,
    overscan: 10,
  });

  return (
    <div ref={parentRef} className="flex-1 p-3 overflow-y-auto font-mono text-[10px]">
      {log.length === 0 && (
        <span style={{ color: theme.textFaint }}>
          No active runs — use the Synth tab's Run Verification button
          or load an ISA commit log to populate this pane.
        </span>
      )}
      {log.length > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const l = log[vi.index];
            return (
              <div
                key={vi.index}
                style={{
                  position: "absolute", top: 0, left: 0, width: "100%",
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                  color: l.includes("FAIL") || l.includes("Violat") ? theme.error : theme.textDim,
                }}
              >
                {l}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const theme = useTheme();
  const col = tone === "ok" ? theme.success : tone === "warn" ? theme.warning : tone === "bad" ? theme.error : theme.text;
  return (
    <div style={{ padding: "10px 12px", background: theme.bgPanel, borderRadius: 6, border: `0.5px solid ${theme.borderSubtle}` }}>
      <div style={{ fontSize: 9, color: theme.textMuted, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: col, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>{value}</div>
    </div>
  );
}
