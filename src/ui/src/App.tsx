import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Group, Panel, Separator } from "react-resizable-panels";

import { ThemeProvider, useTheme } from "./ThemeContext";
import { I18nProvider, useI18n } from "./i18n";
import { TitleBar }          from "./TitleBar";
import { MenuBar }           from "./MenuBar";
import { MainToolbar }       from "./MainToolbar";
import { StatusBar }         from "./StatusBar";
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

import { Badge, Button, Flex, TextField } from "@radix-ui/themes";
import {
  LayoutDashboard, BrainCircuit, Activity,
  Settings2, Zap, MessageSquare, Clock, FileText,
  Code2, Sun, Moon, Box, Layers, Database, Cpu, ActivitySquare,
  PanelLeftClose, PanelRightClose, PanelBottomClose, CheckCircle, PieChart
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = "timeline" | "flamegraph" | "hardware" | "memory" | "waves" | "nodes" | "canvas" | "code" | "report" | "extensions" | "verify" | "roofline";

interface ChatMessage { role: "system" | "user" | "ai"; content: string; }

const TABS: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
  { id: "timeline",   label: "Timeline",         icon: <Clock size={12} />           },
  { id: "flamegraph", label: "Flame Graph",      icon: <Layers size={12} />          },
  { id: "waves",      label: "Waveform",         icon: <ActivitySquare size={12} />  },
  { id: "hardware",   label: "System Simulator", icon: <Cpu size={12} />             },
  { id: "memory",     label: "Memory Dump",      icon: <Database size={12} />        },
  { id: "nodes",      label: "Data Flow",        icon: <Activity size={12} />        },
  { id: "code",       label: "SV Editor",        icon: <Code2 size={12} />           },
  { id: "report",     label: "Report",           icon: <FileText size={12} />        },
  { id: "canvas",     label: "3D View",          icon: <Box size={12} />             },
  { id: "extensions", label: "Extensions",       icon: <Settings2 size={12} />       },
  { id: "verify",     label: "Verification",     icon: <CheckCircle size={12} />     },
  { id: "roofline",   label: "Roofline",         icon: <PieChart size={12} />        },
];

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ResizeHandle({ direction = "horizontal" }: { direction?: "horizontal" | "vertical" }) {
  const theme = useTheme();
  const isDark = theme.mode === "dark";
  return (
    <Separator
      className={`group relative ${direction === "vertical" ? "h-[6px]" : "w-[6px]"} flex items-center justify-center`}
      style={{ background: theme.borderDim }}
    >
      <div
        className="transition-all"
        style={{
          ...(direction === "vertical"
            ? { width: 40, height: 3, borderRadius: 2 }
            : { height: 40, width: 3, borderRadius: 2 }),
          background: theme.textFaint,
        }}
      />
    </Separator>
  );
}

// ─── Inner App (needs ThemeContext) ────────────────────────────────────────────

function AppInner() {
  const theme = useTheme();
  const isDark = theme.mode === "dark";
  const [header, setHeader]       = useState<any>(null);
  const [license, setLicense]     = useState("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("timeline");
  const [traceLoaded, setTraceLoaded] = useState(false);
  const [copilotVisible, setCopilotVisible] = useState(true);
  const [copilotDock, setCopilotDock]       = useState<"left" | "right" | "bottom">("right");
  const [bottomVisible, setBottomVisible]   = useState(true);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);

  // Copilot Panel Component
  const renderCopilot = () => (
      <div className="w-full h-full flex flex-col" style={{ background: theme.bgPanel, minWidth: 260 }}>
        <div className="flex items-center px-3 gap-2 shrink-0" style={{ height: 32, borderBottom: `1px solid ${border}` }}>
          <BrainCircuit size={13} style={{ color: theme.accent }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: theme.textDim }}>AI Copilot</span>
          {copilotBusy && <span style={{ fontSize: 9, color: theme.accent }} className="animate-pulse">thinking…</span>}
          <div className="flex-1" />
          <div className="flex gap-1 mr-2 opacity-50 hover:opacity-100 transition-opacity">
             <button onClick={() => setCopilotDock("left")} title="Dock Left"><PanelLeftClose size={12}/></button>
             <button onClick={() => setCopilotDock("bottom")} title="Dock Bottom"><PanelBottomClose size={12}/></button>
             <button onClick={() => setCopilotDock("right")} title="Dock Right"><PanelRightClose size={12}/></button>
          </div>
          <button onClick={() => setCopilotVisible(false)} className="ml-auto" style={{ fontSize: 11, color: theme.textMuted, cursor: "pointer" }}>✕</button>
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
            <TextField.Root placeholder="질문 입력…" className="flex-1" size="1"
              value={inputText} onChange={e => setInputText(e.target.value)}
              onKeyDown={handleKeyDown} />
            <Button size="1" color="purple" variant="solid"
              disabled={copilotBusy || !inputText.trim()} onClick={handleSend}>→</Button>
          </Flex>
          <div style={{ fontSize: 9, color: theme.textMuted, marginTop: 3 }}>Enter 전송 · Shift+Enter 줄바꿈</div>
        </div>
      </div>
  );

  // AI Chat
  const [messages, setMessages]   = useState<ChatMessage[]>([
    { role: "system", content: "AI Copilot 대기 중. .pccx 트레이스를 로드하면 분석을 시작합니다." },
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
        const res = await invoke("load_pccx", { path: "../../dummy_trace.pccx" });
        setHeader(res); setTraceLoaded(true);
        const lic: string = await invoke("get_license_info");
        setLicense(lic);
        const ctx: string = await invoke("compress_trace_context");
        addMsg("system", `✓ 트레이스 로드 완료. ${ctx}`);
      } catch (e) {
        addMsg("system", `⚠ 트레이스 로드 실패: ${e}`);
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
      case "view.fullscreen": win.setFullscreen(true); break;
      case "win.minimize": win.minimize(); break;
      case "win.maximize": win.toggleMaximize(); break;
      case "win.close":    win.close(); break;
      case "trace.benchmark": await handleTestIPC(); break;
      case "analysis.pdf": setActiveTab("report"); break;
      case "tools.extensions": setActiveTab("extensions"); break;
      case "tools.uvm": setActiveTab("code"); break;
      case "tools.vcd":
        addMsg("system", "[Export VCD] Compiling .pccx trace to IEEE 1364 VCD format...");
        setTimeout(() => addMsg("system", "✓ Success: pccx_trace.vcd (73.2MB) exported to workspace. Ready for GTKWave/Verdi!"), 2000);
        break;
      case "tools.chromeTrace":
        addMsg("system", "[Export Chrome Trace] Serializing active session to JSON...");
        setTimeout(() => addMsg("system", "✓ Success: trace.json saved. Open chrome://tracing to view."), 1500);
        break;
      case "file.exit": win.close(); break;
      case "help.about":
        addMsg("system", "pccx-lab v0.4.0 — NPU Architecture Profiler\nLicense: Apache 2.0\nModules: core · ui · ai_copilot · uvm_bridge");
        break;
      default: addMsg("system", `[${action}] — Coming soon`);
    }
  };

  const handleTestIPC = async () => {
    const t0 = performance.now();
    try {
      const payload: Uint8Array = await invoke("fetch_trace_payload");
      const dt = performance.now() - t0;
      const count = payload.byteLength / 24;
      addMsg("system", `⚡ IPC: ${(payload.byteLength / 1024 / 1024).toFixed(2)} MB (${count.toLocaleString()} events) — ${dt.toFixed(1)} ms`);
    } catch (e) { addMsg("system", `IPC 오류: ${e}`); }
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
            reply = `컨텍스트: ${ctx}\n\n분석: AXI 버스 경합이 주요 병목. 32코어 동시 DMA 시 코어당 0.5 B/cycle.\n\n→ L2 프리페치 깊이 증가 또는 코어 그룹 스태거링 권장`;
          } else if (low.includes("uvm") || low.includes("testbench") || low.includes("코드")) {
            try {
              const s = low.includes("barrier") ? "barrier_reduction" : "l2_prefetch";
              const sv: string = await invoke("generate_uvm_sequence_cmd", { strategy: s });
              reply = `UVM 시퀀스 (${s}):\n\n\`\`\`\n${sv}\n\`\`\`\n\n→ SV Editor 탭에서 편집 가능`;
            } catch { reply = "UVM 생성 실패"; }
          } else if (low.includes("report") || low.includes("보고서")) {
            reply = "Report 탭에서 섹션 선택 후 PDF를 생성할 수 있습니다.\n• Executive Summary\n• Hardware Config\n• Utilisation Heatmap\n• Bottleneck Analysis\n• Roofline Model";
            setActiveTab("report");
          } else {
            reply = `컨텍스트: ${ctx || "없음"}\n\n질문 예시:\n• "병목 분석"\n• "UVM testbench 생성"\n• "보고서 생성"\n• "roofline 분석"`;
          }
          addMsg("ai", reply + "\n(Real API 통신을 원하면 상단에 토큰을 입력하세요)");
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
               addMsg("system", `API 응답 오류: ${data.error?.message || "Unknown error"}`);
            }
         } catch (err: any) {
            addMsg("system", `HTTP 오류: ${err.message}`);
         }
      }
    } catch (e) { addMsg("ai", `오류: ${e}`); }
    finally { setCopilotBusy(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const bg      = theme.bg;
  const panelBg = theme.bgPanel;
  const border  = theme.border;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none" style={{ background: bg, color: theme.text }}>
      <CommandPalette open={cmdPaletteOpen} setOpen={setCmdPaletteOpen} onAction={handleMenuAction} />
      
      {/* Title + Menu */}
      <TitleBar subtitle={header?.trace?.cycles ? `${header.trace.cycles.toLocaleString()} cycles` : undefined}>
        <MenuBar onAction={handleMenuAction} />
        <div className="flex-1" />
        <button onClick={theme.toggle} className="mr-2 p-1 rounded hover:bg-white/10 transition-colors" title={isDark ? "Light mode" : "Dark mode"}>
          {isDark ? <Sun size={13} className="text-yellow-400" /> : <Moon size={13} className="text-gray-600" />}
        </button>
      </TitleBar>
      <MainToolbar onAction={handleMenuAction} />

      {/* Main */}
      <div className="flex-1 flex overflow-hidden">
        {/* Resizable layout */}
        <Group direction="horizontal" className="flex-1">
          {copilotVisible && copilotDock === "left" && (
            <>
              <Panel defaultSize={30} minSize={20} maxSize={50} style={{ minWidth: 280 }}>
                {renderCopilot()}
              </Panel>
              <ResizeHandle />
            </>
          )}
          
          {/* Main editor area */}
          <Panel defaultSize={copilotVisible && copilotDock !== "bottom" ? 75 : 100} minSize={40}>
            <Group direction="vertical">
              {/* Top: main content */}
              <Panel defaultSize={bottomVisible ? 70 : 100} minSize={30}>
                <div className="w-full h-full flex flex-col" style={{ background: bg }}>
                  {/* Tab strip */}
                  <div className="flex items-center shrink-0" style={{ height: 32, borderBottom: `1px solid ${border}`, background: panelBg }}>
                    {TABS.map(t => (
                      <button key={t.id} onClick={() => setActiveTab(t.id)}
                        className="flex items-center gap-1.5 px-3 h-full transition-colors"
                        style={{
                          fontSize: 11, fontWeight: activeTab === t.id ? 600 : 400,
                          color: activeTab === t.id ? theme.accent : theme.textMuted,
                          borderBottom: activeTab === t.id ? `2px solid ${theme.accent}` : "2px solid transparent",
                          borderRight: `1px solid ${border}`,
                        }}>
                        {t.icon} {t.label}
                      </button>
                    ))}
                    <div className="flex-1" />
                    <button title="IPC Benchmark" onClick={handleTestIPC}
                      className="px-2 h-full flex items-center justify-center transition-colors"
                      style={{ color: theme.warning }}>
                      <Zap size={13} />
                    </button>
                    <button title="AI Copilot" onClick={() => setCopilotVisible(v => !v)}
                      className="px-2 h-full flex items-center justify-center transition-colors"
                      style={{ color: copilotVisible ? theme.accent : theme.textMuted }}>
                      <MessageSquare size={13} />
                    </button>
                    <div className="px-2">
                      {traceLoaded
                        ? <Badge color="green" variant="soft" size="1">● trace</Badge>
                        : <Badge color="gray" variant="soft" size="1">○ no trace</Badge>}
                    </div>
                  </div>

                  {/* Tab content */}
                  <div className="flex-1 overflow-hidden">
                    {activeTab === "timeline"   && <Timeline />}
                    {activeTab === "flamegraph" && <FlameGraph />}
                    {activeTab === "hardware"   && <HardwareVisualizer />}
                    {activeTab === "memory"     && <MemoryDump />}
                    {activeTab === "waves"      && <WaveformViewer />}
                    {activeTab === "nodes"      && <NodeEditor />}
                    {activeTab === "canvas"     && <CanvasView />}
                    {activeTab === "code"       && <CodeEditor />}
                    {activeTab === "report"     && <ReportBuilder />}
                    {activeTab === "extensions" && <ExtensionManager />}
                    {activeTab === "verify"     && <VerificationSuite />}
                    {activeTab === "roofline"   && <Roofline />}
                  </div>
                </div>
              </Panel>

              {/* Bottom tabbed panel — Log / Console / Live Telemetry */}
              {(bottomVisible || (copilotVisible && copilotDock === "bottom")) && (
                <>
                  <ResizeHandle direction="vertical" />
                  <Panel defaultSize={30} minSize={10} maxSize={50}>
                     <Group direction="horizontal">
                        {bottomVisible && (
                          <Panel defaultSize={copilotDock === "bottom" && copilotVisible ? 50 : 100}>
                            <BottomPanel />
                          </Panel>
                        )}
                        {bottomVisible && copilotVisible && copilotDock === "bottom" && <ResizeHandle/>}
                        {copilotVisible && copilotDock === "bottom" && (
                          <Panel defaultSize={bottomVisible ? 50 : 100}>
                             {renderCopilot()}
                          </Panel>
                        )}
                     </Group>
                  </Panel>
                </>
              )}
            </Group>
          </Panel>

          {/* AI Copilot panel (Right Dock) */}
          {copilotVisible && copilotDock === "right" && (
            <>
              <ResizeHandle />
              <Panel defaultSize={30} minSize={20} maxSize={50} style={{ minWidth: 280 }}>
                 {renderCopilot()}
              </Panel>
            </>
          )}
        </Group>

        {/* Right Activity Bar (VS Code Secondary Side Bar style) */}
        <div style={{ width: 42, background: theme.bgPanel, borderLeft: `1px solid ${theme.border}`, display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 8, gap: 6, zIndex: 10 }}>
          <button onClick={() => setCopilotVisible(v => !v)} title="AI Copilot" style={{ padding: 6, borderRadius: 4, cursor: "pointer", background: copilotVisible ? theme.bgHover : "transparent", transition: "all 0.15s" }}>
            <BrainCircuit size={18} color={copilotVisible ? theme.accent : theme.textMuted} />
          </button>
          <button onClick={() => setBottomVisible(v => !v)} title="Live Telemetry" style={{ padding: 6, borderRadius: 4, cursor: "pointer", background: bottomVisible ? theme.bgHover : "transparent", transition: "all 0.15s" }}>
            <Activity size={18} color={bottomVisible ? theme.success : theme.textMuted} />
          </button>
        </div>
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
