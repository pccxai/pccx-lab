import { useEffect, useRef, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as echarts from "echarts";
import { useTheme } from "./ThemeContext";
import { ActivitySquare, Zap, Cpu, HardDrive } from "lucide-react";

// Shape of `fetch_live_window` (see core/src/live_window.rs).
interface LiveSample { ts_ns: number; mac_util: number; dma_bw: number; stall_pct: number }

// pccx v002 · KV260 target roofline constants
const PEAK_TOPS   = 1024;   // 32×32 MAC @ 1 GHz = 1024 GOPS
const PEAK_DDR_BW = 21.3;   // LPDDR4-2400 × 64-bit effective
const PEAK_URAM_BW= 112.0;  // 64 URAM × 72b @ 250 MHz
const RIDGE_DDR   = PEAK_TOPS / PEAK_DDR_BW;
const RIDGE_URAM  = PEAK_TOPS / PEAK_URAM_BW;

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
}

// Kernels modelled from a Gemma 3N E4B single-token decode + the standalone tb_s
const KERNELS: Kernel[] = [
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

export function Roofline() {
  const theme = useTheme();
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedKind, setSelectedKind] = useState<Kernel["kind"] | "all">("all");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const filteredKernels = useMemo(
    () => selectedKind === "all" ? KERNELS : KERNELS.filter(k => k.kind === selectedKind),
    [selectedKind],
  );

  useEffect(() => {
    if (!chartRef.current) return;
    chartInstance.current?.dispose();
    chartInstance.current = echarts.init(chartRef.current);

    // Roofline lines
    const ddrMem   = [[0.05, 0.05 * PEAK_DDR_BW],  [RIDGE_DDR,  PEAK_TOPS]];
    const ddrComp  = [[RIDGE_DDR,  PEAK_TOPS],     [10000,      PEAK_TOPS]];
    const uramMem  = [[0.05, 0.05 * PEAK_URAM_BW], [RIDGE_URAM, PEAK_TOPS]];

    const option: echarts.EChartsCoreOption = {
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
              <span style="color:#888">${k.note}</span>`;
          }
          return p.seriesName;
        },
      },
      legend: {
        top: 4,
        right: 12,
        textStyle: { color: theme.textMuted, fontSize: 10 },
        itemGap: 12,
        data: ["DDR4 BW ceiling", "URAM L2 BW ceiling", "Compute ceiling (1024 GOPS)", "Kernels"],
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
      series: [
        {
          name: "DDR4 BW ceiling",
          type: "line",
          data: [...ddrMem, ...ddrComp],
          showSymbol: false,
          lineStyle: { width: 2, color: theme.error, type: "solid" },
          itemStyle: { color: theme.error },
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
        },
        {
          name: "Compute ceiling (1024 GOPS)",
          type: "line",
          data: [[0.05, PEAK_TOPS], [10000, PEAK_TOPS]],
          showSymbol: false,
          lineStyle: { width: 1, color: theme.textMuted, type: "dotted" },
          itemStyle: { color: theme.textMuted },
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
        },
      ],
    };
    chartInstance.current.setOption(option);
    const onResize = () => chartInstance.current?.resize();
    window.addEventListener("resize", onResize);
    chartInstance.current.on("mouseover", (p: any) => p.componentSubType === "scatter" && setHoverIdx(p.dataIndex));
    chartInstance.current.on("mouseout", () => setHoverIdx(null));
    return () => { window.removeEventListener("resize", onResize); chartInstance.current?.dispose(); };
  }, [theme, filteredKernels]);

  // Round-4 T-1: the "Live" button polls `fetch_live_window` instead
  // of jittering kernel points with RNG.  Each poll takes the average
  // mac_util / dma_bw across the ring and re-scales every kernel's
  // achieved GOPS by `mac_util` (keeps the scatter anchored to the
  // real trace). Empty samples (no trace loaded) restore the static
  // kernel points so the panel never renders invented noise.
  const [liveUtil, setLiveUtil] = useState<number | null>(null);
  useEffect(() => {
    if (!running || !chartInstance.current) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const rows: LiveSample[] = await invoke("fetch_live_window", { windowCycles: 256 });
        if (cancelled) return;
        if (rows.length === 0) { setLiveUtil(null); return; }
        const mac = rows.reduce((a, r) => a + r.mac_util, 0) / rows.length;
        setLiveUtil(mac);
        const pts = filteredKernels.map(k => {
          const ceiling = k.intensity < RIDGE_DDR ? k.intensity * PEAK_DDR_BW : PEAK_TOPS;
          // Scale achieved GOPS by the live MAC utilisation, clamped
          // to the kernel's own ceiling.  Panel still shows per-kernel
          // deltas while being driven by real trace events.
          const perf = Math.min(ceiling * 0.995, k.achieved * Math.max(0.05, mac));
          return { value: [k.intensity, perf],
                   name: k.name,
                   itemStyle: { color: KIND_COLOR[k.kind] },
                   label: { show: true, formatter: k.name, color: theme.text, fontSize: 9, position: "top" as const } };
        });
        chartInstance.current?.setOption({ series: [{}, {}, {}, { data: pts }] });
      } catch {
        if (!cancelled) setLiveUtil(null);
      }
    };
    poll();
    const id = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(id); };
  }, [running, filteredKernels, theme.text]);

  const totals = useMemo(() => {
    const avgUtil = filteredKernels.reduce((a, k) => {
      const ceiling = k.intensity < RIDGE_DDR ? k.intensity * PEAK_DDR_BW : PEAK_TOPS;
      return a + (k.achieved / ceiling);
    }, 0) / Math.max(1, filteredKernels.length) * 100;
    const memBound = filteredKernels.filter(k => k.intensity < RIDGE_DDR).length;
    const cpuBound = filteredKernels.length - memBound;
    return { avgUtil, memBound, cpuBound };
  }, [filteredKernels]);

  return (
    <div className="w-full h-full flex flex-col" style={{ background: theme.bgPanel }}>
      <div className="flex items-center px-4 h-10 shrink-0" style={{ borderBottom: `1px solid ${theme.border}`, background: theme.bgSurface }}>
        <ActivitySquare size={16} className="mr-2" style={{ color: theme.warning }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Roofline Analyser — pccx v002 · KV260</span>
        <span style={{ fontSize: 10, color: theme.textMuted, marginLeft: 12 }}>
          peak compute <b style={{ color: theme.text }}>{PEAK_TOPS} GOPS</b>
          &nbsp;· DDR4 <b style={{ color: theme.text }}>{PEAK_DDR_BW} GB/s</b>
          &nbsp;· URAM L2 <b style={{ color: theme.text }}>{PEAK_URAM_BW} GB/s</b>
          &nbsp;· ridge@DDR <b style={{ color: theme.text }}>{RIDGE_DDR.toFixed(0)}</b>
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1 mr-3">
          {(["all", "gemm", "gemv", "sfu", "dma", "mem"] as const).map(k => (
            <button key={k} onClick={() => setSelectedKind(k)}
              style={{
                padding: "3px 9px", fontSize: 10, borderRadius: 3,
                background: selectedKind === k ? theme.accentBg : "transparent",
                color: selectedKind === k ? theme.accent : theme.textMuted,
                border: `1px solid ${selectedKind === k ? theme.accent : theme.border}`,
                fontWeight: selectedKind === k ? 700 : 500, cursor: "pointer",
              }}>{k}</button>
          ))}
        </div>
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
          onClick={() => setRunning(!running)}
          className="flex items-center gap-2 px-3 py-1 rounded text-xs font-semibold transition-all"
          style={{ background: running ? theme.error : theme.success, color: "#fff" }}
        >
          <Zap size={12}/> {running ? "Stop" : "Live"}
        </button>
      </div>

      <div className="flex-1 grid" style={{ gridTemplateColumns: "1fr 320px", minHeight: 0 }}>
        <div className="relative p-3" style={{ minHeight: 0 }}>
          <div ref={chartRef} className="w-full h-full"
            style={{ border: `1px solid ${theme.border}`, borderRadius: 6, background: theme.bg }} />
        </div>

        <div className="flex flex-col" style={{ borderLeft: `1px solid ${theme.border}`, background: theme.bg, minHeight: 0 }}>
          <div className="shrink-0 p-3" style={{ borderBottom: `1px solid ${theme.border}` }}>
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

          <div className="flex-1 overflow-auto">
            <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse", fontFamily: "ui-monospace, monospace" }}>
              <thead style={{ position: "sticky", top: 0, background: theme.bgSurface }}>
                <tr style={{ borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
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
                               borderBottom: `1px solid ${theme.borderDim}`,
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

          <div className="shrink-0 p-3" style={{ borderTop: `1px solid ${theme.border}`, fontSize: 10, color: theme.textMuted }}>
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
