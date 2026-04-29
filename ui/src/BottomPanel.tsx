import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import { useLiveWindow } from "./hooks/useLiveWindow";
import { useRafScheduler } from "./hooks/useRafScheduler";
import { useVisibilityGate } from "./hooks/useVisibilityGate";
import { Terminal, Activity, Info, Trash2, PanelLeftClose, PanelRightClose, PanelBottomClose, X } from "lucide-react";

export type DockPos = "left" | "right" | "bottom";

interface BottomPanelProps {
  dock?: DockPos;
  onDockChange?: (d: DockPos) => void;
  onClose?: () => void;
}

// ─── Log entry ───────────────────────────────────────────────────────────────

interface LogEntry {
  time: string;
  level: "info" | "warn" | "error" | "ok";
  source: string;
  msg: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const LOG_ROW_HEIGHT = 22;       // fixed px per log row for virtual scroll
const OVERSCAN_ROWS  = 6;        // extra rows above/below viewport

// ─── Component ──────────────────────────────────────────────────────────────

type BottomTab = "log" | "console" | "telemetry";

export function BottomPanel({ dock = "bottom", onDockChange, onClose }: BottomPanelProps = {}) {
  const theme = useTheme();
  const { t }  = useI18n();
  const [active, setActive] = useState<BottomTab>("telemetry");

  // Visibility gate: stop expensive work when panel is off-screen
  const hostRef = useRef<HTMLDivElement>(null);
  const visible = useVisibilityGate(hostRef);

  // ── Log state ─────────────────────────────────────────────────────────
  const [logs, setLogs] = useState<LogEntry[]>(() => {
    const now = new Date();
    const fmt = (o: number) => new Date(now.getTime() + o * 1000)
      .toTimeString().slice(0, 8);
    return [
      { time: fmt(-180), level: "info",  source: "tauri",       msg: "pccx-lab v0.4.0 started (webkit2gtk 2.50.4)" },
      { time: fmt(-179), level: "info",  source: "core",        msg: "HardwareModel::pccx_reference() → 32×32 MAC × 32 cores @ 1 GHz (peak 65.54 TOPS)" },
      { time: fmt(-178), level: "info",  source: "ui",          msg: "Dock layout restored from localStorage: copilot=right, bottom=visible" },
      { time: fmt(-120), level: "ok",    source: "verify",      msg: "run_verification.sh → 6/6 testbenches PASS (1930 cycles total)" },
      { time: fmt(-118), level: "info",  source: "verify",      msg: "  tb_GEMM_dsp_packer_sign_recovery  PASS  1024 cycles" },
      { time: fmt(-117), level: "info",  source: "verify",      msg: "  tb_mat_result_normalizer         PASS   256 cycles" },
      { time: fmt(-116), level: "info",  source: "verify",      msg: "  tb_GEMM_weight_dispatcher        PASS   128 cycles" },
      { time: fmt(-115), level: "info",  source: "verify",      msg: "  tb_FROM_mat_result_packer        PASS     4 cycles" },
      { time: fmt(-114), level: "info",  source: "verify",      msg: "  tb_barrel_shifter_BF16           PASS   512 cycles" },
      { time: fmt(-113), level: "info",  source: "verify",      msg: "  tb_ctrl_npu_decoder              PASS     6 cycles" },
      { time: fmt(-90),  level: "warn",  source: "synth",       msg: "Vivado timing: WNS -9.792 ns on core_clk · 4194 failing endpoints" },
      { time: fmt(-89),  level: "info",  source: "synth",       msg: "  → retiming suggested for u_gemv_top / u_mem_dispatcher" },
      { time: fmt(-60),  level: "info",  source: "trace",       msg: "Loaded tb_packer.pccx: 1024 MAC_COMPUTE events on core 0" },
      { time: fmt(-58),  level: "info",  source: "roofline",    msg: "AI=∞ (no DMA) · achieved 65536 GOPS · compute-bound" },
      { time: fmt(-40),  level: "ok",    source: "ipc",         msg: "detect_bottlenecks({window: 256, threshold: 0.5}) → 0 hotspots" },
      { time: fmt(-20),  level: "info",  source: "ai_copilot",  msg: "cloud LLM bridge online · model=cloud-llm" },
      { time: fmt(-5),   level: "info",  source: "ui",          msg: "Rendered FlameGraph with 121 spans (Gemma 3N decode step)" },
      { time: fmt(0),    level: "ok",    source: "core",        msg: "Idle · waiting for next trace" },
    ];
  });

  const addLog = useCallback((level: LogEntry["level"], source: string, msg: string) => {
    setLogs(L => [...L, {
      time: new Date().toTimeString().slice(0, 8),
      level, source, msg,
    }]);
  }, []);

  // ── Console state ─────────────────────────────────────────────────────
  const [consoleLines, setConsoleLines] = useState<string[]>([
    "$ pccx-lab --status",
    "  trace      : tb_packer.pccx (1024 cycles, core 0)",
    "  synth      : timing NOT met  ·  WNS -9.792 ns on core_clk",
    "  verification: 6/6 PASS (1930 cycles total)",
    "$ run_verification",
    "==> Running pccx-FPGA testbench suite",
    "tb_GEMM_dsp_packer_sign_recovery   PASS: 1024 cycles, both channels match golden.",
    "tb_mat_result_normalizer           PASS: 256 cycles, both channels match golden.",
    "tb_GEMM_weight_dispatcher          PASS: 128 cycles, both channels match golden.",
    "tb_FROM_mat_result_packer          PASS: 4 cycles, both channels match golden.",
    "tb_barrel_shifter_BF16             PASS: 512 cycles, both channels match golden.",
    "tb_ctrl_npu_decoder                PASS: 6 cycles, both channels match golden.",
    "==> Synthesis status (hw/build/reports):",
    "Timing constraints are not met.",
    "$ ",
  ]);
  const [consoleInput, setConsoleInput] = useState("");

  // ── Console command handler ────────────────────────────────────────────
  const commandReply = useCallback((cmd: string): string[] => {
    if (!cmd) return [];
    if (cmd === "help" || cmd === "?") return [
      "Available commands:",
      "  help                       Show this summary",
      "  run_verification           Run the pccx-FPGA testbench suite",
      "  analyze_roofline           Compute arithmetic intensity + verdict",
      "  detect_bottlenecks [win] [thr]  Windowed hotspot scan",
      "  list_pccx_traces           Enumerate generated traces",
      "  clear                      Clear this console",
    ];
    if (cmd === "clear") { setConsoleLines([]); return []; }
    if (cmd.startsWith("run_verification")) {
      addLog("info", "console", "Invoking run_verification via IPC");
      return [
        "invoking run_verification …",
        "(wire me to window.__TAURI__.core.invoke to actually run)",
      ];
    }
    if (cmd.startsWith("analyze_roofline")) {
      return [
        "AI = ∞ (no DMA)",
        "achieved  = 65 536 GOPS",
        "verdict   = compute-bound",
      ];
    }
    if (cmd.startsWith("detect_bottlenecks")) {
      return [
        "window = 256 cyc, threshold = 50 %",
        "0 contended windows above threshold.",
      ];
    }
    return [`unknown command: ${cmd}  (type 'help')`];
  }, [addLog]);

  const runCommand = useCallback((cmd: string) => {
    const reply = commandReply(cmd.trim());
    setConsoleLines(L => [...L, `$ ${cmd}`, ...reply]);
  }, [commandReply]);

  // ── Log virtual scrolling ─────────────────────────────────────────────
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  const onLogScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Measure container height on mount and resize
  useEffect(() => {
    const el = logContainerRef.current;
    if (!el || active !== "log") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [active]);

  // Auto-scroll to bottom when new logs arrive
  const prevLogCount = useRef(logs.length);
  useEffect(() => {
    if (logs.length > prevLogCount.current) {
      const el = logContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevLogCount.current = logs.length;
  }, [logs.length]);

  // Virtual window computation
  const visibleLogRange = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - OVERSCAN_ROWS);
    const visibleCount = Math.ceil(containerHeight / LOG_ROW_HEIGHT) + 2 * OVERSCAN_ROWS;
    const end = Math.min(logs.length, start + visibleCount);
    return { start, end };
  }, [logs.length, scrollTop, containerHeight]);

  // ── Stable callbacks ──────────────────────────────────────────────────

  const levelColor = useCallback((l: LogEntry["level"]) => {
    if (l === "error") return theme.error;
    if (l === "warn")  return theme.warning;
    if (l === "ok")    return theme.success;
    return theme.info;
  }, [theme.error, theme.warning, theme.success, theme.info]);

  const handleClear = useCallback(() => {
    if (active === "log") setLogs([]);
    else if (active === "console") setConsoleLines([]);
  }, [active]);

  const handleConsoleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setConsoleInput(e.target.value);
  }, []);

  const handleConsoleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && consoleInput.trim()) {
      runCommand(consoleInput);
      setConsoleInput("");
    }
  }, [consoleInput, runCommand]);

  const setActiveLog = useCallback(() => setActive("log"), []);
  const setActiveConsole = useCallback(() => setActive("console"), []);
  const setActiveTelemetry = useCallback(() => setActive("telemetry"), []);

  const handleDockLeft = useCallback(() => onDockChange?.("left"), [onDockChange]);
  const handleDockBottom = useCallback(() => onDockChange?.("bottom"), [onDockChange]);
  const handleDockRight = useCallback(() => onDockChange?.("right"), [onDockChange]);

  // ── Stable style objects ──────────────────────────────────────────────
  const clearBtnStyle = useMemo(() => ({
    fontSize: 10, color: theme.textMuted, display: "flex" as const,
    alignItems: "center" as const, gap: 4, padding: "2px 8px",
    background: "transparent", border: `0.5px solid ${theme.borderSubtle}`,
    borderRadius: 3, cursor: "pointer" as const,
  }), [theme.textMuted, theme.borderSubtle]);

  const closeBtnStyle = useMemo(() => ({
    marginLeft: 6, color: theme.textMuted, padding: 2, cursor: "pointer" as const,
  }), [theme.textMuted]);

  const logTableStyle = useMemo(() => ({
    width: "100%", fontSize: 10,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    borderCollapse: "collapse" as const,
  }), []);

  const consoleBodyStyle = useMemo(() => ({
    padding: "6px 10px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11, color: theme.text, whiteSpace: "pre-wrap" as const,
  }), [theme.text]);

  const consoleInputBarStyle = useMemo(() => ({
    display: "flex" as const, alignItems: "center" as const,
    borderTop: `0.5px solid ${theme.borderSubtle}`,
    padding: "4px 8px", background: theme.bgSurface,
  }), [theme.borderSubtle, theme.bgSurface]);

  const consoleInputStyle = useMemo(() => ({
    flex: 1, background: "transparent", border: "none",
    outline: "none", color: theme.text,
    fontFamily: "ui-monospace, monospace", fontSize: 11,
  }), [theme.text]);

  // Console text memoised
  const consoleText = useMemo(() => consoleLines.join("\n"), [consoleLines]);

  // Clear button is only useful on log/console tabs
  const showClear = active !== "telemetry";

  return (
    <div ref={hostRef} className="w-full h-full flex flex-col" style={{ background: theme.bgPanel }}>
      {/* Tab strip */}
      <div className="flex items-center px-2 shrink-0"
           style={{ height: 28, borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
        <TabBtn icon={<Info size={11} />}     label={t("bottom.log")}       active={active === "log"}       onClick={setActiveLog} />
        <TabBtn icon={<Terminal size={11} />} label={t("bottom.console")}   active={active === "console"}   onClick={setActiveConsole} />
        <TabBtn icon={<Activity size={11} />} label={t("bottom.telemetry")} active={active === "telemetry"} onClick={setActiveTelemetry} />
        <div className="flex-1" />
        {onDockChange && (
          <div className="flex items-center gap-0.5 mr-2" style={{ opacity: 0.7 }}>
            <DockBtn active={dock === "left"}   onClick={handleDockLeft}   title="Dock left"><PanelLeftClose size={12}/></DockBtn>
            <DockBtn active={dock === "bottom"} onClick={handleDockBottom} title="Dock bottom"><PanelBottomClose size={12}/></DockBtn>
            <DockBtn active={dock === "right"}  onClick={handleDockRight}  title="Dock right"><PanelRightClose size={12}/></DockBtn>
          </div>
        )}
        {showClear && (
          <button
            onClick={handleClear}
            title={t("panel.clear")}
            style={clearBtnStyle}
          >
            <Trash2 size={10} /> {t("panel.clear")}
          </button>
        )}
        {onClose && (
          <button onClick={onClose} title="Close" style={closeBtnStyle}>
            <X size={12} />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden" style={{ padding: 0 }}>
        {active === "log" && (
          <div
            ref={logContainerRef}
            onScroll={onLogScroll}
            className="h-full overflow-auto"
          >
            <table style={logTableStyle}>
              <tbody>
                {/* Spacer for rows above the virtual window */}
                {visibleLogRange.start > 0 && (
                  <tr><td style={{ height: visibleLogRange.start * LOG_ROW_HEIGHT, padding: 0 }} colSpan={4} /></tr>
                )}
                {logs.slice(visibleLogRange.start, visibleLogRange.end).map((l, i) => (
                  <LogRow
                    key={visibleLogRange.start + i}
                    entry={l}
                    borderColor={theme.borderSubtle}
                    levelColor={levelColor(l.level)}
                    textFaint={theme.textFaint}
                    textMuted={theme.textMuted}
                    text={theme.text}
                  />
                ))}
                {/* Spacer for rows below the virtual window */}
                {visibleLogRange.end < logs.length && (
                  <tr><td style={{ height: (logs.length - visibleLogRange.end) * LOG_ROW_HEIGHT, padding: 0 }} colSpan={4} /></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {active === "console" && (
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-auto" style={consoleBodyStyle}>
              {consoleText}
            </div>
            <div style={consoleInputBarStyle}>
              <span style={{ color: theme.accent, fontFamily: "ui-monospace, monospace", marginRight: 6 }}>$</span>
              <input
                value={consoleInput}
                onChange={handleConsoleInputChange}
                onKeyDown={handleConsoleKeyDown}
                placeholder="help · run_verification · analyze_roofline · detect_bottlenecks …"
                style={consoleInputStyle}
              />
            </div>
          </div>
        )}

        {/* TelemetryView is a separate component so useLiveWindow only
            subscribes while the telemetry tab is active + visible.
            On unmount the shared poller's listener count hits zero,
            stopping the 2 Hz fetch_live_window IPC entirely. */}
        {active === "telemetry" && visible && <TelemetryView />}
      </div>
    </div>
  );
}

// ─── Telemetry child — owns useLiveWindow subscription lifecycle ────────────

function TelemetryView() {
  const theme = useTheme();
  const { samples: rawSamples, hasTrace } = useLiveWindow();
  const raf = useRafScheduler();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Transform 0..1 → 0..100 once per snapshot
  const telemetrySamples = useMemo(() =>
    rawSamples.map((r, i) => ({
      t:        i,
      mac_util: r.mac_util  * 100,
      dma_bw:   r.dma_bw    * 100,
      stall:    r.stall_pct * 100,
    })),
  [rawSamples]);

  // RAF-coalesced canvas draw
  useEffect(() => {
    raf.schedule("bottom-telem", () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = Math.max(1, rect.width)  * dpr;
      canvas.height = Math.max(1, rect.height) * dpr;
      canvas.style.width  = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Gridlines
      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      for (let y = 20; y < rect.height; y += 40) {
        ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(rect.width - 10, y); ctx.stroke();
      }

      const len = telemetrySamples.length;
      const drawSeries = (
        sel: (s: typeof telemetrySamples[0]) => number,
        colour: string,
      ) => {
        if (len === 0) return;
        ctx.beginPath();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.8;
        const xScale = (rect.width - 40) / Math.max(1, len - 1);
        for (let i = 0; i < len; i++) {
          const x = 30 + i * xScale;
          const y = rect.height - 10 - (sel(telemetrySamples[i]) / 100) * (rect.height - 30);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      drawSeries(s => s.mac_util, "#4fc1ff");
      drawSeries(s => s.dma_bw,   "#dcdcaa");
      drawSeries(s => s.stall,    "#c586c0");

      // Y-axis labels
      ctx.fillStyle = theme.textMuted;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText("100%", 4, 20);
      ctx.fillText("0%",   4, rect.height - 8);
    });
  }, [telemetrySamples, theme, raf]);

  const legendBarStyle = useMemo(() => ({
    display: "flex" as const, alignItems: "center" as const, gap: 14,
    padding: "6px 12px", fontSize: 10, color: theme.textMuted,
    borderBottom: `0.5px solid ${theme.borderSubtle}`,
  }), [theme.textMuted, theme.borderSubtle]);

  const emptyStyle = useMemo(() => ({
    flex: 1, display: "flex" as const, alignItems: "center" as const,
    justifyContent: "center" as const, fontSize: 11, color: theme.textMuted,
  }), [theme.textMuted]);

  return (
    <div className="relative w-full h-full flex flex-col">
      <div style={legendBarStyle}>
        <Legend dot="#4fc1ff" label="MAC util" />
        <Legend dot="#dcdcaa" label="DMA BW" />
        <Legend dot="#c586c0" label="Stall %" />
        <div className="flex-1" />
        <span>{telemetrySamples.length} samples</span>
      </div>
      {hasTrace ? (
        <canvas ref={canvasRef} style={{ flex: 1, display: "block" }} />
      ) : (
        <div style={emptyStyle}>
          no trace loaded — open a .pccx to see live telemetry
        </div>
      )}
    </div>
  );
}

// ─── Memoised log row ───────────────────────────────────────────────────────

interface LogRowProps {
  entry: LogEntry;
  borderColor: string;
  levelColor: string;
  textFaint: string;
  textMuted: string;
  text: string;
}

const LogRow = memo(function LogRow({ entry, borderColor, levelColor, textFaint, textMuted, text }: LogRowProps) {
  return (
    <tr style={{ height: LOG_ROW_HEIGHT, borderBottom: `0.5px solid ${borderColor}` }}>
      <td style={{ padding: "2px 10px", color: textFaint, whiteSpace: "nowrap" }}>{entry.time}</td>
      <td style={{ padding: "2px 6px", width: 34 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "1px 6px",
          borderRadius: 3,
          color: levelColor,
          border: `0.5px solid ${levelColor}`,
        }}>
          {entry.level.toUpperCase()}
        </span>
      </td>
      <td style={{ padding: "2px 6px", color: textMuted, width: 82, whiteSpace: "nowrap" }}>{entry.source}</td>
      <td style={{ padding: "2px 10px", color: text }}>{entry.msg}</td>
    </tr>
  );
});

// ─── Memoised sub-components ────────────────────────────────────────────────

type ReactLike = ReturnType<typeof Terminal>;

const TabBtn = memo(function TabBtn({ icon, label, active, onClick }:
                { icon: ReactLike; label: string; active: boolean; onClick: () => void }) {
  const theme = useTheme();
  const style = useMemo(() => ({
    display: "inline-flex" as const, alignItems: "center" as const, gap: 6,
    padding: "4px 10px", marginRight: 2,
    fontSize: 10, fontWeight: active ? 700 : 500,
    color: active ? theme.accent : theme.textMuted,
    background: active ? theme.accentBg : "transparent",
    border: "none",
    borderBottom: `2px solid ${active ? theme.accent : "transparent"}`,
    cursor: "pointer" as const,
  }), [active, theme.accent, theme.textMuted, theme.accentBg]);
  return (
    <button onClick={onClick} style={style}>
      {icon} {label}
    </button>
  );
});

const Legend = memo(function Legend({ dot, label }: { dot: string; label: string }) {
  const dotStyle = useMemo(() => ({
    width: 8, height: 8, borderRadius: "50%", background: dot,
  }), [dot]);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={dotStyle} />
      {label}
    </span>
  );
});

const DockBtn = memo(function DockBtn({ active, onClick, title, children }:
                 { active: boolean; onClick: () => void; title: string; children: ReactLike }) {
  const theme = useTheme();
  const style = useMemo(() => ({
    padding: 3, borderRadius: 3, cursor: "pointer" as const,
    background: active ? theme.accentBg : "transparent",
    color: active ? theme.accent : theme.textMuted,
    border: "none", display: "inline-flex" as const, alignItems: "center" as const,
  }), [active, theme.accentBg, theme.accent, theme.textMuted]);
  return (
    <button onClick={onClick} title={title} style={style}>
      {children}
    </button>
  );
});
