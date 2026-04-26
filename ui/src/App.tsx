import { useState, useEffect, useRef, Suspense, lazy } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveResource } from "@tauri-apps/api/path";
import { Group, Panel, Separator } from "react-resizable-panels";

import { ThemeProvider, useTheme } from "./ThemeContext";
import { I18nProvider, useI18n } from "./i18n";
import { TitleBar }          from "./TitleBar";
import { MenuBar }           from "./MenuBar";
import { StatusBar }         from "./StatusBar";
import FileTree              from "./FileTree";
import { CommandPalette }    from "./CommandPalette";
import { ExtensionManager }  from "./ExtensionManager";
import { CodeEditor }        from "./CodeEditor";
import { VerificationSuite } from "./VerificationSuite";
import { BottomPanel }       from "./BottomPanel";
import { ShortcutHelp, useShortcutHelp } from "./useShortcuts";
import { matchKeybinding } from "./keybindings";

const CxPlayground      = lazy(() => import("./CxPlayground").then(m => ({ default: m.CxPlayground })));
const CanvasView         = lazy(() => import("./CanvasView").then(m => ({ default: m.CanvasView })));
const NodeEditor         = lazy(() => import("./NodeEditor").then(m => ({ default: m.NodeEditor })));
const Timeline           = lazy(() => import("./Timeline").then(m => ({ default: m.Timeline })));
const FlameGraph         = lazy(() => import("./FlameGraph").then(m => ({ default: m.FlameGraph })));
const ReportBuilder      = lazy(() => import("./ReportBuilder").then(m => ({ default: m.ReportBuilder })));
const HardwareVisualizer = lazy(() => import("./HardwareVisualizer").then(m => ({ default: m.HardwareVisualizer })));
const MemoryDump         = lazy(() => import("./MemoryDump").then(m => ({ default: m.MemoryDump })));
const WaveformViewer     = lazy(() => import("./WaveformViewer").then(m => ({ default: m.WaveformViewer })));
const Roofline           = lazy(() => import("./Roofline").then(m => ({ default: m.Roofline })));
const ScenarioFlow       = lazy(() => import("./ScenarioFlow").then(m => ({ default: m.ScenarioFlow })));
const TestbenchAuthor    = lazy(() => import("./TestbenchAuthor").then(m => ({ default: m.TestbenchAuthor })));

import { Button, Flex, TextField } from "@radix-ui/themes";
import {
  LayoutDashboard, BrainCircuit, Activity,
  Settings2, Zap, Clock,
  Code2, Box, Layers, Cpu, ActivitySquare, PieChart,
  FolderTree, Search, Blocks, GitBranch, Terminal,
  BarChart3, Radio, X, FileText, Database,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = "timeline" | "flamegraph" | "hardware" | "memory" | "waves" | "nodes" | "canvas" | "code" | "cx" | "report" | "extensions" | "verify" | "roofline" | "scenario" | "tb_author";
type SidebarTab = "files" | "search" | "modules" | "extensions" | "verify" | "git";
type InspectorTab = "copilot" | "stats" | "telemetry";

interface ChatMessage { role: "system" | "user" | "ai"; content: string; }

const TABS: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
  { id: "scenario",   label: "Scenario",    icon: <Zap size={12} />            },
  { id: "timeline",   label: "Timeline",    icon: <Clock size={12} />          },
  { id: "flamegraph", label: "Flame Graph", icon: <Layers size={12} />         },
  { id: "waves",      label: "Waveform",    icon: <ActivitySquare size={12} /> },
  { id: "hardware",   label: "Simulator",   icon: <Cpu size={12} />            },
  { id: "nodes",      label: "Data Flow",   icon: <Activity size={12} />       },
  { id: "code",       label: "Editor",      icon: <Code2 size={12} />          },
  { id: "cx",         label: "CX",          icon: <Terminal size={12} />       },
  { id: "tb_author",  label: "Testbench",   icon: <LayoutDashboard size={12} />},
  { id: "canvas",     label: "3D View",     icon: <Box size={12} />            },
  { id: "roofline",   label: "Roofline",    icon: <PieChart size={12} />       },
  { id: "report",    label: "Report",      icon: <FileText size={12} />       },
  { id: "memory",    label: "Memory",      icon: <Database size={12} />       },
];

const SIDEBAR_ITEMS: { id: SidebarTab; icon: React.ReactNode; label: string }[] = [
  { id: "files",      icon: <FolderTree size={17} />,  label: "Explorer" },
  { id: "search",     icon: <Search size={17} />,      label: "Search" },
  { id: "modules",    icon: <Blocks size={17} />,      label: "Modules" },
  { id: "git",        icon: <GitBranch size={17} />,   label: "Source Control" },
  { id: "verify",     icon: <Settings2 size={17} />,   label: "Verification" },
  { id: "extensions", icon: <Settings2 size={17} />,   label: "Extensions" },
];

const INSPECTOR_TABS: { id: InspectorTab; icon: React.ReactNode; label: string }[] = [
  { id: "copilot",   icon: <BrainCircuit size={13} />, label: "Copilot" },
  { id: "stats",     icon: <BarChart3 size={13} />,    label: "Stats" },
  { id: "telemetry", icon: <Radio size={13} />,        label: "Telemetry" },
];

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ResizeHandle({ direction = "horizontal" }: { direction?: "horizontal" | "vertical" }) {
  const theme = useTheme();
  return (
    <Separator
      className={`group relative ${direction === "vertical" ? "h-[3px]" : "w-[3px]"} flex items-center justify-center`}
      style={{
        background: "transparent",
        cursor: direction === "vertical" ? "row-resize" : "col-resize",
      }}
      onMouseEnter={(e: any) => e.currentTarget.style.background = theme.accentBg}
      onMouseLeave={(e: any) => e.currentTarget.style.background = "transparent"}
    />
  );
}

// ─── Inner App ────────────────────────────────────────────────────────────────

function AppInner() {
  const theme = useTheme();
  const { t } = useI18n();
  const [header, setHeader]       = useState<any>(null);
  const [license, setLicense]     = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("timeline");
  const [visitedTabs, setVisitedTabs] = useState<Set<ActiveTab>>(() => new Set(["timeline"]));
  const [traceLoaded, setTraceLoaded] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files");
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("copilot");
  const [bottomVisible, setBottomVisible] = useState(true);
  const shortcutHelp = useShortcutHelp();

  useEffect(() => {
    setVisitedTabs(prev => {
      if (prev.has(activeTab)) return prev;
      return new Set(prev).add(activeTab);
    });
  }, [activeTab]);

  const handleMenuActionRef = useRef<(action: string) => void>(() => {});

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      const binding = matchKeybinding(e);
      if (!binding) return;
      e.preventDefault();
      handleMenuActionRef.current(binding.command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSidebarFileOpen = (_path: string, _name: string) => {
    setActiveTab("code");
    if ((CodeEditor as any).openFile) {
      (CodeEditor as any).openFile(_path, _name);
    }
  };

  // ── AI Chat ──────────────────────────────────────────────────────────────

  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "system", content: t("copilot.idle") },
  ]);
  const [inputText, setInputText] = useState("");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("pccx_openai_key") || "");
  const [copilotBusy, setCopilotBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const addMsg = (role: ChatMessage["role"], content: string) =>
    setMessages(p => [...p, { role, content }]);

  useEffect(() => {
    (async () => {
      try {
        const bundled = await resolveResource("dummy_trace.pccx");
        const res = await invoke("load_pccx", { path: bundled });
        setHeader(res); setTraceLoaded(true);
        const lic: string = await invoke("get_license_info");
        setLicense(lic);
        const ctx: string = await invoke("compress_trace_context");
        addMsg("system", `[OK] ${t("copilot.traceLoaded")} ${ctx}`);
      } catch (e) {
        addMsg("system", `[WARN] ${t("copilot.traceFailed")}: ${e}`);
      }
    })();
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // ── Menu Actions ─────────────────────────────────────────────────────────

  const handleMenuAction = async (action: string) => {
    const win = getCurrentWindow();
    const tabMap: Record<string, ActiveTab> = {
      "view.canvas": "canvas", "view.nodes": "nodes", "view.timeline": "timeline",
      "view.code": "code", "view.scenario": "scenario", "view.tb_author": "tb_author",
      "view.flamegraph": "flamegraph", "view.hardware": "hardware",
      "view.waves": "waves", "view.cx": "cx",
      "analysis.roofline": "roofline",
    };
    if (tabMap[action]) { setActiveTab(tabMap[action]); return; }
    const sidebarMap: Record<string, SidebarTab> = {
      "view.extensions": "extensions", "view.verify": "verify",
      "verify.isa": "verify", "verify.api": "verify", "verify.uvm": "verify", "verify.regression": "verify",
    };
    if (sidebarMap[action]) { setSidebarTab(sidebarMap[action]); setSidebarVisible(true); return; }
    switch (action) {
      case "view.copilot": setInspectorVisible(v => !v); break;
      case "view.bottom":  setBottomVisible(v => !v); break;
      case "view.sidebar": setSidebarVisible(v => !v); break;
      case "command.palette": setCmdPaletteOpen(true); break;
      case "ui.escape": setCmdPaletteOpen(false); shortcutHelp.setOpen(false); break;
      case "view.fullscreen": win.setFullscreen(true); break;
      case "win.minimize": win.minimize(); break;
      case "win.maximize": win.toggleMaximize(); break;
      case "win.close":    win.close(); break;
      case "trace.benchmark": await handleTestIPC(); break;
      case "view.report":
      case "analysis.pdf": setActiveTab("report"); break;
      case "view.memory": setActiveTab("memory"); break;
      case "tools.extensions": setSidebarTab("extensions"); setSidebarVisible(true); break;
      case "tools.uvm": setActiveTab("code"); break;
      case "tools.vcd":
        addMsg("system", "[Export VCD] Converting .pccx to IEEE 1364 VCD...");
        try {
          const path: string = await invoke("export_vcd", { outputPath: "pccx_trace.vcd" });
          addMsg("system", `Wrote ${path}`);
        } catch (e) { addMsg("system", `Export failed: ${e}`); }
        break;
      case "tools.chromeTrace":
        addMsg("system", "[Export Chrome Trace] Serializing...");
        try {
          const path: string = await invoke("export_chrome_trace", { outputPath: "trace.json" });
          addMsg("system", `Wrote ${path}`);
        } catch (e) { addMsg("system", `Export failed: ${e}`); }
        break;
      case "file.openVcd": {
        setActiveTab("waves");
        await emit("pccx://open-vcd", undefined);
        break;
      }
      case "file.exit": win.close(); break;
      case "help.about":
        addMsg("system", "pccx-lab v0.4.0 — NPU Architecture Profiler\nLicense: Apache 2.0\nModules: core · ui · ai_copilot · uvm_bridge");
        break;
      case "help.shortcuts": shortcutHelp.setOpen(true); break;
      default: addMsg("system", `[${action}] — Coming soon`);
    }
  };
  handleMenuActionRef.current = handleMenuAction;

  const handleTestIPC = async () => {
    const t0 = performance.now();
    try {
      const payload: Uint8Array = await invoke("fetch_trace_payload");
      const dt = performance.now() - t0;
      const count = payload.byteLength / 24;
      addMsg("system", `[FAST] IPC: ${(payload.byteLength / 1024 / 1024).toFixed(2)} MB (${count.toLocaleString()} events) — ${dt.toFixed(1)} ms`);
    } catch (e) { addMsg("system", `${t("copilot.ipcError")}: ${e}`); }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || copilotBusy) return;
    setInputText(""); addMsg("user", text);
    setCopilotBusy(true);
    try {
      let ctx = "";
      if (traceLoaded) { try { ctx = await invoke("compress_trace_context"); } catch {} }
      if (!apiKey) {
        const low = text.toLowerCase();
        let reply = "";
        if (low.includes("병목") || low.includes("bottleneck")) {
          reply = `${t("copilot.context")}: ${ctx}\n\n${t("copilot.bottleneck")}`;
        } else if (low.includes("uvm") || low.includes("testbench") || low.includes("코드")) {
          try {
            const s = low.includes("barrier") ? "barrier_reduction" : "l2_prefetch";
            const sv: string = await invoke("generate_uvm_sequence_cmd", { strategy: s });
            reply = `${t("copilot.uvmIntro")} (${s}):\n\n\`\`\`\n${sv}\n\`\`\`\n\n${t("copilot.uvmHint")}`;
          } catch { reply = t("copilot.uvmFailed"); }
        } else if (low.includes("report") || low.includes("보고서")) {
          reply = t("copilot.reportHint");
          setActiveTab("report");
        } else {
          reply = `${t("copilot.context")}: ${ctx || t("copilot.none")}\n\n${t("copilot.hintExamples")}`;
        }
        addMsg("ai", `${reply}\n${t("copilot.hintApiKey")}`);
      } else {
        try {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: "You are the AI Copilot for pccx-lab EDA profiler. You assist with SystemVerilog, UVM, and NPU bottleneck analysis. Output context: " + ctx },
                ...messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "ai" ? "assistant" : "user", content: m.content })),
                { role: "user", content: text }
              ]
            })
          });
          const data = await res.json();
          if (data.choices?.[0]) addMsg("ai", data.choices[0].message.content);
          else addMsg("system", `${t("copilot.apiError")}: ${data.error?.message || "Unknown error"}`);
        } catch (err: any) { addMsg("system", `${t("copilot.httpError")}: ${err.message}`); }
      }
    } catch (e) { addMsg("ai", `${t("copilot.error")}: ${e}`); }
    finally { setCopilotBusy(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // ── Tab Content ──────────────────────────────────────────────────────────

  const TraceLoadingSkeleton = () => (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, width: "100%", height: "100%" }}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="skeleton" style={{ width: 56, height: 18 }} />
          <div className="skeleton" style={{ flex: 1, height: 18 }} />
        </div>
      ))}
    </div>
  );

  function renderTabContent(id: ActiveTab) {
    switch (id) {
      case "timeline":   return <Timeline />;
      case "flamegraph": return <FlameGraph />;
      case "hardware":   return <HardwareVisualizer />;
      case "memory":     return <MemoryDump />;
      case "waves":      return <WaveformViewer />;
      case "nodes":      return <NodeEditor />;
      case "canvas":     return <CanvasView />;
      case "code":       return <CodeEditor />;
      case "cx":         return <CxPlayground />;
      case "report":     return <ReportBuilder />;
      case "extensions": return <ExtensionManager />;
      case "verify":     return <VerificationSuite />;
      case "roofline":   return <Roofline />;
      case "scenario":   return <ScenarioFlow />;
      case "tb_author":  return <TestbenchAuthor />;
    }
  }

  // ── Inspector Panel Renderers ────────────────────────────────────────────

  const renderCopilotContent = () => (
    <div className="w-full h-full flex flex-col min-w-0 min-h-0">
      <div className="flex px-3 pb-2 pt-2 gap-2 shrink-0" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
        <span style={{ fontSize: 10, color: theme.textMuted, whiteSpace: "nowrap", paddingTop: 4 }}>API Key:</span>
        <input
          type="password"
          className="flex-1 rounded px-2 outline-none text-xs"
          style={{ background: theme.bgInput, borderColor: theme.borderDim, color: theme.text, border: `0.5px solid ${theme.borderDim}` }}
          value={apiKey}
          onChange={e => { setApiKey(e.target.value); localStorage.setItem("pccx_openai_key", e.target.value); }}
          placeholder="sk-proj-..."
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5 min-h-0">
        {messages.map((m, i) => (
          <div key={i} style={{
            borderRadius: 6, padding: 6, fontSize: 11, lineHeight: 1.5,
            wordBreak: "break-word", overflowWrap: "break-word",
            ...(m.role === "user"
              ? { background: theme.accentBg, marginLeft: 16, color: theme.text }
              : m.role === "ai"
              ? { background: theme.bgSurface, color: theme.text }
              : { background: "transparent", color: theme.textMuted, fontSize: 10 }),
          }}>
            {m.role === "ai" && <span style={{ color: theme.accent, fontWeight: 600, fontSize: 10, display: "block", marginBottom: 2 }}>AI</span>}
            {m.content}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <div className="p-2 shrink-0" style={{ borderTop: `0.5px solid ${theme.borderSubtle}` }}>
        <Flex gap="1">
          <TextField.Root placeholder={t("placeholder.ask")} className="flex-1" size="1"
            value={inputText} onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown} />
          <Button size="1" color="blue" variant="soft"
            disabled={copilotBusy || !inputText.trim()} onClick={handleSend}>Send</Button>
        </Flex>
      </div>
    </div>
  );

  const renderStatsContent = () => (
    <div className="p-3 flex flex-col gap-3" style={{ fontSize: 11 }}>
      <div style={{ color: theme.textMuted, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Trace Summary</div>
      {header?.trace ? (
        <div className="flex flex-col gap-2">
          {([
            ["Cycles", header.trace.cycles?.toLocaleString()],
            ["Cores", header.trace.cores],
            ["Events", header.trace.events?.toLocaleString()],
            ["Peak MAC Util", header.trace.peak_mac_util ? `${(header.trace.peak_mac_util * 100).toFixed(1)}%` : "—"],
            ["Avg DMA BW", header.trace.avg_dma_bw ? `${(header.trace.avg_dma_bw * 100).toFixed(1)}%` : "—"],
          ] as [string, any][]).map(([label, val]) => (
            <div key={label} className="flex justify-between" style={{ padding: "4px 0", borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
              <span style={{ color: theme.textMuted }}>{label}</span>
              <span style={{ color: theme.text, fontFamily: theme.fontMono }}>{val ?? "—"}</span>
            </div>
          ))}
        </div>
      ) : (
        <span style={{ color: theme.textFaint }}>No trace loaded</span>
      )}
      {license && (
        <>
          <div style={{ color: theme.textMuted, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8 }}>License</div>
          <span style={{ color: theme.textFaint, fontSize: 10 }}>{license}</span>
        </>
      )}
    </div>
  );

  const renderTelemetryContent = () => (
    <div className="p-3 flex flex-col gap-3" style={{ fontSize: 11 }}>
      <div style={{ color: theme.textMuted, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Live Telemetry</div>
      <div className="flex flex-col gap-2">
        {([
          ["MAC Utilization", theme.success],
          ["DMA Bandwidth", theme.info],
          ["Stall Rate", theme.warning],
        ] as [string, string][]).map(([label, color]) => (
          <div key={label}>
            <div className="flex justify-between mb-1">
              <span style={{ color: theme.textMuted, fontSize: 10 }}>{label}</span>
              <span style={{ color, fontSize: 10, fontFamily: theme.fontMono }}>—</span>
            </div>
            <div style={{ height: 3, borderRadius: 2, background: theme.bgSurface }}>
              <div style={{ width: "0%", height: "100%", borderRadius: 2, background: color, transition: `width 0.3s ${theme.ease}` }} />
            </div>
          </div>
        ))}
      </div>
      <span style={{ color: theme.textFaint, fontSize: 10, marginTop: 8 }}>Start simulation to see live data</span>
    </div>
  );

  // ── Layout ───────────────────────────────────────────────────────────────

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none" style={{ background: theme.bg, color: theme.text }}>
      <CommandPalette open={cmdPaletteOpen} setOpen={setCmdPaletteOpen} onAction={handleMenuAction} />
      <ShortcutHelp open={shortcutHelp.open} onClose={() => shortcutHelp.setOpen(false)} />

      <TitleBar
        subtitle={header?.trace?.cycles ? `${header.trace.cycles.toLocaleString()} cycles` : undefined}
        onAction={handleMenuAction}
      >
        <MenuBar onAction={handleMenuAction} />
      </TitleBar>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Activity Bar */}
        <div className="flex flex-col items-center shrink-0 py-2 gap-0.5" style={{
          width: 40,
          background: theme.bgPanel,
          borderRight: `0.5px solid ${theme.borderSubtle}`,
        }}>
          {SIDEBAR_ITEMS.map(item => {
            const isActive = sidebarVisible && sidebarTab === item.id;
            return (
              <button key={item.id} title={item.label}
                onClick={() => {
                  if (sidebarTab === item.id) setSidebarVisible(v => !v);
                  else { setSidebarTab(item.id); setSidebarVisible(true); }
                }}
                style={{
                  padding: 7, borderRadius: 6, cursor: "pointer", border: "none",
                  background: isActive ? theme.bgGlassHover : "transparent",
                  color: isActive ? theme.text : theme.textMuted,
                  transition: `all 0.12s ${theme.ease}`,
                }}>
                {item.icon}
              </button>
            );
          })}
        </div>

        <Group orientation="horizontal" className="flex-1">
          {/* Sidebar */}
          {sidebarVisible && (
            <>
              <Panel defaultSize={15} minSize={10}>
                <div className="flex flex-col h-full" style={{
                  background: theme.bgPanel,
                  borderRight: `0.5px solid ${theme.borderSubtle}`,
                }}>
                  <div className="flex items-center px-3 shrink-0" style={{
                    height: 30,
                    borderBottom: `0.5px solid ${theme.borderSubtle}`,
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {SIDEBAR_ITEMS.find(s => s.id === sidebarTab)?.label}
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto min-h-0">
                    {sidebarTab === "files" && <FileTree root="" onFileOpen={handleSidebarFileOpen} />}
                    {sidebarTab === "search" && (
                      <div className="p-3">
                        <input placeholder="Search files..." className="w-full px-2 py-1 rounded text-xs outline-none"
                          style={{ background: theme.bgInput, color: theme.text, border: `0.5px solid ${theme.borderDim}` }} />
                        <p style={{ fontSize: 10, color: theme.textFaint, marginTop: 8 }}>Type to search across project files</p>
                      </div>
                    )}
                    {sidebarTab === "modules" && (
                      <div className="p-3">
                        <p style={{ fontSize: 11, color: theme.textMuted }}>NPU module hierarchy</p>
                        <p style={{ fontSize: 10, color: theme.textFaint, marginTop: 4 }}>Open a project to see modules</p>
                      </div>
                    )}
                    {sidebarTab === "git" && (
                      <div className="flex flex-col h-full">
                        <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
                          <GitBranch size={13} color={theme.accent} />
                          <span style={{ fontSize: 11, fontWeight: 600, color: theme.text }}>main</span>
                        </div>
                        <div className="px-3 py-2">
                          <textarea placeholder="Commit message..." rows={3} className="w-full rounded px-2 py-1 text-xs outline-none resize-none"
                            style={{ background: theme.bgInput, color: theme.text, border: `0.5px solid ${theme.borderDim}`, fontFamily: theme.fontMono }} />
                          <button className="w-full mt-2 py-1.5 rounded text-xs font-medium" style={{ background: theme.accent, color: "#fff", border: "none", cursor: "pointer" }}>
                            Commit
                          </button>
                        </div>
                        <div className="px-3 py-2">
                          <p style={{ fontSize: 10, color: theme.textFaint }}>Open a project folder to see changes</p>
                        </div>
                      </div>
                    )}
                    {sidebarTab === "verify" && <VerificationSuite />}
                    {sidebarTab === "extensions" && <ExtensionManager />}
                  </div>
                </div>
              </Panel>
              <ResizeHandle />
            </>
          )}

          {/* Center panel */}
          <Panel defaultSize={65} minSize={25}>
            <Group orientation="vertical">
              {/* Main content */}
              <Panel defaultSize={bottomVisible ? 70 : 100} minSize={20}>
                <div className="w-full h-full flex flex-col min-w-0 min-h-0" style={{ background: theme.bg }}>
                  {/* Tab bar */}
                  <div className="flex items-center shrink-0 px-1" style={{
                    height: 34,
                    borderBottom: `0.5px solid ${theme.borderSubtle}`,
                    background: theme.bgPanel,
                  }}>
                    <div className="flex items-center gap-px py-1 px-0.5 hide-scrollbar overflow-x-auto" style={{
                      background: theme.bgGlass,
                      borderRadius: 8,
                      border: `0.5px solid ${theme.borderSubtle}`,
                    }}>
                      {TABS.map(tab => {
                        const isActive = activeTab === tab.id;
                        return (
                          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                            title={tab.label}
                            className="flex items-center gap-1.5 shrink-0"
                            style={{
                              fontSize: 11, fontWeight: isActive ? 600 : 400,
                              color: isActive ? theme.text : theme.textFaint,
                              padding: isActive ? "4px 10px" : "4px 7px",
                              borderRadius: 6,
                              background: isActive ? theme.bgGlassHover : "transparent",
                              cursor: "pointer", border: "none",
                              transition: `all 0.15s ${theme.ease}`,
                              letterSpacing: -0.2,
                            }}>
                            {tab.icon}
                            {isActive && <span>{tab.label}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Tab content */}
                  <div className="flex-1 overflow-hidden relative">
                    {TABS.map(tab => (
                      <div key={tab.id} style={{
                        display: activeTab === tab.id ? "flex" : "none",
                        flexDirection: "column", width: "100%", height: "100%",
                      }}>
                        {visitedTabs.has(tab.id) ? (
                          <Suspense fallback={<TraceLoadingSkeleton />}>
                            {renderTabContent(tab.id)}
                          </Suspense>
                        ) : <TraceLoadingSkeleton />}
                      </div>
                    ))}
                  </div>
                </div>
              </Panel>

              {/* Bottom panel */}
              {bottomVisible && (
                <>
                  <ResizeHandle direction="vertical" />
                  <Panel defaultSize={30} minSize={8}>
                    <BottomPanel onClose={() => setBottomVisible(false)} />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>

          {/* Inspector panel (right) */}
          {inspectorVisible && (
            <>
              <ResizeHandle />
              <Panel defaultSize={20} minSize={12}>
                <div className="w-full h-full flex flex-col min-w-0 min-h-0" style={{ background: theme.bgPanel }}>
                  {/* Inspector tab bar */}
                  <div className="flex items-center shrink-0 px-2" style={{
                    height: 30,
                    borderBottom: `0.5px solid ${theme.borderSubtle}`,
                  }}>
                    <div className="flex items-center gap-0.5 flex-1">
                      {INSPECTOR_TABS.map(tab => {
                        const isActive = inspectorTab === tab.id;
                        return (
                          <button key={tab.id} onClick={() => setInspectorTab(tab.id)}
                            className="flex items-center gap-1"
                            style={{
                              fontSize: 10, fontWeight: isActive ? 600 : 400,
                              color: isActive ? theme.text : theme.textMuted,
                              padding: "3px 8px", borderRadius: 5,
                              background: isActive ? theme.bgGlassHover : "transparent",
                              border: "none", cursor: "pointer",
                              transition: `all 0.12s ${theme.ease}`,
                            }}>
                            {tab.icon}
                            <span>{tab.label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <button onClick={() => setInspectorVisible(false)} title="Close"
                      style={{ padding: 3, borderRadius: 4, border: "none", cursor: "pointer", background: "transparent", color: theme.textMuted }}
                      onMouseEnter={e => e.currentTarget.style.color = theme.text}
                      onMouseLeave={e => e.currentTarget.style.color = theme.textMuted}>
                      <X size={12} />
                    </button>
                  </div>

                  {/* Inspector content */}
                  <div className="flex-1 overflow-hidden min-h-0">
                    {inspectorTab === "copilot" && renderCopilotContent()}
                    {inspectorTab === "stats" && renderStatsContent()}
                    {inspectorTab === "telemetry" && renderTelemetryContent()}
                  </div>
                </div>
              </Panel>
            </>
          )}
        </Group>
      </div>

      <StatusBar traceLoaded={traceLoaded} totalCycles={header?.trace?.cycles} numCores={header?.trace?.cores} license={license} activeTab={activeTab} />
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AppInner />
      </I18nProvider>
    </ThemeProvider>
  );
}

export default App;
