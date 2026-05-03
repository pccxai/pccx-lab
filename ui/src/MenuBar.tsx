import { useState, useRef, useEffect } from "react";
import { useTheme } from "./ThemeContext";

interface MenuItem { label: string; shortcut?: string; separator?: boolean; disabled?: boolean; action?: () => void; }
interface Menu { label: string; items: MenuItem[]; }
interface MenuBarProps { onAction?: (action: string) => void; }

function buildMenus(act: (a: string) => () => void): Menu[] {
  return [
    { label: "File", items: [
      { label: "New Session",         shortcut: "Ctrl+N",       action: act("file.new") },
      { label: "Open .pccx…",         shortcut: "Ctrl+O",       action: act("file.open") },
      { label: "Open VCD…",           shortcut: "Ctrl+Shift+O", action: act("file.openVcd") },
      { separator: true, label: "" },
      { label: "Save Session",        shortcut: "Ctrl+S",       action: act("file.save") },
      { label: "Save As…",            shortcut: "Ctrl+Shift+S", action: act("file.saveAs") },
      { label: "Export Flat Buffer…",                            action: act("file.exportFlat") },
      { separator: true, label: "" },
      { label: "Generate .pccx Trace",                          action: act("file.generate") },
      { separator: true, label: "" },
      { label: "Exit",                shortcut: "Alt+F4",       action: act("file.exit") },
    ]},
    { label: "Edit", items: [
      { label: "Undo",                shortcut: "Ctrl+Z",       action: act("edit.undo") },
      { label: "Redo",                shortcut: "Ctrl+Y",       action: act("edit.redo") },
      { separator: true, label: "" },
      { label: "Copy",                shortcut: "Ctrl+C",       action: act("edit.copy") },
      { label: "Paste",               shortcut: "Ctrl+V",       action: act("edit.paste") },
      { separator: true, label: "" },
      { label: "Find Event…",         shortcut: "Ctrl+F",       action: act("edit.find") },
      { label: "Go to Cycle…",        shortcut: "Ctrl+G",       action: act("edit.goto") },
      { separator: true, label: "" },
      { label: "Preferences",                                    action: act("edit.preferences") },
    ]},
    { label: "View", items: [
      { label: "Timeline / Waveform", shortcut: "F1",           action: act("view.timeline") },
      { label: "Data Flow Graph",     shortcut: "F2",           action: act("view.nodes") },
      { label: "SV / UVM Editor",     shortcut: "F3",           action: act("view.code") },
      { label: "Report Builder",      shortcut: "F4",           action: act("view.report") },
      { label: "3D MAC Array",        shortcut: "F5",           action: act("view.canvas") },
      { label: "Extension Store",     shortcut: "F6",           action: act("view.extensions") },
      { separator: true, label: "" },
      { label: "Workflow Assistant",  shortcut: "Ctrl+`",       action: act("view.copilot") },
      { label: "Bottom Panel",        shortcut: "Ctrl+J",       action: act("view.bottom") },
      { separator: true, label: "" },
      { label: "Zoom In",             shortcut: "Ctrl+=",       action: act("view.zoomIn") },
      { label: "Zoom Out",            shortcut: "Ctrl+-",       action: act("view.zoomOut") },
      { separator: true, label: "" },
      { label: "Toggle Fullscreen",   shortcut: "F11",          action: act("view.fullscreen") },
    ]},
    { label: "Trace", items: [
      { label: "Load .pccx File…",                              action: act("trace.load") },
      { label: "Generate Demo Trace",                           action: act("trace.generate") },
      { label: "Reload Current",      shortcut: "Ctrl+R",       action: act("trace.reload") },
      { separator: true, label: "" },
      { label: "Validate Integrity",  shortcut: "Ctrl+I",       action: act("trace.validate") },
      { label: "Show Header Info",                              action: act("trace.header") },
      { separator: true, label: "" },
      { label: "Filter by Core…",                               action: act("trace.filterCore") },
      { label: "Filter by Event Type…",                         action: act("trace.filterEvent") },
      { label: "Set Time Range…",                               action: act("trace.timeRange") },
      { separator: true, label: "" },
      { label: "IPC Benchmark",       shortcut: "Ctrl+B",       action: act("trace.benchmark") },
    ]},
    { label: "Analysis", items: [
      { label: "Core Utilisation Report",                       action: act("analysis.utilisation") },
      { label: "DMA Bottleneck Scan",                           action: act("analysis.bottleneck") },
      { label: "Roofline Analysis",                             action: act("analysis.roofline") },
      { label: "Arithmetic Intensity",                          action: act("analysis.ai") },
      { separator: true, label: "" },
      { label: "Compare Two Traces…",                           action: act("analysis.compare"), disabled: true },
      { label: "Regression Analysis…",                          action: act("analysis.regression"), disabled: true },
      { separator: true, label: "" },
      { label: "Export CSV Report",                             action: act("analysis.exportCsv") },
      { label: "Generate PDF Report", shortcut: "Ctrl+P",      action: act("analysis.pdf") },
    ]},
    { label: "Verify", items: [
      { label: "ISA Decoder Dashboard",                          action: act("verify.isa") },
      { label: "API Ping-Pong Matrix",                           action: act("verify.api") },
      { label: "UVM Coverage Visualizer",                        action: act("verify.uvm") },
      { separator: true, label: "" },
      { label: "Run Full Regression Suite", shortcut: "F10",     action: act("verify.regression") },
    ]},
    { label: "Run", items: [
      { label: "Start Simulation",    shortcut: "F5",           action: act("run.start") },
      { label: "Stop Simulation",     shortcut: "F6",           action: act("run.stop") },
      { label: "Pause",               shortcut: "F7",           action: act("run.pause") },
      { separator: true, label: "" },
      { label: "Simulation Config…",                            action: act("run.config") },
      { label: "Set Tile Count…",                               action: act("run.tiles") },
      { label: "Set Core Count…",                               action: act("run.cores") },
    ]},
    { label: "Tools", items: [
      { label: "Extension Manager",                             action: act("tools.extensions") },
      { label: "UVM Sequence Generator",                        action: act("tools.uvm") },
      { label: "License Manager",                               action: act("tools.license") },
      { separator: true, label: "" },
      { label: "VCD Wave Exporter",                             action: act("tools.vcd") },
      { label: "Chrome Trace Export",                           action: act("tools.chromeTrace") },
      { separator: true, label: "" },
      { label: "pccx-cli Terminal",                             action: act("tools.cli") },
      { separator: true, label: "" },
      { label: "Settings",            shortcut: "Ctrl+,",       action: act("tools.settings") },
    ]},
    { label: "Window", items: [
      { label: "Minimize",            shortcut: "Win+↓",        action: act("win.minimize") },
      { label: "Maximize",            shortcut: "Win+↑",        action: act("win.maximize") },
      { label: "Close",               shortcut: "Alt+F4",       action: act("win.close") },
      { separator: true, label: "" },
      { label: "Reset Layout",                                  action: act("win.resetLayout") },
    ]},
    { label: "Help", items: [
      { label: "Documentation",       shortcut: "F1",           action: act("help.docs") },
      { label: "Keyboard Shortcuts",  shortcut: "?",            action: act("help.shortcuts") },
      { label: ".pccx Format Spec",                             action: act("help.format") },
      { label: "DPI-C API Reference",                           action: act("help.dpic") },
      { separator: true, label: "" },
      { label: "Check for Updates…",                            action: act("help.update") },
      { label: "Report Issue…",                                 action: act("help.issue") },
      { separator: true, label: "" },
      { label: "About pccx-lab",                                action: act("help.about") },
    ]},
  ];
}

function Dropdown({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const theme = useTheme();
  return (
    <div role="menu" aria-label={`${menu.label} menu`} className="absolute top-full left-0 z-50 min-w-[230px] py-1 rounded-sm shadow-2xl"
      style={{ background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 8 }}>
      {menu.items.map((item, i) => {
        if (item.separator) return <div key={i} role="separator" className="my-1" style={{ borderTop: `0.5px solid ${theme.borderSubtle}` }} />;
        return (
          <button key={i} role="menuitem" aria-label={item.label} aria-disabled={item.disabled} disabled={item.disabled} onClick={() => { item.action?.(); onClose(); }}
            style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 16px", fontSize: 11,
              color: item.disabled ? theme.textFaint : theme.text, cursor: item.disabled ? "not-allowed" : "pointer",
              background: "transparent", border: "none" }}
            onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = theme.bgHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
            <span>{item.label}</span>
            {item.shortcut && <span style={{ marginLeft: 24, fontSize: 10, color: theme.textFaint, fontFamily: theme.fontMono }}>{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MenuBar({ onAction }: MenuBarProps) {
  const theme = useTheme();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const act = (a: string) => () => onAction?.(a);
  const menus = buildMenus(act);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenMenu(null); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onEsc); };
  }, []);

  return (
    <div ref={barRef} role="menubar" aria-label="Application menu" className="flex items-center" style={{ pointerEvents: "all" }}>
      {menus.map(m => (
        <div key={m.label} className="relative">
          <button
            role="menuitem"
            aria-label={`${m.label} menu`}
            aria-haspopup="menu"
            aria-expanded={openMenu === m.label}
            onClick={() => setOpenMenu(openMenu === m.label ? null : m.label)}
            onMouseEnter={() => { if (openMenu) setOpenMenu(m.label); }}
            style={{
              padding: "0 12px", height: 36, fontSize: 11, fontWeight: 500,
              color: openMenu === m.label ? theme.text : theme.textMuted,
              background: openMenu === m.label ? theme.bgHover : "transparent",
              border: "none", cursor: "pointer",
            }}
          >
            {m.label}
          </button>
          {openMenu === m.label && <Dropdown menu={m} onClose={() => setOpenMenu(null)} />}
        </div>
      ))}
    </div>
  );
}
