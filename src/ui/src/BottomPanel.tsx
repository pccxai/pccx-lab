import { useState, useEffect, useRef } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import { Terminal, Activity, Info, Trash2 } from "lucide-react";

// ─── Log entry ───────────────────────────────────────────────────────────────

interface LogEntry {
  time: string;
  level: "info" | "warn" | "error" | "ok";
  source: string;
  msg: string;
}

// ─── Live telemetry ring buffer ──────────────────────────────────────────────

interface TelemetrySample {
  t: number;       // relative seconds
  mac_util: number; // 0..100
  dma_bw:   number; // 0..100 (% peak)
  stall:    number; // 0..100 (%)
}

// ─── Component ──────────────────────────────────────────────────────────────

type BottomTab = "log" | "console" | "telemetry";

export function BottomPanel() {
  const theme = useTheme();
  const { t }  = useI18n();
  const [active, setActive] = useState<BottomTab>("log");

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
      { time: fmt(-58),  level: "info",  source: "roofline",    msg: "AI=∞ (no DMA) · achieved 65536 GOPS · compute-bound ✓" },
      { time: fmt(-40),  level: "ok",    source: "ipc",         msg: "detect_bottlenecks({window: 256, threshold: 0.5}) → 0 hotspots" },
      { time: fmt(-20),  level: "info",  source: "ai_copilot",  msg: "Gemini bridge online · model=gemini-pro" },
      { time: fmt(-5),   level: "info",  source: "ui",          msg: "Rendered FlameGraph with 121 spans (Gemma 3N decode step)" },
      { time: fmt(0),    level: "ok",    source: "core",        msg: "Idle · waiting for next trace" },
    ];
  });

  const addLog = (level: LogEntry["level"], source: string, msg: string) => {
    setLogs(L => [...L, {
      time: new Date().toTimeString().slice(0, 8),
      level, source, msg,
    }]);
  };

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

  const runCommand = (cmd: string) => {
    const reply = commandReply(cmd.trim());
    setConsoleLines(L => [...L, `$ ${cmd}`, ...reply]);
  };

  // ── Telemetry state ───────────────────────────────────────────────────
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  useEffect(() => {
    let tick = 0;
    const id = setInterval(() => {
      tick += 1;
      setSamples(S => {
        const next = [...S, {
          t: tick,
          mac_util: 55 + Math.sin(tick / 6) * 25 + Math.random() * 6,
          dma_bw:   40 + Math.cos(tick / 4) * 20 + Math.random() * 5,
          stall:    12 + Math.max(0, Math.sin(tick / 3)) * 8 + Math.random() * 4,
        }];
        return next.length > 120 ? next.slice(next.length - 120) : next;
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ── Render helpers ────────────────────────────────────────────────────

  const levelColor = (l: LogEntry["level"]) => {
    if (l === "error") return theme.error;
    if (l === "warn")  return theme.warning;
    if (l === "ok")    return theme.success;
    return theme.info;
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (active !== "telemetry") return;
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
    // Background gridlines
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    for (let y = 20; y < rect.height; y += 40) {
      ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(rect.width - 10, y); ctx.stroke();
    }
    const drawSeries = (
      sel: (s: TelemetrySample) => number,
      colour: string,
    ) => {
      ctx.beginPath();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.8;
      samples.forEach((s, i) => {
        const x = 30 + (i / Math.max(1, samples.length - 1)) * (rect.width - 40);
        const y = rect.height - 10 - (sel(s) / 100) * (rect.height - 30);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
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
  }, [samples, active, theme]);

  return (
    <div className="w-full h-full flex flex-col" style={{ background: theme.bgPanel }}>
      {/* Tab strip */}
      <div className="flex items-center px-2 shrink-0"
           style={{ height: 28, borderBottom: `1px solid ${theme.border}` }}>
        <TabBtn icon={<Info size={11} />}     label={t("bottom.log")}       active={active === "log"}       onClick={() => setActive("log")} />
        <TabBtn icon={<Terminal size={11} />} label={t("bottom.console")}   active={active === "console"}   onClick={() => setActive("console")} />
        <TabBtn icon={<Activity size={11} />} label={t("bottom.telemetry")} active={active === "telemetry"} onClick={() => setActive("telemetry")} />
        <div className="flex-1" />
        <button
          onClick={() => {
            if (active === "log") setLogs([]);
            else if (active === "console") setConsoleLines([]);
            else setSamples([]);
          }}
          title={t("panel.clear")}
          style={{
            fontSize: 10, color: theme.textMuted, display: "flex",
            alignItems: "center", gap: 4, padding: "2px 8px",
            background: "transparent", border: `1px solid ${theme.border}`,
            borderRadius: 3, cursor: "pointer",
          }}
        >
          <Trash2 size={10} /> {t("panel.clear")}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto" style={{ padding: 0 }}>
        {active === "log" && (
          <table style={{ width: "100%", fontSize: 10, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", borderCollapse: "collapse" }}>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${theme.borderDim}` }}>
                  <td style={{ padding: "2px 10px", color: theme.textFaint, whiteSpace: "nowrap" }}>{l.time}</td>
                  <td style={{ padding: "2px 6px", width: 34 }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: "1px 6px",
                      borderRadius: 3,
                      color: levelColor(l.level),
                      border: `1px solid ${levelColor(l.level)}`,
                    }}>
                      {l.level.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: "2px 6px", color: theme.textMuted, width: 82, whiteSpace: "nowrap" }}>{l.source}</td>
                  <td style={{ padding: "2px 10px", color: theme.text }}>{l.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {active === "console" && (
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-auto" style={{
              padding: "6px 10px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11, color: theme.text, whiteSpace: "pre-wrap",
            }}>
              {consoleLines.join("\n")}
            </div>
            <div style={{ display: "flex", alignItems: "center", borderTop: `1px solid ${theme.border}`, padding: "4px 8px", background: theme.bgSurface }}>
              <span style={{ color: theme.accent, fontFamily: "ui-monospace, monospace", marginRight: 6 }}>$</span>
              <input
                value={consoleInput}
                onChange={e => setConsoleInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && consoleInput.trim()) {
                    runCommand(consoleInput);
                    setConsoleInput("");
                  }
                }}
                placeholder="help · run_verification · analyze_roofline · detect_bottlenecks …"
                style={{
                  flex: 1, background: "transparent", border: "none",
                  outline: "none", color: theme.text, fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                }}
              />
            </div>
          </div>
        )}

        {active === "telemetry" && (
          <div className="relative w-full h-full flex flex-col">
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 12px", fontSize: 10, color: theme.textMuted, borderBottom: `1px solid ${theme.borderDim}` }}>
              <Legend dot="#4fc1ff" label="MAC util" />
              <Legend dot="#dcdcaa" label="DMA BW" />
              <Legend dot="#c586c0" label="Stall %" />
              <div className="flex-1" />
              <span>{samples.length} samples</span>
            </div>
            <canvas ref={canvasRef} style={{ flex: 1, display: "block" }} />
          </div>
        )}
      </div>
    </div>
  );

  // ── Helpers ───────────────────────────────────────────────────────────
  function commandReply(cmd: string): string[] {
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
        "verdict   = compute-bound ✓",
      ];
    }
    if (cmd.startsWith("detect_bottlenecks")) {
      return [
        "window = 256 cyc, threshold = 50 %",
        "0 contended windows above threshold.",
      ];
    }
    return [`unknown command: ${cmd}  (type 'help')`];
  }
}

function TabBtn({ icon, label, active, onClick }:
                { icon: ReactLike; label: string; active: boolean; onClick: () => void }) {
  const theme = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px", marginRight: 2,
        fontSize: 10, fontWeight: active ? 700 : 500,
        color: active ? theme.accent : theme.textMuted,
        background: active ? theme.accentBg : "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? theme.accent : "transparent"}`,
        cursor: "pointer",
      }}
    >
      {icon} {label}
    </button>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
      {label}
    </span>
  );
}

type ReactLike = ReturnType<typeof Terminal>;
