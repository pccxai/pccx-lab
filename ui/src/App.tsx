import { useState, useEffect, useRef } from "react";
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
import { CxPlayground }     from "./CxPlayground";
import { CanvasView }        from "./CanvasView";
import { NodeEditor }        from "./NodeEditor";
import { Timeline }          from "./Timeline";
import { CommandPalette }    from "./CommandPalette";
import { FlameGraph }        from "./FlameGraph";
import { ExtensionManager }  from "./ExtensionManager";
import { CodeEditor }        from "./CodeEditor";
import { ReportBuilder }     from "./ReportBuilder";
import { HardwareVisualizer }from "./HardwareVisualizer";
import { MemoryDump }        from "./MemoryDump";
import { WaveformViewer }    from "./WaveformViewer";
import { VerificationSuite } from "./VerificationSuite";
import { Roofline }          from "./Roofline";
import { BottomPanel }       from "./BottomPanel";
import { ScenarioFlow }      from "./ScenarioFlow";
import { TestbenchAuthor }   from "./TestbenchAuthor";
import { ShortcutHelp, useShortcutHelp } from "./useShortcuts";
import { matchKeybinding } from "./keybindings";

import { Button, Flex, TextField } from "@radix-ui/themes";
import {
  LayoutDashboard, BrainCircuit, Activity,
  Settings2, Zap, Clock,
  Code2, Box, Layers, Cpu, ActivitySquare,
  PanelLeftClose, PanelRightClose, PanelBottomClose, CheckCircle, PieChart,
  FolderTree, Search, Blocks, GitBranch, Terminal
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = "timeline" | "flamegraph" | "hardware" | "memory" | "waves" | "nodes" | "canvas" | "code" | "cx" | "report" | "extensions" | "verify" | "roofline" | "scenario" | "tb_author";

interface ChatMessage { role: "system" | "user" | "ai"; content: string; }

const TABS: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
  { id: "scenario",   label: "Scenario",         icon: <Zap size={12} />             },
  { id: "timeline",   label: "Timeline",         icon: <Clock size={12} />           },
  { id: "flamegraph", label: "Flame Graph",      icon: <Layers size={12} />          },
  { id: "waves",      label: "Waveform",         icon: <ActivitySquare size={12} />  },
  { id: "hardware",   label: "Simulator",        icon: <Cpu size={12} />             },
  { id: "nodes",      label: "Data Flow",        icon: <Activity size={12} />        },
  { id: "code",       label: "Editor",           icon: <Code2 size={12} />           },
  { id: "cx",         label: "CX",              icon: <Terminal size={12} />        },
  { id: "tb_author",  label: "Testbench",        icon: <LayoutDashboard size={12} /> },
  { id: "canvas",     label: "3D View",          icon: <Box size={12} />             },
  { id: "roofline",   label: "Roofline",         icon: <PieChart size={12} />        },
];

// Report, Extensions, Verification, Memory are accessed via the left sidebar Activity Bar

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ResizeHandle({ direction = "horizontal" }: { direction?: "horizontal" | "vertical" }) {
  const theme = useTheme();
  const isDark = theme.mode === "dark";
  return (
    <Separator
      className={`group relative ${direction === "vertical" ? "h-[4px]" : "w-[4px]"} flex items-center justify-center`}
      style={{
        background: "transparent",
        cursor: direction === "vertical" ? "row-resize" : "col-resize",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e: any) => e.currentTarget.style.background = isDark ? "rgba(0,152,255,0.2)" : "rgba(0,102,184,0.15)"}
      onMouseLeave={(e: any) => e.currentTarget.style.background = "transparent"}
    >
      <div
        className="transition-opacity group-hover:opacity-100 opacity-0"
        style={{
          ...(direction === "vertical"
            ? { width: 32, height: 2, borderRadius: 1 }
            : { height: 32, width: 2, borderRadius: 1 }),
          background: theme.accent,
        }}
      />
    </Separator>
  );
}

// ─── Inner App (needs ThemeContext) ────────────────────────────────────────────

function AppInner() {
  const theme = useTheme();
  const { t } = useI18n();
  const isDark = theme.mode === "dark";
  const [header, setHeader]       = useState<any>(null);
  const [license, setLicense]     = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("timeline");
  const [visitedTabs, setVisitedTabs] = useState<Set<ActiveTab>>(() => new Set(["timeline"]));
  const [traceLoaded, setTraceLoaded] = useState(false);
  const [copilotVisible, setCopilotVisible] = useState(true);
  const [copilotDock, setCopilotDock]       = useState<"left" | "right" | "bottom">(() => (localStorage.getItem("pccx-copilot-dock") as any) || "right");
  const [bottomVisible, setBottomVisible]   = useState(true);
  const [bottomDock, setBottomDock]         = useState<"left" | "right" | "bottom">(() => (localStorage.getItem("pccx-bottom-dock") as any) || "bottom");
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "modules" | "extensions" | "verify" | "report" | "memory" | "git">("files");
  const shortcutHelp = useShortcutHelp();

  useEffect(() => {
    setVisitedTabs(prev => {
      if (prev.has(activeTab)) return prev;
      return new Set(prev).add(activeTab);
    });
  }, [activeTab]);

  // Global shortcut dispatcher (VS Code-style keybindings)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        setSidebarVisible(v => !v);
        return;
      }
      const binding = matchKeybinding(e);
      if (!binding) return;
      e.preventDefault();
      handleMenuAction(binding.command);
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

  // Persist dock choices
  useEffect(() => { localStorage.setItem("pccx-copilot-dock", copilotDock); }, [copilotDock]);
  useEffect(() => { localStorage.setItem("pccx-bottom-dock",  bottomDock);  }, [bottomDock]);

  const dockBtn = (active: boolean) => ({
    padding: 3, borderRadius: 3, cursor: "pointer",
    background: active ? theme.accentBg : "transparent",
    color: active ? theme.accent : theme.textMuted,
    border: "none", display: "inline-flex" as const, alignItems: "center" as const,
  });

  // Copilot Panel Component
  const renderCopilot = () => (
      <div className="w-full h-full flex flex-col min-w-0 min-h-0" style={{ background: theme.bgPanel }}>
        <div className="flex items-center px-3 gap-2 shrink-0" style={{ height: 32, borderBottom: `1px solid ${border}` }}>
          <BrainCircuit size={13} style={{ color: theme.accent }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: theme.textDim }}>AI Copilot</span>
          {copilotBusy && <span style={{ fontSize: 9, color: theme.accent }} className="animate-pulse">thinking…</span>}
          <div className="flex-1" />
          <div className="flex gap-0.5 mr-2" style={{ opacity: 0.7 }}>
             <button aria-label="Dock Copilot left"   onClick={() => setCopilotDock("left")}   title="Dock Left"   style={dockBtn(copilotDock === "left")}  ><PanelLeftClose size={12}/></button>
             <button aria-label="Dock Copilot bottom" onClick={() => setCopilotDock("bottom")} title="Dock Bottom" style={dockBtn(copilotDock === "bottom")}><PanelBottomClose size={12}/></button>
             <button aria-label="Dock Copilot right"  onClick={() => setCopilotDock("right")}  title="Dock Right"  style={dockBtn(copilotDock === "right")} ><PanelRightClose size={12}/></button>
          </div>
          <button aria-label="Close Copilot panel" onClick={() => setCopilotVisible(false)} style={{ fontSize: 11, color: theme.textMuted, cursor: "pointer", padding: "2px 4px" }} title="Close">X</button>
        </div>

        <div className="flex px-3 pb-2 pt-2 gap-2 shrink-0" style={{ borderBottom: `1px solid ${border}`, background: theme.bgHover }}>
          <span style={{ fontSize: 10, color: theme.textDim, whiteSpace: "nowrap", paddingTop: 4 }}>OpenAI Token:</span>
          <input 
             type="password" 
             className="flex-1 bg-black/20 border rounded px-2 outline-none text-xs"
             style={{ borderColor: theme.borderDim, color: theme.text }}
             value={apiKey} 
             onChange={e => { setApiKey(e.target.value); localStorage.setItem("pccx_openai_key", e.target.value); }} 
             placeholder="sk-proj-..." 
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2 min-h-0">
          {messages.map((m, i) => (
            <div key={i} style={{
              borderRadius: 8, padding: "8px", fontSize: 11, lineHeight: 1.5,
              wordBreak: "break-word", overflowWrap: "break-word", 
              ...(m.role === "user"
                ? { background: theme.accentBg, border: `1px solid ${theme.accentDim}44`, marginLeft: 16, color: theme.accent }
                : m.role === "ai"
                ? { background: theme.bgSurface, border: `1px solid ${theme.border}`, color: theme.text }
                : { background: "transparent", color: theme.textMuted }),
            }}>
              {m.role === "ai" && <span style={{ color: theme.accent, fontWeight: 600, display: "block", marginBottom: 2 }}>AI:</span>}
              {m.role === "system" && <span style={{ color: theme.textMuted, fontWeight: 600, display: "block", marginBottom: 2 }}>System:</span>}
              {m.content}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        <div className="p-2 shrink-0" style={{ borderTop: `1px solid ${border}` }}>
          <Flex gap="1">
            <TextField.Root placeholder={t("placeholder.ask")} className="flex-1" size="1"
              value={inputText} onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown} />
            <Button size="1" color="purple" variant="solid"
              disabled={copilotBusy || !inputText.trim()} onClick={handleSend}>→</Button>
          </Flex>
          <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 3 }}>
            {t("copilot.kbdHint")}
          </div>
        </div>
      </div>
  );

  // AI Chat.  Seed with an i18n key instead of a literal so the idle line
  // renders in whatever language is active when the component mounts.
  const [messages, setMessages]   = useState<ChatMessage[]>([
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
        // Resolve the bundled dummy trace via Tauri 2.0's path API so
        // it works regardless of the binary's CWD (fixes Round-3 Gap 5:
        // the prior relative path resolved three levels up from the
        // dev binary and never hit the real file, so the UI silently
        // fell back to the Gemma literal flame graph).
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

  // Menu actions
  const handleMenuAction = async (action: string) => {
    const win = getCurrentWindow();
    const tabMap: Record<string, ActiveTab> = {
      "view.canvas": "canvas", "view.nodes": "nodes", "view.timeline": "timeline",
      "view.extensions": "extensions", "view.code": "code", "view.report": "report",
      "view.flamegraph": "flamegraph", "view.hardware": "hardware", "view.memory": "memory",
      "view.waves": "waves", "verify.isa": "verify", "verify.api": "verify", "verify.uvm": "verify", "verify.regression": "verify",
      "analysis.roofline": "roofline",
    };
    if (tabMap[action]) { setActiveTab(tabMap[action]); return; }
    switch (action) {
      case "view.copilot": setCopilotVisible(v => !v); break;
      case "view.bottom":  setBottomVisible(v => !v); break;
      case "view.sidebar": setSidebarVisible(v => !v); break;
      case "command.palette": setCmdPaletteOpen(true); break;
      case "ui.escape": setCmdPaletteOpen(false); shortcutHelp.setOpen(false); break;
      case "view.fullscreen": win.setFullscreen(true); break;
      case "win.minimize": win.minimize(); break;
      case "win.maximize": win.toggleMaximize(); break;
      case "win.close":    win.close(); break;
      case "trace.benchmark": await handleTestIPC(); break;
      case "analysis.pdf": setActiveTab("report"); break;
      case "tools.extensions": setActiveTab("extensions"); break;
      case "tools.uvm": setActiveTab("code"); break;
      case "tools.vcd":
        addMsg("system", "[Export VCD] Attempting .pccx → IEEE 1364 VCD conversion via pccx_core::vcd_writer...");
        try {
          const path: string = await invoke("export_vcd", { outputPath: "pccx_trace.vcd" });
          addMsg("system", `Wrote ${path}. Ready for GTKWave / Surfer / Verdi.`);
        } catch (e) {
          addMsg("system", `Export failed: ${e}. (Load a .pccx file first; vcd_writer needs a cached trace.)`);
        }
        break;
      case "tools.chromeTrace":
        addMsg("system", "[Export Chrome Trace] Serializing to JSON via pccx_core::chrome_trace...");
        try {
          const path: string = await invoke("export_chrome_trace", { outputPath: "trace.json" });
          addMsg("system", `Wrote ${path}. Open chrome://tracing to view.`);
        } catch (e) {
          addMsg("system", `Export failed: ${e}. (chrome_trace writer may not be wired yet.)`);
        }
        break;
      case "file.openVcd": {
        // Switch to Waveform tab first so the panel mounts and listens
        // for the open event; then trigger the native file picker.
        setActiveTab("waves");
        // `undefined` payload tells WaveformViewer to open its own dialog.
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
            if (data.choices && data.choices[0]) {
               addMsg("ai", data.choices[0].message.content);
            } else {
               addMsg("system", `${t("copilot.apiError")}: ${data.error?.message || "Unknown error"}`);
            }
         } catch (err: any) {
            addMsg("system", `${t("copilot.httpError")}: ${err.message}`);
         }
      }
    } catch (e) { addMsg("ai", `${t("copilot.error")}: ${e}`); }
    finally { setCopilotBusy(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const TraceLoadingSkeleton = () => (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, width: "100%", height: "100%" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div className="skeleton" style={{ width: 80, height: 20 }} />
        <div className="skeleton" style={{ width: 60, height: 20 }} />
        <div className="skeleton" style={{ width: 120, height: 20 }} />
        <div style={{ flex: 1 }} />
        <div className="skeleton" style={{ width: 200, height: 20 }} />
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="skeleton" style={{ width: 56, height: 18 }} />
          <div className="skeleton" style={{ flex: 1, height: 18 }} />
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", gap: 12 }}>
        <div className="skeleton" style={{ width: 120, height: 60 }} />
        <div className="skeleton" style={{ width: 120, height: 60 }} />
        <div className="skeleton" style={{ width: 120, height: 60 }} />
      </div>
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

  const bg      = theme.bg;
  const panelBg = theme.bgPanel;
  const border  = theme.border;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none" style={{ background: bg, color: theme.text }}>
      <CommandPalette open={cmdPaletteOpen} setOpen={setCmdPaletteOpen} onAction={handleMenuAction} />
      <ShortcutHelp open={shortcutHelp.open} onClose={() => shortcutHelp.setOpen(false)} />
      
      {/* Unified Toolbar (Xcode-style) */}
      <TitleBar
        subtitle={header?.trace?.cycles ? `${header.trace.cycles.toLocaleString()} cycles` : undefined}
        onAction={handleMenuAction}
      >
        <MenuBar onAction={handleMenuAction} />
      </TitleBar>

      {/* Main */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Activity Bar (VS Code / Xcode Navigator style) */}
        <div className="flex flex-col items-center shrink-0 py-2 gap-1" style={{
          width: 40,
          background: theme.bgPanel,
          borderRight: `0.5px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}`,
        }}>
          {([
            { id: "files" as const, icon: <FolderTree size={17} />, label: "Explorer" },
            { id: "search" as const, icon: <Search size={17} />, label: "Search" },
            { id: "modules" as const, icon: <Blocks size={17} />, label: "Modules" },
            { id: "git" as const, icon: <GitBranch size={17} />, label: "Source Control" },
            { id: "verify" as const, icon: <CheckCircle size={17} />, label: "Verification" },
            { id: "extensions" as const, icon: <Settings2 size={17} />, label: "Extensions" },
          ]).map(item => {
            const isActive = sidebarVisible && sidebarTab === item.id;
            return (
              <button key={item.id} title={item.label}
                onClick={() => {
                  if (sidebarTab === item.id) setSidebarVisible(v => !v);
                  else { setSidebarTab(item.id); setSidebarVisible(true); }
                }}
                className="transition-all"
                style={{
                  padding: 7, borderRadius: 8, cursor: "pointer", border: "none",
                  background: isActive ? (isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)") : "transparent",
                  color: isActive ? theme.accent : theme.textMuted,
                }}>
                {item.icon}
              </button>
            );
          })}
        </div>

        {/* Left Sidebar Panel */}
        {sidebarVisible && (
          <div className="flex flex-col shrink-0" style={{
            width: 240,
            background: theme.bgPanel,
            borderRight: `0.5px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}`,
          }}>
            <div className="flex items-center px-3 shrink-0" style={{
              height: 30,
              borderBottom: `0.5px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}`,
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: theme.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>
                {{ files: "Explorer", search: "Search", modules: "Modules", git: "Source Control", verify: "Verification", extensions: "Extensions", report: "Report", memory: "Memory" }[sidebarTab]}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {sidebarTab === "files" && (
                <FileTree root={""} onFileOpen={handleSidebarFileOpen} />
              )}
              {sidebarTab === "search" && (
                <div className="p-3">
                  <input placeholder="Search files..." className="w-full px-2 py-1 rounded text-xs outline-none"
                    style={{ background: theme.bgInput, color: theme.text, border: `0.5px solid ${theme.border}` }} />
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
                  <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `0.5px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}` }}>
                    <GitBranch size={13} color={theme.accent} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: theme.text }}>main</span>
                  </div>
                  <div className="px-3 py-2">
                    <textarea placeholder="Commit message..." rows={3} className="w-full rounded px-2 py-1 text-xs outline-none resize-none"
                      style={{ background: theme.bgInput, color: theme.text, border: `0.5px solid ${theme.border}`, fontFamily: theme.fontMono }} />
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
              {sidebarTab === "report" && <ReportBuilder />}
              {sidebarTab === "memory" && <MemoryDump />}
            </div>
          </div>
        )}

        {/* Center + Right layout */}
        {(() => {
          const copilotLeft    = copilotVisible && copilotDock === "left";
          const copilotRight   = copilotVisible && copilotDock === "right";
          const copilotBottom  = copilotVisible && copilotDock === "bottom";
          const bottomLeft     = bottomVisible && bottomDock === "left";
          const bottomRight    = bottomVisible && bottomDock === "right";
          const bottomBottom   = bottomVisible && bottomDock === "bottom";
          const hasLeft        = copilotLeft || bottomLeft;
          const hasRight       = copilotRight || bottomRight;
          const hasBottomStack = copilotBottom || bottomBottom;
          return (
          <Group orientation="horizontal" className="flex-1">
            {hasLeft && (
              <>
                <Panel defaultSize="24%" minSize="240px" maxSize="70%">
                   <Group orientation="vertical">
                     {copilotLeft && (
                       <Panel defaultSize={bottomLeft ? "60%" : "100%"} minSize="20%">
                         {renderCopilot()}
                       </Panel>
                     )}
                     {copilotLeft && bottomLeft && <ResizeHandle direction="vertical" />}
                     {bottomLeft && (
                       <Panel defaultSize={copilotLeft ? "40%" : "100%"} minSize="20%">
                         <BottomPanel dock={bottomDock} onDockChange={setBottomDock} onClose={() => setBottomVisible(false)} />
                       </Panel>
                     )}
                   </Group>
                </Panel>
                <ResizeHandle />
              </>
            )}
            <Panel defaultSize={hasLeft && hasRight ? "52%" : (hasLeft || hasRight ? "76%" : "100%")} minSize="25%">
              <Group orientation="vertical">
                <Panel defaultSize={hasBottomStack ? "68%" : "100%"} minSize="20%">
                  <div className="w-full h-full flex flex-col min-w-0 min-h-0" style={{ background: bg }}>
                    <div className="flex items-center shrink-0 px-1.5" style={{
                      height: 36,
                      borderBottom: `0.5px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}`,
                      background: panelBg,
                      overflow: "hidden",
                    }}>
                      <div className="flex items-center gap-px py-1 px-1" style={{
                        background: isDark ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.018)",
                        borderRadius: 9,
                        border: `0.5px solid ${isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)"}`,
                      }}>
                        {TABS.map(t => {
                          const isActive = activeTab === t.id;
                          return (
                            <button key={t.id} onClick={() => setActiveTab(t.id)}
                              title={t.label}
                              className="flex items-center gap-1.5 shrink-0"
                              style={{
                                fontSize: 11, fontWeight: isActive ? 600 : 400,
                                color: isActive ? theme.text : theme.textFaint,
                                padding: isActive ? "5px 12px" : "5px 8px",
                                borderRadius: 8,
                                background: isActive
                                  ? (isDark ? "rgba(255,255,255,0.1)" : "#ffffff")
                                  : "transparent",
                                boxShadow: isActive
                                  ? (isDark ? "0 1px 4px rgba(0,0,0,0.25), 0 0.5px 1px rgba(0,0,0,0.15)" : "0 1px 4px rgba(0,0,0,0.08), 0 0.5px 1px rgba(0,0,0,0.04)")
                                  : "none",
                                transition: "all 0.2s cubic-bezier(0.25, 0.1, 0.25, 1)",
                                cursor: "pointer",
                                border: "none",
                                letterSpacing: -0.2,
                              }}>
                              {t.icon}
                              {isActive && <span>{t.label}</span>}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex-1" />
                      <div className="flex items-center gap-1 pr-1">
                        {traceLoaded
                          ? <span style={{ fontSize: 9, color: theme.success, padding: "2px 7px", borderRadius: 10, background: isDark ? "rgba(78,200,107,0.08)" : "rgba(56,138,52,0.05)", fontWeight: 500 }}>loaded</span>
                          : <span style={{ fontSize: 9, color: theme.textFaint, padding: "2px 7px", borderRadius: 10, background: isDark ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.02)", fontWeight: 500 }}>no trace</span>}
                      </div>
                    </div>
                    <div className="flex-1 overflow-hidden relative">
                      {TABS.map(tab => (
                        <div
                          key={tab.id}
                          style={{
                            display: activeTab === tab.id ? 'flex' : 'none',
                            flexDirection: 'column',
                            width: '100%',
                            height: '100%',
                          }}
                        >
                          {visitedTabs.has(tab.id) ? renderTabContent(tab.id) : <TraceLoadingSkeleton />}
                        </div>
                      ))}
                    </div>
                  </div>
                </Panel>

                {hasBottomStack && (
                  <>
                    <ResizeHandle direction="vertical" />
                    <Panel defaultSize="32%" minSize="10%" maxSize="70%">
                       <Group orientation="horizontal">
                          {bottomBottom && (
                            <Panel defaultSize={copilotBottom ? "60%" : "100%"} minSize="20%">
                              <BottomPanel dock={bottomDock} onDockChange={setBottomDock} onClose={() => setBottomVisible(false)} />
                            </Panel>
                          )}
                          {bottomBottom && copilotBottom && <ResizeHandle />}
                          {copilotBottom && (
                            <Panel defaultSize={bottomBottom ? "40%" : "100%"} minSize="20%">
                              {renderCopilot()}
                            </Panel>
                          )}
                       </Group>
                    </Panel>
                  </>
                )}
              </Group>
            </Panel>
            {hasRight && (
              <>
                <ResizeHandle />
                <Panel defaultSize="24%" minSize="240px" maxSize="70%">
                  <Group orientation="vertical">
                    {copilotRight && (
                      <Panel defaultSize={bottomRight ? "60%" : "100%"} minSize="20%">
                        {renderCopilot()}
                      </Panel>
                    )}
                    {copilotRight && bottomRight && <ResizeHandle direction="vertical" />}
                    {bottomRight && (
                      <Panel defaultSize={copilotRight ? "40%" : "100%"} minSize="20%">
                        <BottomPanel dock={bottomDock} onDockChange={setBottomDock} onClose={() => setBottomVisible(false)} />
                      </Panel>
                    )}
                  </Group>
                </Panel>
              </>
            )}
          </Group>
          );
        })()}

        {/* Activity Bar (refined) */}
        <aside role="toolbar" aria-label="Activity bar" aria-orientation="vertical" style={{
          width: 40,
          background: theme.bgPanel,
          borderLeft: `0.5px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)"}`,
          display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: 10, gap: 4, zIndex: 10,
        }}>
          <button aria-label="Toggle AI Copilot panel" onClick={() => setCopilotVisible(v => !v)} title="AI Copilot"
            className="transition-all" style={{
              padding: 7, borderRadius: 8, cursor: "pointer",
              background: copilotVisible ? (isDark ? "rgba(0,152,255,0.12)" : "rgba(0,102,184,0.08)") : "transparent",
            }}>
            <BrainCircuit size={17} color={copilotVisible ? theme.accent : theme.textMuted} />
          </button>
          <button aria-label="Toggle live telemetry panel" onClick={() => setBottomVisible(v => !v)} title="Live Telemetry"
            className="transition-all" style={{
              padding: 7, borderRadius: 8, cursor: "pointer",
              background: bottomVisible ? (isDark ? "rgba(78,200,107,0.12)" : "rgba(56,138,52,0.08)") : "transparent",
            }}>
            <Activity size={17} color={bottomVisible ? theme.success : theme.textMuted} />
          </button>
        </aside>
      </div>

      {/* Status Bar */}
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
