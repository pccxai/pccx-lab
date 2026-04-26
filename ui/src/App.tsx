import { useState, useEffect, useRef, Suspense, lazy, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveResource } from "@tauri-apps/api/path";
import { Layout, Model, Actions, DockLocation, TabNode, IJsonModel } from "flexlayout-react";
import type { ITabRenderValues } from "flexlayout-react";

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
const OccupancyCalculator = lazy(() => import("./OccupancyCalculator").then(m => ({ default: m.OccupancyCalculator })));
const MetricTree          = lazy(() => import("./MetricTree").then(m => ({ default: m.MetricTree })));
const PipelineDiagram     = lazy(() => import("./PipelineDiagram").then(m => ({ default: m.PipelineDiagram })));

import { Button, Flex, TextField } from "@radix-ui/themes";
import {
  LayoutDashboard, BrainCircuit, Activity,
  Settings2, Zap, Clock,
  Code2, Box, Layers, Cpu, ActivitySquare, PieChart,
  FolderTree, Search, Blocks, GitBranch, Terminal,
  BarChart3, Radio, X, FileText, Database,
  Maximize2, Minimize2, MoreHorizontal, ExternalLink,
  SplitSquareHorizontal, SplitSquareVertical, XCircle,
  Workflow,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = "timeline" | "flamegraph" | "hardware" | "memory" | "waves" | "nodes" | "canvas" | "code" | "cx" | "report" | "extensions" | "verify" | "roofline" | "scenario" | "tb_author" | "occupancy" | "metric_tree" | "pipeline";
type SidebarTab = "files" | "search" | "modules" | "extensions" | "verify" | "git";
interface ChatMessage { role: "system" | "user" | "ai"; content: string; }

const SIDEBAR_ITEMS: { id: SidebarTab; icon: React.ReactNode; label: string }[] = [
  { id: "files",      icon: <FolderTree size={17} />,  label: "Explorer" },
  { id: "search",     icon: <Search size={17} />,      label: "Search" },
  { id: "modules",    icon: <Blocks size={17} />,      label: "Modules" },
  { id: "git",        icon: <GitBranch size={17} />,   label: "Source Control" },
  { id: "verify",     icon: <Settings2 size={17} />,   label: "Verification" },
  { id: "extensions", icon: <Settings2 size={17} />,   label: "Extensions" },
];

// Inspector tab IDs (border-right panel tabs are defined in the layout model)

// ─── Layout Persistence ──────────────────────────────────────────────────────

const LAYOUT_STORAGE_KEY = "pccx-dock-layout";
const LAYOUT_VERSION = 1;

function saveLayout(model: Model) {
  try {
    const json = model.toJson();
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ version: LAYOUT_VERSION, model: json }));
  } catch { /* quota exceeded or serialization error — silently skip */ }
}

function loadLayout(): IJsonModel | null {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== LAYOUT_VERSION) return null;
    return parsed.model as IJsonModel;
  } catch {
    return null;
  }
}

// ─── Default Layout JSON ─────────────────────────────────────────────────────

const DEFAULT_LAYOUT: IJsonModel = {
  global: {
    tabEnableClose: true,
    tabEnableDrag: true,
    tabEnableRename: false,
    tabEnablePopout: true,
    tabSetEnableMaximize: true,
    tabSetEnableClose: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetMinHeight: 100,
    tabSetMinWidth: 100,
    borderEnableAutoHide: true,
    borderSize: 240,
    borderMinSize: 100,
  },
  borders: [
    {
      type: "border",
      location: "left",
      size: 240,
      selected: 0,
      children: [
        { type: "tab", id: "border-explorer", name: "Explorer", component: "explorer", enableClose: false },
        { type: "tab", id: "border-search", name: "Search", component: "search" },
        { type: "tab", id: "border-modules", name: "Modules", component: "modules" },
        { type: "tab", id: "border-git", name: "Source Control", component: "git" },
        { type: "tab", id: "border-verify", name: "Verification", component: "verify-sidebar" },
        { type: "tab", id: "border-extensions", name: "Extensions", component: "extensions-sidebar" },
      ],
    },
    {
      type: "border",
      location: "right",
      size: 280,
      selected: 0,
      children: [
        { type: "tab", id: "border-copilot", name: "Copilot", component: "copilot", enableClose: false },
        { type: "tab", id: "border-stats", name: "Stats", component: "stats" },
        { type: "tab", id: "border-telemetry", name: "Telemetry", component: "telemetry" },
      ],
    },
    {
      type: "border",
      location: "bottom",
      size: 200,
      selected: 0,
      children: [
        { type: "tab", id: "border-console", name: "Console", component: "bottom-panel", enableClose: false },
      ],
    },
  ],
  layout: {
    type: "row",
    weight: 100,
    children: [
      {
        type: "tabset",
        id: "center-tabset",
        weight: 100,
        active: true,
        children: [
          { type: "tab", id: "timeline",   name: "Timeline",    component: "timeline" },
          { type: "tab", id: "code",       name: "Editor",      component: "code" },
          { type: "tab", id: "waves",      name: "Waveform",    component: "waves" },
          { type: "tab", id: "flamegraph", name: "Flame Graph", component: "flamegraph" },
        ],
      },
    ],
  },
};

// ─── Context Menu ─────────────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  items: { label: string; icon?: React.ReactNode; onClick: () => void; separator?: boolean }[];
  onClose: () => void;
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const theme = useTheme();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div ref={ref} style={{
      position: "fixed", left: x, top: y, zIndex: 10000,
      background: theme.bgSurface, border: `1px solid ${theme.border}`,
      borderRadius: 8, padding: "4px 0", minWidth: 180,
      boxShadow: theme.shadowMd, backdropFilter: "blur(12px)",
    }}>
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && <div style={{ height: 1, background: theme.borderSubtle, margin: "4px 8px" }} />}
          <button
            onClick={() => { item.onClick(); onClose(); }}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "5px 12px", border: "none",
              background: "transparent", color: theme.text, fontSize: 12,
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = theme.bgGlassHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            {item.icon && <span style={{ color: theme.textMuted, display: "flex" }}>{item.icon}</span>}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Inner App ────────────────────────────────────────────────────────────────

function AppInner() {
  const theme = useTheme();
  const { t } = useI18n();
  const [header, setHeader]       = useState<any>(null);
  const [license, setLicense]     = useState("");
  const [traceLoaded, setTraceLoaded] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const shortcutHelp = useShortcutHelp();
  const layoutRef = useRef<any>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  // ── FlexLayout Model ──────────────────────────────────────────────────

  const [model] = useState<Model>(() => {
    const saved = loadLayout();
    try {
      if (saved) return Model.fromJson(saved);
    } catch { /* corrupted layout — fall back to default */ }
    return Model.fromJson(DEFAULT_LAYOUT);
  });

  // Force re-render on model changes (needed for activity bar highlight sync)
  const [, setModelTick] = useState(0);

  useEffect(() => {
    const listener = () => {
      setModelTick(t => t + 1);
      saveLayout(model);
    };
    model.addChangeListener(listener);
    return () => model.removeChangeListener(listener);
  }, [model]);

  const handleModelChange = useCallback(() => {
    saveLayout(model);
  }, [model]);

  // Track active tab for StatusBar
  const [activeTabId, setActiveTabId] = useState<string>("timeline");

  const handleAction = useCallback((action: any) => {
    if (action.type === Actions.SELECT_TAB) {
      setActiveTabId(action.data.tabNode);
    }
    return action;
  }, []);

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
    selectOrAddTab("code", "Editor", "code");
    if ((CodeEditor as any).openFile) {
      (CodeEditor as any).openFile(_path, _name);
    }
  };

  // Ensure a tab is selected; add it if user previously closed it
  const selectOrAddTab = useCallback((tabId: string, name: string, component: string) => {
    const node = model.getNodeById(tabId);
    if (node) {
      model.doAction(Actions.selectTab(tabId));
    } else {
      const tabset = model.getActiveTabset() || model.getFirstTabSet();
      if (tabset) {
        model.doAction(Actions.addTab(
          { type: "tab", id: tabId, name, component },
          tabset.getId(),
          DockLocation.CENTER,
          -1,
          true,
        ));
      }
    }
  }, [model]);

  // Toggle a border panel by selecting its tab or deselecting
  const toggleBorderTab = useCallback((borderTabId: string) => {
    const node = model.getNodeById(borderTabId);
    if (!node) return;
    const parent = node.getParent();
    if (!parent) return;
    const isSelected = (node as TabNode).isSelected();
    if (isSelected) {
      // Deselect = collapse border
      model.doAction(Actions.updateNodeAttributes(parent.getId(), { selected: -1 }));
    } else {
      model.doAction(Actions.selectTab(borderTabId));
    }
  }, [model]);

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

  const TAB_META: Record<string, { name: string; component: string }> = {
    timeline:   { name: "Timeline",    component: "timeline" },
    flamegraph: { name: "Flame Graph", component: "flamegraph" },
    hardware:   { name: "Simulator",   component: "hardware" },
    memory:     { name: "Memory",      component: "memory" },
    waves:      { name: "Waveform",    component: "waves" },
    nodes:      { name: "Data Flow",   component: "nodes" },
    canvas:     { name: "3D View",     component: "canvas" },
    code:       { name: "Editor",      component: "code" },
    cx:         { name: "CX",          component: "cx" },
    report:     { name: "Report",      component: "report" },
    extensions: { name: "Extensions",  component: "extensions" },
    verify:     { name: "Verify",      component: "verify" },
    roofline:   { name: "Roofline",    component: "roofline" },
    scenario:   { name: "Scenario",    component: "scenario" },
    tb_author:  { name: "Testbench",   component: "tb_author" },
    occupancy:  { name: "Occupancy",   component: "occupancy" },
    metric_tree: { name: "Metrics",    component: "metric_tree" },
    pipeline:   { name: "Pipeline",    component: "pipeline" },
  };

  const handleMenuAction = async (action: string) => {
    const win = getCurrentWindow();
    const tabMap: Record<string, ActiveTab> = {
      "view.canvas": "canvas", "view.nodes": "nodes", "view.timeline": "timeline",
      "view.code": "code", "view.scenario": "scenario", "view.tb_author": "tb_author",
      "view.flamegraph": "flamegraph", "view.hardware": "hardware",
      "view.waves": "waves", "view.cx": "cx",
      "analysis.roofline": "roofline",
    };
    if (tabMap[action]) {
      const id = tabMap[action];
      const meta = TAB_META[id];
      if (meta) selectOrAddTab(id, meta.name, meta.component);
      return;
    }

    const sidebarBorderMap: Record<string, string> = {
      "view.extensions":   "border-extensions",
      "view.verify":       "border-verify",
      "verify.isa":        "border-verify",
      "verify.api":        "border-verify",
      "verify.uvm":        "border-verify",
      "verify.regression": "border-verify",
    };
    if (sidebarBorderMap[action]) {
      model.doAction(Actions.selectTab(sidebarBorderMap[action]));
      return;
    }

    switch (action) {
      case "view.copilot": toggleBorderTab("border-copilot"); break;
      case "view.bottom":  toggleBorderTab("border-console"); break;
      case "view.sidebar": toggleBorderTab("border-explorer"); break;
      case "command.palette": setCmdPaletteOpen(true); break;
      case "ui.escape": setCmdPaletteOpen(false); shortcutHelp.setOpen(false); setContextMenu(null); break;
      case "view.fullscreen": win.setFullscreen(true); break;
      case "win.minimize": win.minimize(); break;
      case "win.maximize": win.toggleMaximize(); break;
      case "win.close":    win.close(); break;
      case "trace.benchmark": await handleTestIPC(); break;
      case "view.report":
      case "analysis.pdf": selectOrAddTab("report", "Report", "report"); break;
      case "view.memory": selectOrAddTab("memory", "Memory", "memory"); break;
      case "tools.extensions":
        model.doAction(Actions.selectTab("border-extensions"));
        break;
      case "tools.uvm": selectOrAddTab("code", "Editor", "code"); break;
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
        selectOrAddTab("waves", "Waveform", "waves");
        await emit("pccx://open-vcd", undefined);
        break;
      }
      case "file.exit": win.close(); break;
      case "help.about":
        addMsg("system", "pccx-lab v0.4.0 -- NPU Architecture Profiler\nLicense: Apache 2.0\nModules: core / ui / ai_copilot / uvm_bridge");
        break;
      case "help.shortcuts": shortcutHelp.setOpen(true); break;
      default: addMsg("system", `[${action}] -- Coming soon`);
    }
  };
  handleMenuActionRef.current = handleMenuAction;

  const handleTestIPC = async () => {
    const t0 = performance.now();
    try {
      const payload: Uint8Array = await invoke("fetch_trace_payload");
      const dt = performance.now() - t0;
      const count = payload.byteLength / 24;
      addMsg("system", `[FAST] IPC: ${(payload.byteLength / 1024 / 1024).toFixed(2)} MB (${count.toLocaleString()} events) -- ${dt.toFixed(1)} ms`);
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
          selectOrAddTab("report", "Report", "report");
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

  // ── Loading Skeleton ────────────────────────────────────────────────────

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
            ["Peak MAC Util", header.trace.peak_mac_util ? `${(header.trace.peak_mac_util * 100).toFixed(1)}%` : "--"],
            ["Avg DMA BW", header.trace.avg_dma_bw ? `${(header.trace.avg_dma_bw * 100).toFixed(1)}%` : "--"],
          ] as [string, any][]).map(([label, val]) => (
            <div key={label} className="flex justify-between" style={{ padding: "4px 0", borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
              <span style={{ color: theme.textMuted }}>{label}</span>
              <span style={{ color: theme.text, fontFamily: theme.fontMono }}>{val ?? "--"}</span>
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
              <span style={{ color, fontSize: 10, fontFamily: theme.fontMono }}>--</span>
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

  // ── Factory ─────────────────────────────────────────────────────────────

  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    switch (component) {
      case "timeline":   return <Suspense fallback={<TraceLoadingSkeleton />}><Timeline /></Suspense>;
      case "flamegraph": return <Suspense fallback={<TraceLoadingSkeleton />}><FlameGraph /></Suspense>;
      case "hardware":   return <Suspense fallback={<TraceLoadingSkeleton />}><HardwareVisualizer /></Suspense>;
      case "memory":     return <Suspense fallback={<TraceLoadingSkeleton />}><MemoryDump /></Suspense>;
      case "waves":      return <Suspense fallback={<TraceLoadingSkeleton />}><WaveformViewer /></Suspense>;
      case "nodes":      return <Suspense fallback={<TraceLoadingSkeleton />}><NodeEditor /></Suspense>;
      case "canvas":     return <Suspense fallback={<TraceLoadingSkeleton />}><CanvasView /></Suspense>;
      case "code":       return <Suspense fallback={<TraceLoadingSkeleton />}><CodeEditor /></Suspense>;
      case "cx":         return <Suspense fallback={<TraceLoadingSkeleton />}><CxPlayground /></Suspense>;
      case "report":     return <Suspense fallback={<TraceLoadingSkeleton />}><ReportBuilder /></Suspense>;
      case "extensions": return <Suspense fallback={<TraceLoadingSkeleton />}><ExtensionManager /></Suspense>;
      case "verify":     return <Suspense fallback={<TraceLoadingSkeleton />}><VerificationSuite /></Suspense>;
      case "roofline":   return <Suspense fallback={<TraceLoadingSkeleton />}><Roofline /></Suspense>;
      case "scenario":   return <Suspense fallback={<TraceLoadingSkeleton />}><ScenarioFlow /></Suspense>;
      case "tb_author":  return <Suspense fallback={<TraceLoadingSkeleton />}><TestbenchAuthor /></Suspense>;
      case "occupancy":  return <Suspense fallback={<TraceLoadingSkeleton />}><OccupancyCalculator /></Suspense>;
      case "metric_tree": return <Suspense fallback={<TraceLoadingSkeleton />}><MetricTree /></Suspense>;
      case "pipeline":   return <Suspense fallback={<TraceLoadingSkeleton />}><PipelineDiagram /></Suspense>;

      // Border panels: sidebar content
      case "explorer":
        return <FileTree root="" onFileOpen={handleSidebarFileOpen} />;
      case "search":
        return (
          <div className="p-3">
            <input placeholder="Search files..." className="w-full px-2 py-1 rounded text-xs outline-none"
              style={{ background: theme.bgInput, color: theme.text, border: `0.5px solid ${theme.borderDim}` }} />
            <p style={{ fontSize: 10, color: theme.textFaint, marginTop: 8 }}>Type to search across project files</p>
          </div>
        );
      case "modules":
        return (
          <div className="p-3">
            <p style={{ fontSize: 11, color: theme.textMuted }}>NPU module hierarchy</p>
            <p style={{ fontSize: 10, color: theme.textFaint, marginTop: 4 }}>Open a project to see modules</p>
          </div>
        );
      case "git":
        return (
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
        );
      case "verify-sidebar":
        return <VerificationSuite />;
      case "extensions-sidebar":
        return <ExtensionManager />;

      // Border panels: right inspector
      case "copilot":   return renderCopilotContent();
      case "stats":     return renderStatsContent();
      case "telemetry": return renderTelemetryContent();

      // Border panel: bottom
      case "bottom-panel":
        return <BottomPanel />;

      default:
        return <div style={{ padding: 16, color: theme.textMuted }}>Unknown panel: {component}</div>;
    }
  }, [theme, header, license, messages, inputText, apiKey, copilotBusy, traceLoaded]);

  // ── Tab Rendering ───────────────────────────────────────────────────────

  const tabIconMap: Record<string, React.ReactNode> = useMemo(() => ({
    timeline:   <Clock size={11} />,
    flamegraph: <Layers size={11} />,
    hardware:   <Cpu size={11} />,
    memory:     <Database size={11} />,
    waves:      <ActivitySquare size={11} />,
    nodes:      <Activity size={11} />,
    canvas:     <Box size={11} />,
    code:       <Code2 size={11} />,
    cx:         <Terminal size={11} />,
    report:     <FileText size={11} />,
    extensions: <Settings2 size={11} />,
    verify:     <Settings2 size={11} />,
    roofline:   <PieChart size={11} />,
    scenario:   <Zap size={11} />,
    tb_author:  <LayoutDashboard size={11} />,
    occupancy:  <Cpu size={11} />,
    metric_tree: <BarChart3 size={11} />,
    pipeline:   <Workflow size={11} />,
    explorer:   <FolderTree size={11} />,
    search:     <Search size={11} />,
    modules:    <Blocks size={11} />,
    git:        <GitBranch size={11} />,
    copilot:    <BrainCircuit size={11} />,
    stats:      <BarChart3 size={11} />,
    telemetry:  <Radio size={11} />,
    "bottom-panel": <Terminal size={11} />,
    "verify-sidebar": <Settings2 size={11} />,
    "extensions-sidebar": <Settings2 size={11} />,
  }), []);

  const onRenderTab = useCallback((node: TabNode, renderValues: ITabRenderValues) => {
    const comp = node.getComponent() || "";
    const icon = tabIconMap[comp];
    if (icon) {
      renderValues.leading = <span style={{ display: "flex", alignItems: "center", marginRight: 4 }}>{icon}</span>;
    }
  }, [tabIconMap]);

  // ── Context Menu ────────────────────────────────────────────────────────

  const handleContextMenu = useCallback((node: any, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (node.getType() !== "tab") return;
    const nodeId = node.getId();
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId });
  }, []);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    const nodeId = contextMenu.nodeId;
    const node = model.getNodeById(nodeId);
    if (!node) return [];
    const parent = node.getParent();
    const parentId = parent?.getId();

    const isMaximized = parent && parent.getType() === "tabset" && model.getMaximizedTabset()?.getId() === parentId;

    return [
      {
        label: "Close",
        icon: <X size={13} />,
        onClick: () => model.doAction(Actions.deleteTab(nodeId)),
      },
      {
        label: "Close Others",
        icon: <XCircle size={13} />,
        onClick: () => {
          if (!parent) return;
          const children = parent.getChildren();
          children.forEach((child: any) => {
            if (child.getId() !== nodeId && child.getType() === "tab") {
              model.doAction(Actions.deleteTab(child.getId()));
            }
          });
        },
      },
      ...(parentId ? [{
        label: isMaximized ? "Restore" : "Maximize",
        icon: isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />,
        separator: true,
        onClick: () => model.doAction(Actions.maximizeToggle(parentId)),
      }] : []),
      {
        label: "Detach to Window",
        icon: <ExternalLink size={13} />,
        separator: !parentId,
        onClick: () => {
          try {
            model.doAction(Actions.popoutTab(nodeId, "float"));
          } catch {
            // fallback: float type if window type fails in Tauri
          }
        },
      },
      {
        label: "Split Right",
        icon: <SplitSquareHorizontal size={13} />,
        separator: true,
        onClick: () => {
          if (!parentId) return;
          if (node.getType() !== "tab") return;
          model.doAction(Actions.moveNode(nodeId, parentId, DockLocation.RIGHT, -1, true));
        },
      },
      {
        label: "Split Down",
        icon: <SplitSquareVertical size={13} />,
        onClick: () => {
          if (!parentId) return;
          if (node.getType() !== "tab") return;
          model.doAction(Actions.moveNode(nodeId, parentId, DockLocation.BOTTOM, -1, true));
        },
      },
    ];
  }, [contextMenu, model]);

  // ── FlexLayout CSS Overrides (inline style element) ─────────────────────

  const layoutStyles = useMemo(() => `
    .flexlayout__layout {
      --color-text: ${theme.text};
      --color-background: ${theme.bg};
      --color-base: ${theme.bg};
      --color-1: ${theme.bgPanel};
      --color-2: ${theme.bgPanel};
      --color-3: ${theme.bgSurface};
      --color-4: ${theme.border};
      --color-5: ${theme.bgHover};
      --color-6: ${theme.bgHover};
      --color-drag1: ${theme.accent};
      --color-drag2: ${theme.success};
      --color-drag1-background: ${theme.accentBg};
      --color-drag2-background: ${theme.successBg};
      --font-size: 11px;
      --font-family: ${theme.fontSans};
      --font-weight: normal;
      --splitter-size: 3px;
      --splitter-active-size: 5px;
      --splitter-handle-visibility: hidden;
      --color-overflow: ${theme.textMuted};
      --color-icon: ${theme.textMuted};
      --color-tabset-background: ${theme.bgPanel};
      --color-tabset-background-selected: ${theme.bgPanel};
      --color-tabset-background-maximized: ${theme.bgPanel};
      --color-tabset-divider-line: ${theme.borderSubtle};
      --color-border-tab-content: ${theme.bg};
      --color-border-background: ${theme.bgPanel};
      --color-border-divider-line: ${theme.borderSubtle};
      --color-tab-content: ${theme.bg};
      --color-tab-selected: ${theme.text};
      --color-tab-selected-background: ${theme.bgGlassHover};
      --color-tab-unselected: ${theme.textMuted};
      --color-tab-unselected-background: transparent;
      --color-tab-textbox: ${theme.text};
      --color-tab-textbox-background: ${theme.bgInput};
      --color-border-tab-selected: ${theme.text};
      --color-border-tab-selected-background: ${theme.bgGlassHover};
      --color-border-tab-unselected: ${theme.textMuted};
      --color-border-tab-unselected-background: transparent;
      --color-splitter: transparent;
      --color-splitter-hover: ${theme.accent};
      --color-splitter-drag: ${theme.accent};
      --color-splitter-handle: transparent;
      --color-drag-rect-border: ${theme.accent};
      --color-drag-rect-background: ${theme.accentBg};
      --color-drag-rect: ${theme.text};
      --color-popup-border: ${theme.border};
      --color-popup-unselected: ${theme.text};
      --color-popup-unselected-background: ${theme.bgSurface};
      --color-popup-selected: ${theme.text};
      --color-popup-selected-background: ${theme.bgGlassHover};
    }
    .flexlayout__layout {
      background: ${theme.bg};
      font-family: ${theme.fontSans};
    }
    .flexlayout__tab {
      background: ${theme.bg};
      overflow: hidden;
    }
    .flexlayout__tab_button {
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 4px;
      margin: 2px 1px;
    }
    .flexlayout__tab_button--selected {
      background: ${theme.bgGlassHover};
    }
    .flexlayout__tab_button_leading {
      display: flex;
      align-items: center;
    }
    .flexlayout__tab_button_content {
      font-size: 11px;
    }
    .flexlayout__tabset_tabbar_outer {
      background: ${theme.bgPanel};
      border-bottom: 0.5px solid ${theme.borderSubtle};
    }
    .flexlayout__tabset-selected {
      background: ${theme.bg};
    }
    .flexlayout__splitter {
      background: transparent;
      transition: background 0.15s ${theme.ease};
    }
    .flexlayout__splitter:hover,
    .flexlayout__splitter_drag {
      background: ${theme.accent} !important;
    }
    .flexlayout__border {
      background: ${theme.bgPanel};
    }
    .flexlayout__border_button {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      margin: 2px 1px;
    }
    .flexlayout__border_button--selected {
      background: ${theme.bgGlassHover};
      color: ${theme.text};
    }
    .flexlayout__border_button--unselected {
      color: ${theme.textMuted};
    }
    .flexlayout__border_tab_contents {
      background: ${theme.bg};
    }
    .flexlayout__border_inner_tab_container_left,
    .flexlayout__border_inner_tab_container_right,
    .flexlayout__border_inner_tab_container_bottom {
      border-color: ${theme.borderSubtle};
    }
    .flexlayout__border_inner_left,
    .flexlayout__border_inner_right {
      border-right: 0.5px solid ${theme.borderSubtle};
      border-left: 0.5px solid ${theme.borderSubtle};
    }
    .flexlayout__border_inner_bottom {
      border-top: 0.5px solid ${theme.borderSubtle};
    }
    .flexlayout__drag_rect {
      border-radius: 6px;
      font-size: 11px;
    }
    .flexlayout__edge_rect {
      background: ${theme.accentBg};
      border: 1px solid ${theme.accent};
      border-radius: 4px;
    }
    .flexlayout__outline_rect {
      border: 2px solid ${theme.accent};
      border-radius: 4px;
    }
    .flexlayout__popup_menu {
      background: ${theme.bgSurface};
      border: 1px solid ${theme.border};
      border-radius: 8px;
      box-shadow: ${theme.shadowMd};
      padding: 4px 0;
    }
    .flexlayout__popup_menu_item {
      padding: 4px 12px;
      font-size: 12px;
      border-radius: 4px;
      margin: 0 4px;
    }
    .flexlayout__popup_menu_item--selected {
      background: ${theme.bgGlassHover};
    }
    .flexlayout__tab_toolbar_button {
      color: ${theme.textMuted};
      border-radius: 4px;
      padding: 2px;
    }
    .flexlayout__tab_toolbar_button:hover {
      color: ${theme.text};
      background: ${theme.bgGlassHover};
    }
    .flexlayout__tab_toolbar_button-close:hover {
      color: ${theme.error};
    }
    .flexlayout__border_toolbar_button {
      color: ${theme.textMuted};
    }
    .flexlayout__border_toolbar_button:hover {
      color: ${theme.text};
    }
    .flexlayout__float_window {
      background: ${theme.bgPanel};
      border: 1px solid ${theme.border};
      border-radius: 8px;
      box-shadow: ${theme.shadowMd};
    }
    .flexlayout__float_window_header {
      background: ${theme.bgSurface};
      border-bottom: 1px solid ${theme.borderSubtle};
      border-radius: 8px 8px 0 0;
    }
  `, [theme]);

  // ── Activity Bar ────────────────────────────────────────────────────────

  // Map sidebar items to border tab IDs
  const SIDEBAR_BORDER_MAP: Record<SidebarTab, string> = {
    files: "border-explorer",
    search: "border-search",
    modules: "border-modules",
    git: "border-git",
    verify: "border-verify",
    extensions: "border-extensions",
  };

  const isBorderTabSelected = useCallback((borderTabId: string): boolean => {
    const node = model.getNodeById(borderTabId);
    if (!node) return false;
    return (node as TabNode).isSelected();
  }, [model]);

  // ── Layout ───────────────────────────────────────────────────────────────

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden select-none" style={{ background: theme.bg, color: theme.text }}>
      <style>{layoutStyles}</style>
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
            const borderTabId = SIDEBAR_BORDER_MAP[item.id];
            const isActive = isBorderTabSelected(borderTabId);
            return (
              <button key={item.id} title={item.label}
                onClick={() => toggleBorderTab(borderTabId)}
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

        {/* Dock Layout */}
        <div className="flex-1 relative">
          <Layout
            ref={layoutRef}
            model={model}
            factory={factory}
            onModelChange={handleModelChange}
            onAction={handleAction}
            onRenderTab={onRenderTab}
            onContextMenu={handleContextMenu as any}
            realtimeResize={false}
            icons={{
              close: <X size={10} />,
              maximize: <Maximize2 size={10} />,
              restore: <Minimize2 size={10} />,
              more: <MoreHorizontal size={10} />,
              popout: <ExternalLink size={10} />,
            }}
          />
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      <StatusBar traceLoaded={traceLoaded} totalCycles={header?.trace?.cycles} numCores={header?.trace?.cores} license={license} activeTab={activeTabId} />
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
