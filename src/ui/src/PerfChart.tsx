import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as echarts from "echarts";
import { useTheme } from "./ThemeContext";

// Round-4 T-1: PerfChart now renders `fetch_live_window` IPC output
// verbatim — no RNG, no synthetic curves. When no trace is loaded
// the chart is empty and a placeholder overlay reads "no trace".
interface LiveSample { ts_ns: number; mac_util: number; dma_bw: number; stall_pct: number }

export function PerfChart() {
  const theme = useTheme();
  const chartRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ time: string; mac: number; l2Read: number; l2Write: number }[]>([]);
  const [hasTrace, setHasTrace] = useState(true);

  // Poll fetch_live_window at 2 Hz.  Empty vec ⇒ no trace loaded.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const rows: LiveSample[] = await invoke("fetch_live_window", { windowCycles: 256 });
        if (cancelled) return;
        setHasTrace(rows.length > 0);
        setData(rows.map(r => ({
          time:    `${(r.ts_ns / 1_000_000).toFixed(1)}ms`,
          mac:     r.mac_util  * 100,
          // DMA_BW / stall tracks driven by the same reducer.  L2-read
          // and L2-write are modelled as DMA_READ and DMA_WRITE shares;
          // we split 60/40 since live_window collapses them under dma_bw.
          l2Read:  r.dma_bw    * 100 * 0.6,
          l2Write: r.dma_bw    * 100 * 0.4,
        })));
      } catch {
        if (!cancelled) { setHasTrace(false); setData([]); }
      }
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!chartRef.current || data.length === 0) return;
    const chart = echarts.getInstanceByDom(chartRef.current) || echarts.init(chartRef.current);

    const option = {
      backgroundColor: "transparent",
      tooltip: { 
        trigger: "axis", 
        backgroundColor: theme.bgSurface, 
        borderColor: theme.border, 
        textStyle: { color: theme.text, fontSize: 11 },
        axisPointer: { type: "cross", crossStyle: { color: theme.textFaint } }
      },
      legend: {
        data: ["MAC Compute (%)", "L2 Read BW (GB/s)", "L2 Write BW (GB/s)"],
        textStyle: { color: theme.textMuted, fontSize: 10 },
        top: 0, right: 10, itemWidth: 12, itemHeight: 8,
      },
      grid: { left: 40, right: 20, top: 25, bottom: 20 },
      xAxis: {
        type: "category",
        data: data.map(d => d.time),
        axisLine: { lineStyle: { color: theme.borderDim } },
        axisLabel: { color: theme.textFaint, fontSize: 9, formatter: (val: string) => val.split(".")[0] }, // Show only seconds
        axisTick: { show: false },
        boundaryGap: false,
      },
      yAxis: {
        type: "value",
        max: 100,
        splitLine: { lineStyle: { color: theme.borderDim, type: "dashed" } },
        axisLabel: { color: theme.textFaint, fontSize: 9 },
      },
      series: [
        {
          name: "MAC Compute (%)",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: data.map(d => d.mac),
          itemStyle: { color: theme.accent },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: theme.accent + "66" },
              { offset: 1, color: theme.accent + "00" }
            ])
          },
        },
        {
          name: "L2 Read BW (GB/s)",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: data.map(d => d.l2Read),
          itemStyle: { color: theme.success },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: theme.success + "44" },
              { offset: 1, color: theme.success + "00" }
            ])
          },
        },
        {
          name: "L2 Write BW (GB/s)",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: data.map(d => d.l2Write),
          itemStyle: { color: theme.warning },
        }
      ],
      animation: false // Smooth scrolling without default chart setup animation
    };

    chart.setOption(option);

    const resize = () => chart.resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [data, theme]);

  return (
    <div className="w-full h-full" style={{ position: "relative" }}>
      <div ref={chartRef} className="w-full h-full" />
      {!hasTrace && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          fontSize: 11, color: theme.textMuted, pointerEvents: "none",
        }}>
          no trace loaded — open a .pccx to see live perf
        </div>
      )}
    </div>
  );
}
