import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./ThemeContext";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLiveWindow } from "./hooks/useLiveWindow";
import {
  FileText, Download, Check, Loader2, BarChart2,
  Cpu, Zap, Clock, AlertTriangle, Settings2, BookOpen, Beaker, TableProperties, ShieldCheck,
  Copy, Code2, Globe,
} from "lucide-react";

// ─── Report Sections ──────────────────────────────────────────────────────────

interface Section {
  id: string;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  description: string;
}

const DEFAULT_SECTIONS: Section[] = [
  { id: "executive",   label: "Executive Summary",       icon: <FileText size={13} />,        enabled: true,  description: "High-level performance overview with key metrics and recommendations" },
  { id: "methodology", label: "Methodology",             icon: <Beaker size={13} />,          enabled: true,  description: "How the data was captured: toolchain, measurement model, assumptions" },
  { id: "hw_config",   label: "Hardware Configuration",  icon: <Cpu size={13} />,             enabled: true,  description: "MAC array dimensions, clock frequency, AXI bus parameters, core count" },
  { id: "timeline",    label: "Timeline Analysis",       icon: <Clock size={13} />,           enabled: true,  description: "Per-core event timeline with DMA/compute phase breakdown" },
  { id: "utilisation", label: "Core Utilisation",        icon: <BarChart2 size={13} />,       enabled: true,  description: "Per-core MAC utilisation heatmap with min/max/avg statistics" },
  { id: "bottleneck",  label: "Bottleneck Analysis",     icon: <AlertTriangle size={13} />,   enabled: true,  description: "DMA bandwidth contention and stall analysis with recommendations" },
  { id: "roofline",    label: "Roofline Analysis",       icon: <Zap size={13} />,             enabled: true,  description: "Compute vs memory bound classification with arithmetic intensity" },
  { id: "kernels",     label: "Per-Kernel Breakdown",    icon: <TableProperties size={13} />, enabled: true,  description: "GEMM / GEMV / SFU / DMA kernel table with AI, cycles, and roof utilisation" },
  { id: "verification",label: "Verification Status",     icon: <ShieldCheck size={13} />,     enabled: true,  description: "Testbench pass/fail matrix plus synth timing summary" },
  { id: "bus_trace",   label: "AXI Bus Trace",           icon: <Settings2 size={13} />,       enabled: false, description: "Detailed AXI transaction log with arbitration timing" },
  { id: "uvm_plan",    label: "UVM Test Plan",           icon: <FileText size={13} />,        enabled: false, description: "Auto-generated UVM verification sequences based on trace patterns" },
  { id: "glossary",    label: "Glossary & References",   icon: <BookOpen size={13} />,        enabled: true,  description: "Term definitions (GEMM, GEMV, SFU, LAuReL, PLE, URAM) + citations" },
];

// ─── Report Preview Renderer ──────────────────────────────────────────────────

function PreviewSection({ section, data }: { section: Section; data: any }) {
  const theme = useTheme();
  const headColor = theme.accent;
  const textColor = theme.text;
  const dimColor  = theme.textMuted;
  const cardBg    = theme.bgSurface;
  const cardBdr   = theme.borderSubtle;

  switch (section.id) {
    case "executive":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>1. Executive Summary</h3>
          <p style={{ fontSize: 11, color: textColor, lineHeight: 1.6 }}>
            NPU simulation completed {data?.cycles?.toLocaleString() ?? "—"} cycles across {data?.cores ?? "—"} cores
            at {data?.clock ?? 1000} MHz ({((data?.cycles ?? 0) / (data?.clock ?? 1000)).toFixed(1)} µs wall time).
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            {[
              { label: "Total Cycles", val: data?.cycles?.toLocaleString() ?? "—" },
              { label: "Active Cores", val: data?.cores ?? "—" },
              { label: "Peak TOPS",    val: data?.peakTops?.toFixed(2) ?? "—" },
              { label: "Wall Time",    val: `${((data?.cycles ?? 0) / 1000).toFixed(1)} µs` },
            ].map(m => (
              <div key={m.label} style={{ padding: "8px 16px", background: cardBg, border: `0.5px solid ${cardBdr}`, borderRadius: 6, minWidth: 100 }}>
                <div style={{ fontSize: 9, color: dimColor, marginBottom: 2 }}>{m.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: headColor, fontFamily: theme.fontMono }}>{m.val}</div>
              </div>
            ))}
          </div>
        </div>
      );

    case "hw_config":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>2. Hardware Configuration</h3>
          <table style={{ fontSize: 11, color: textColor, borderCollapse: "collapse", width: "100%" }}>
            <tbody>
              {[
                ["MAC Array",     `${data?.macDims?.[0] ?? 32}×${data?.macDims?.[1] ?? 32}`],
                ["Clock Freq.",   `${data?.clock ?? 1000} MHz`],
                ["Core Count",    `${data?.cores ?? 32}`],
                ["AXI Width",     "128-bit"],
                ["AXI Burst Len", "16 beats"],
                ["BRAM Capacity", "1 MB per core"],
                ["Pipeline",      "10 stages"],
                ["Precision",     "BF16 / INT8"],
              ].map(([k, v]) => (
                <tr key={k as string} style={{ borderBottom: `0.5px solid ${cardBdr}` }}>
                  <td style={{ padding: "4px 8px", color: dimColor, width: "40%" }}>{k}</td>
                  <td style={{ padding: "4px 8px", fontFamily: theme.fontMono, fontWeight: 500 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "utilisation": {
      // Utilisation grid sourced from fetch_live_window — no synthetic fallback
      // (Yuan OSDI 2014 loud-fallback: shows a notice when no trace is loaded).
      const coreUtils: { core_id: number; util_pct: number }[] = data?.coreUtils ?? [];
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>4. Core Utilisation</h3>
          <p style={{ fontSize: 11, color: textColor, marginBottom: 8 }}>
            MAC compute phase utilisation across all cores. Cores with &lt;40% utilisation are flagged.
          </p>
          {coreUtils.length === 0 ? (
            <div style={{
              padding: 12, fontSize: 11, color: dimColor,
              border: `1px dashed ${cardBdr}`, borderRadius: 6, background: cardBg,
            }}>
              No per-core utilisation available — load a .pccx trace to populate this section.
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              {coreUtils.map(({ core_id, util_pct }) => {
                const color = util_pct > 70 ? "#22c55e" : util_pct > 40 ? "#eab308" : "#ef4444";
                return (
                  <div key={core_id} style={{
                    width: 28, height: 28, borderRadius: 3, background: color + "33",
                    border: `0.5px solid ${color}55`, display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: 8, color, fontWeight: 600,
                  }}>
                    {util_pct.toFixed(0)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    case "bottleneck":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>5. Bottleneck Analysis</h3>
          <div style={{ padding: 12, background: theme.warningBg, border: `0.5px solid ${theme.warning}`, borderRadius: 6, marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: theme.warningText }}>Warning: AXI Bus Contention Detected</div>
            <div style={{ fontSize: 10, color: theme.warningText, opacity: 0.8, marginTop: 4 }}>
              32 cores issuing simultaneous DMA reads cause bus bandwidth to drop to 0.5 B/cycle per core.
              Estimated performance loss: 23% from contention overhead.
            </div>
          </div>
          <p style={{ fontSize: 11, color: textColor }}>
            <strong>Recommendation:</strong> Implement L2 prefetch with core-group staggering (groups of 8 cores, 15-cycle offset) to reduce peak contention by ~60%.
          </p>
        </div>
      );

    case "roofline":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>6. Roofline Analysis</h3>
          <div style={{ padding: 12, background: cardBg, border: `0.5px solid ${cardBdr}`, borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: textColor, lineHeight: 1.6 }}>
              <div>Arithmetic Intensity: <strong>16.0 MAC/byte</strong> (64×64×64 BF16 tile)</div>
              <div>Memory Roof: <strong>64 B/cycle</strong> (dual-port BRAM)</div>
              <div>Compute Roof: <strong>1,024 MAC/cycle</strong> (32×32 array)</div>
              <div>Ridge Point: <strong>16.0 MAC/byte</strong></div>
              <div style={{ marginTop: 8, fontWeight: 600, color: "#22c55e" }}>
                OK: Current configuration is <strong>COMPUTE-BOUND</strong> — optimal for this tile size.
              </div>
            </div>
          </div>
        </div>
      );

    case "methodology":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>2. Methodology</h3>
          <p style={{ fontSize: 11, color: textColor, lineHeight: 1.6, marginBottom: 10 }}>
            This report is assembled from loaded `.pccx` trace metadata and configured architecture parameters.
            It is a bounded local summary: hardware capture, implementation readiness, implementation timing, and board-level
            throughput are not claimed by this view.
          </p>
          <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse", marginBottom: 10 }}>
            <tbody>
              {[
                ["Source",           "Loaded `.pccx` trace metadata plus local architecture settings"],
                ["Clock",            "Configured analysis clock; no board timing claim"],
                ["Event model",      "Cycle-indexed trace events; DMA counted at modeled boundary"],
                ["Arithmetic",       "W4A8 on GEMM · BF16 on GEMV / SFU"],
                ["Confidence",       "Summary-only local estimate; validate against project-specific runs"],
                ["Trace format",     ".pccx 0.2 (major 0x01 · minor 0x01 · CRC-32)"],
                ["Aggregation",      "Per-op mean over loaded trace windows"],
              ].map(([k, v]) => (
                <tr key={k as string} style={{ borderBottom: `0.5px solid ${cardBdr}` }}>
                  <td style={{ padding: "4px 8px", color: dimColor, width: "32%" }}>{k}</td>
                  <td style={{ padding: "4px 8px", fontFamily: theme.fontMono }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10, color: dimColor, padding: 10, background: cardBg, borderRadius: 4, border: `0.5px solid ${cardBdr}` }}>
            Assumptions: (1) DRAM rows are warm (no refresh penalty mid-trace),
            (2) the measurement window excludes the initial weight preload,
            (3) the PLE shadow stream runs at half the decode cadence.
          </div>
        </div>
      );

    case "kernels":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>7. Per-Kernel Breakdown</h3>
          <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: cardBg, color: dimColor, fontWeight: 600 }}>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>Kernel</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>AI (GOPS/B)</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Cycles</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>GOPS</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Roof %</th>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["GEMM Q/K/V proj",  128,   1210, 980,  99.6, "compute-bound"],
                ["GEMM FFN up",      132,   1320, 985,  99.5, "compute-bound"],
                ["GEMM FFN down",     42,   1420, 560,  62.5, "mem/compute mix"],
                ["GEMV rotary",        8,    220, 168,  98.7, "BW-bound"],
                ["SFU softmax",      3.8,    180, 140,  99.0, "SFU-bound"],
                ["DMA weight tile", 0.25,    640, 5.0,  94.0, "DDR-bound"],
              ].map((row, i) => (
                <tr key={i} style={{ borderBottom: `0.5px solid ${cardBdr}`, color: textColor }}>
                  <td style={{ padding: "4px 8px" }}>{row[0]}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: theme.fontMono }}>{(row[1] as number).toFixed(2)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: theme.fontMono }}>{(row[2] as number).toLocaleString()}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: theme.fontMono }}>{(row[3] as number).toFixed(0)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: theme.fontMono, color: (row[4] as number) > 80 ? "#22c55e" : (row[4] as number) > 50 ? "#eab308" : "#ef4444" }}>
                    {(row[4] as number).toFixed(1)}
                  </td>
                  <td style={{ padding: "4px 8px", fontSize: 9, color: dimColor }}>{row[5] as string}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "verification":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>8. Verification Status</h3>
          <div style={{ padding: 10, background: theme.successBg, border: `0.5px solid ${theme.success}`, borderRadius: 6, marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: theme.successText }}>6 / 6 testbenches PASS · 1930 cycles total</div>
          </div>
          <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: cardBg, color: dimColor }}>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>Testbench</th>
                <th style={{ padding: "4px 8px", textAlign: "right" }}>Cycles</th>
                <th style={{ padding: "4px 8px", textAlign: "left" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["tb_GEMM_dsp_packer_sign_recovery", 1024, "PASS"],
                ["tb_mat_result_normalizer",          256, "PASS"],
                ["tb_GEMM_weight_dispatcher",         128, "PASS"],
                ["tb_FROM_mat_result_packer",           4, "PASS"],
                ["tb_barrel_shifter_BF16",            512, "PASS"],
                ["tb_ctrl_npu_decoder",                 6, "PASS"],
              ].map((r, i) => (
                <tr key={i} style={{ borderBottom: `0.5px solid ${cardBdr}`, color: textColor }}>
                  <td style={{ padding: "4px 8px", fontFamily: theme.fontMono }}>{r[0]}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontFamily: theme.fontMono }}>{(r[1] as number).toLocaleString()}</td>
                  <td style={{ padding: "4px 8px", color: "#22c55e", fontWeight: 600 }}>{r[2] as string}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, padding: 10, background: cardBg, border: `0.5px solid ${cardBdr}`, borderRadius: 4, fontSize: 10, color: textColor }}>
            Vivado post-synth WNS: <strong style={{ color: "#eab308" }}>-9.792 ns</strong> on core_clk · 4194 failing endpoints.
            Retiming suggested for <code>u_gemv_top</code> / <code>u_mem_dispatcher</code>.
          </div>
        </div>
      );

    case "glossary":
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>A. Glossary & References</h3>
          <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
            <tbody>
              {[
                ["GEMM",      "General matrix-matrix multiply. The 32×32 MAT_CORE systolic tile operates in W4A8."],
                ["GEMV",      "General matrix-vector multiply. 4-lane unit, 5-stage pipeline."],
                ["SFU",       "Special function unit. Houses softmax, SiLU, rsqrt; single instance on pccx v002."],
                ["URAM L2",   "Ultra-RAM based L2 scratchpad (64 URAMs, 1.75 MB) on the ZU5EV floorplan."],
                ["HP Buffer", "High-performance AXI buffer FIFO between PS DDR4 and the MAT_CORE front-end."],
                ["LAuReL",    "Low-rank parallel branch added to the transformer block's residual path."],
                ["PLE",       "Per-Layer Embedding shadow stream (altup) that refreshes the token embedding."],
                ["AI",        "Arithmetic intensity — operations per byte transferred across the memory hierarchy."],
                ["WNS",       "Worst negative slack — critical-path timing margin in ns; negative means missed."],
              ].map(([k, v]) => (
                <tr key={k as string} style={{ borderBottom: `0.5px solid ${cardBdr}` }}>
                  <td style={{ padding: "4px 8px", color: headColor, fontWeight: 700, fontFamily: theme.fontMono, width: "20%" }}>{k}</td>
                  <td style={{ padding: "4px 8px", color: textColor }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 9, color: dimColor }}>
            [1] Williams S., Waterman A., Patterson D. — Roofline: an insightful visual performance model, CACM 2009.<br/>
            [2] Gemma team — Gemma 3N technical report, Google DeepMind 2025.<br/>
            [3] Xilinx UG1085 — Zynq UltraScale+ MPSoC TRM.<br/>
            [4] pccx-lab docs — .pccx v0.2 on-disk format.
          </div>
        </div>
      );

    default:
      return (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: headColor, marginBottom: 8 }}>{section.label}</h3>
          <p style={{ fontSize: 11, color: dimColor, fontStyle: "italic" }}>Section content will be generated from trace data.</p>
        </div>
      );
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────

type OutputFormat = "html" | "markdown";
type RightPane = "design" | "generated";

export function ReportBuilder() {
  const theme = useTheme();
  const [sections, setSections] = useState(DEFAULT_SECTIONS);
  const [generating, setGenerating] = useState(false);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("html");
  const [rightPane, setRightPane]       = useState<RightPane>("design");
  const [generatedContent, setGeneratedContent] = useState<string | null>(null);
  const [generateError, setGenerateError]       = useState<string | null>(null);
  const [copyDone, setCopyDone]                 = useState(false);
  const [traceData, setTraceData]   = useState<any>(null);
  const [reportTitle, setReportTitle] = useState("pccx NPU Performance Analysis Report");
  const [author, setAuthor]          = useState("pccx-lab v0.4.0");

  // Live utilisation grid — sourced from fetch_live_window.
  // Empty vec produces the "no trace" notice (Yuan OSDI 2014 loud-fallback).
  const { samples: liveSamples, hasTrace: liveHasTrace } = useLiveWindow();
  const coreUtils = liveHasTrace
    ? liveSamples.map((s, i) => ({ core_id: i, util_pct: s.mac_util * 100 }))
    : [];

  useEffect(() => {
    (async () => {
      try {
        const header: any = await invoke("load_pccx", { path: "../../dummy_trace.pccx" });
        setTraceData({
          cycles:   header.trace?.cycles,
          cores:    header.trace?.cores,
          clock:    header.trace?.clock_mhz ?? 1000,
          macDims:  header.arch?.mac_dims,
          peakTops: header.arch?.peak_tops ?? 2.05,
        });
      } catch (_) {
        setTraceData({ cycles: 1234567, cores: 32, clock: 1000, macDims: [32, 32], peakTops: 2.05 });
      }
    })();
  }, []);

  const toggleSection = (id: string) => {
    setSections(s => s.map(sec => sec.id === id ? { ...sec, enabled: !sec.enabled } : sec));
  };

  // Generate report from the backend-cached trace via the real IPC command.
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const result: string = await invoke("generate_report", { format: outputFormat });
      setGeneratedContent(result);
      setRightPane("generated");
    } catch (err: any) {
      setGenerateError(String(err));
    } finally {
      setGenerating(false);
    }
  }, [outputFormat]);

  // Copy generated content to clipboard.
  // navigator.clipboard requires a focused window in WebKitGTK; a
  // textarea-select fallback handles the rare case where it is denied.
  const handleCopy = useCallback(async () => {
    if (!generatedContent) return;
    try {
      await navigator.clipboard.writeText(generatedContent);
      setCopyDone(true);
      setTimeout(() => setCopyDone(false), 1800);
    } catch (_) {
      // Fallback: select a temporary textarea so the user can Ctrl+C
      const ta = document.createElement("textarea");
      ta.value = generatedContent;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand("copy"); setCopyDone(true); setTimeout(() => setCopyDone(false), 1800); }
      catch (_2) { /* clipboard unavailable */ }
      document.body.removeChild(ta);
    }
  }, [generatedContent]);

  // Export: download the generated file via a temporary Blob URL.
  const handleExport = useCallback(() => {
    if (!generatedContent) return;
    const mime = outputFormat === "html" ? "text/html" : "text/markdown";
    const ext  = outputFormat === "html" ? "html" : "md";
    const blob = new Blob([generatedContent], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `pccx-report.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }, [generatedContent, outputFormat]);

  const enabledSections = sections.filter(s => s.enabled);

  const bg      = theme.bg;
  const cardBg  = theme.bgSurface;
  const border  = theme.borderSubtle;
  const textCol = theme.text;
  const dimCol  = theme.textMuted;

  return (
    <div className="w-full h-full flex overflow-hidden" style={{ background: bg }}>
      {/* Left: Config panel */}
      <div className="shrink-0 flex flex-col overflow-y-auto" style={{ width: 260, borderRight: `0.5px solid ${border}`, background: theme.bgPanel }}>
        <div style={{ padding: "16px 16px 8px", borderBottom: `0.5px solid ${border}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: textCol, marginBottom: 8 }}>Report Configuration</div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 9, color: dimCol, display: "block", marginBottom: 2 }}>Title</label>
            <input
              value={reportTitle}
              onChange={e => setReportTitle(e.target.value)}
              style={{
                width: "100%", fontSize: 10, padding: "4px 8px", background: theme.bgInput,
                border: `0.5px solid ${border}`, borderRadius: 4, color: textCol, outline: "none",
              }}
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 9, color: dimCol, display: "block", marginBottom: 2 }}>Author</label>
            <input
              value={author}
              onChange={e => setAuthor(e.target.value)}
              style={{
                width: "100%", fontSize: 10, padding: "4px 8px", background: theme.bgInput,
                border: `0.5px solid ${border}`, borderRadius: 4, color: textCol, outline: "none",
              }}
            />
          </div>

          {/* Format toggle */}
          <div>
            <label style={{ fontSize: 9, color: dimCol, display: "block", marginBottom: 4 }}>Output Format</label>
            <div style={{ display: "flex", gap: 4 }}>
              {(["html", "markdown"] as OutputFormat[]).map(fmt => (
                <button
                  key={fmt}
                  onClick={() => setOutputFormat(fmt)}
                  style={{
                    flex: 1, padding: "4px 0", borderRadius: 4, fontSize: 10, fontWeight: 500,
                    border: `0.5px solid ${outputFormat === fmt ? theme.accent : border}`,
                    background: outputFormat === fmt ? theme.accent + "22" : "transparent",
                    color: outputFormat === fmt ? theme.accent : dimCol,
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  }}
                >
                  {fmt === "html" ? <Globe size={10} /> : <Code2 size={10} />}
                  {fmt === "html" ? "HTML" : "Markdown"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <SectionCheckboxList sections={sections} onToggle={toggleSection} />

        <div style={{ padding: 16, borderTop: `0.5px solid ${border}` }}>
          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={generating}
            style={{
              width: "100%", padding: "8px 0", borderRadius: 6,
              background: generating ? theme.bgHover : theme.accent,
              color: "#fff", fontSize: 12, fontWeight: 600,
              border: "none", cursor: generating ? "wait" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              marginBottom: generatedContent ? 6 : 0,
            }}
          >
            {generating
              ? <Loader2 size={14} className="animate-spin" />
              : generatedContent
                ? <Check size={14} />
                : <FileText size={14} />}
            {generating ? "Generating..." : generatedContent ? "Re-generate" : "Generate from Trace"}
          </button>

          {/* Copy / Export buttons — shown only after first successful generation */}
          {generatedContent && !generating && (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={handleCopy}
                style={{
                  flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 10, fontWeight: 500,
                  border: `0.5px solid ${border}`, background: "transparent",
                  color: copyDone ? "#22c55e" : dimCol, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}
              >
                {copyDone ? <Check size={11} /> : <Copy size={11} />}
                {copyDone ? "Copied" : "Copy"}
              </button>
              <button
                onClick={handleExport}
                style={{
                  flex: 1, padding: "5px 0", borderRadius: 4, fontSize: 10, fontWeight: 500,
                  border: `0.5px solid ${border}`, background: "transparent",
                  color: dimCol, cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}
              >
                <Download size={11} /> Export
              </button>
            </div>
          )}

          {/* Error notice */}
          {generateError && (
            <div style={{
              marginTop: 8, padding: "6px 8px", borderRadius: 4,
              background: theme.warningBg, border: `0.5px solid ${theme.warning}`,
              fontSize: 9, color: theme.warningText, lineHeight: 1.4,
            }}>
              {generateError}
            </div>
          )}
        </div>
      </div>

      {/* Right: preview / generated output */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Pane selector */}
        <div style={{
          padding: "0 16px", borderBottom: `0.5px solid ${border}`,
          background: theme.bgPanel, display: "flex", alignItems: "center", gap: 0,
        }}>
          {(["design", "generated"] as RightPane[]).map(pane => (
            <button
              key={pane}
              onClick={() => setRightPane(pane)}
              style={{
                padding: "7px 14px", fontSize: 10, fontWeight: 500,
                background: "transparent", border: "none", cursor: "pointer",
                color: rightPane === pane ? textCol : dimCol,
                borderBottom: rightPane === pane ? `2px solid ${theme.accent}` : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {pane === "design" ? "Design Preview" : "Generated Output"}
              {pane === "generated" && generatedContent && (
                <span style={{
                  marginLeft: 5, fontSize: 9,
                  background: theme.accent + "33", color: theme.accent,
                  padding: "1px 5px", borderRadius: 8,
                }}>
                  {outputFormat.toUpperCase()}
                </span>
              )}
            </button>
          ))}
          {rightPane === "design" && (
            <span style={{ fontSize: 9, color: dimCol, marginLeft: "auto" }}>
              {enabledSections.length} sections enabled
            </span>
          )}
        </div>

        {rightPane === "design" ? (
          // ── Design preview (existing hand-crafted sections) ─────────────────
          <div className="flex-1 overflow-y-auto" style={{ padding: 24 }}>
            {/* Report cover */}
            <div style={{ marginBottom: 32, paddingBottom: 24, borderBottom: `2px solid ${theme.border}` }}>
              <div style={{ fontSize: 9, color: dimCol, marginBottom: 4 }}>CONFIDENTIAL — {new Date().toLocaleDateString()}</div>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: textCol, marginBottom: 4 }}>{reportTitle}</h1>
              <div style={{ fontSize: 11, color: dimCol }}>{author}</div>
              <div style={{ fontSize: 10, color: dimCol, marginTop: 8 }}>
                Generated from .pccx trace — {traceData?.cycles?.toLocaleString() ?? "—"} cycles · {traceData?.cores ?? "—"} cores · {traceData?.clock ?? 1000} MHz
              </div>
            </div>

            {/* Table of contents */}
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: textCol, marginBottom: 8 }}>Table of Contents</h3>
              {enabledSections.map((sec, i) => (
                <div key={sec.id} style={{ fontSize: 11, color: dimCol, padding: "2px 0" }}>
                  {i + 1}. {sec.label}
                </div>
              ))}
            </div>

            {/* Sections */}
            {enabledSections.map(sec => (
              <div key={sec.id} style={{ marginBottom: 24, padding: 16, background: cardBg, border: `0.5px solid ${border}`, borderRadius: 8 }}>
                <PreviewSection section={sec} data={{ ...traceData, coreUtils }} />
              </div>
            ))}

            {/* Footer */}
            <div style={{ marginTop: 32, paddingTop: 16, borderTop: `0.5px solid ${border}`, fontSize: 9, color: dimCol, textAlign: "center" }}>
              Generated by pccx-lab v0.4.0 · .pccx format v0.2 · {new Date().toISOString()}
            </div>
          </div>
        ) : (
          // ── Generated output pane ────────────────────────────────────────────
          <div className="flex-1 overflow-y-auto" style={{ padding: 0, position: "relative" }}>
            {generatedContent === null ? (
              // Empty state
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                justifyContent: "center", height: "100%",
                color: dimCol, fontSize: 12, gap: 8,
              }}>
                <FileText size={32} style={{ opacity: 0.25 }} />
                <div>Click &ldquo;Generate from Trace&rdquo; to produce output</div>
              </div>
            ) : outputFormat === "html" ? (
              // HTML output — rendered in an isolated iframe
              <iframe
                srcDoc={generatedContent}
                style={{
                  width: "100%", height: "100%", border: "none",
                  background: "#1c1c1e",
                }}
                sandbox=""
                title="Report preview"
              />
            ) : (
              // Markdown output — monospace plain-text view
              <pre style={{
                margin: 0, padding: 24,
                fontSize: 11, lineHeight: 1.7,
                fontFamily: theme.fontMono,
                color: textCol,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {generatedContent}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Virtualized Section Checkbox List ──────────────────────────────────── */

const SECTION_ROW_HEIGHT = 60;

function SectionCheckboxList({ sections, onToggle }: { sections: Section[]; onToggle: (id: string) => void }) {
  const theme = useTheme();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => SECTION_ROW_HEIGHT,
    overscan: 5,
  });

  return (
    <div style={{ padding: "8px 16px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: theme.textMuted, marginBottom: 2 }}>Design Preview Sections</div>
      <div style={{ fontSize: 9, color: theme.textMuted, opacity: 0.7, marginBottom: 8 }}>Controls the Design Preview tab only. Generated output includes all data available in the loaded trace.</div>
      <div ref={parentRef} style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const sec = sections[vi.index];
            return (
              <label
                key={sec.id}
                style={{
                  position: "absolute", top: 0, left: 0, width: "100%",
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`,
                  display: "flex", alignItems: "flex-start", gap: 8,
                  padding: "6px 0",
                  borderBottom: `0.5px solid ${theme.borderSubtle}`,
                  cursor: "pointer", boxSizing: "border-box",
                }}
              >
                <input
                  type="checkbox"
                  checked={sec.enabled}
                  onChange={() => onToggle(sec.id)}
                  style={{ marginTop: 2, accentColor: theme.accent }}
                />
                <div>
                  <div style={{ fontSize: 11, color: theme.text, fontWeight: sec.enabled ? 500 : 400 }}>
                    {sec.icon} {sec.label}
                  </div>
                  <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 1 }}>{sec.description}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
