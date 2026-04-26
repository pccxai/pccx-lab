import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useTheme } from "./ThemeContext";
import { getEffectiveKeybindings } from "./keybindings";
import {
  Search, Play, FileText, Activity, Code2, Clock, Layers,
  Database, Box, Settings2, CheckCircle, PieChart, Zap,
  ActivitySquare, LayoutDashboard, Download, Save, Moon,
  PanelBottom, Sidebar, FileSearch, AlignLeft, ArrowDownToLine,
  ShieldCheck, Triangle,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CommandItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action: () => void;
  category: "Files" | "View" | "Run" | "Analysis" | "Editor" | "Tools" | "Verification";
}

// ─── Fuzzy match ─────────────────────────────────────────────────────────────

function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact substring gets highest score
  if (t.includes(q)) {
    const idx = t.indexOf(q);
    // Prefer matches at word boundaries
    const boundaryBonus = idx === 0 || t[idx - 1] === " " || t[idx - 1] === "." ? 10 : 0;
    return { match: true, score: 100 - idx + boundaryBonus };
  }

  // Sequential character match (fuzzy)
  let qi = 0;
  let score = 0;
  let prevMatchIdx = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive matches score higher
      score += (ti === prevMatchIdx + 1) ? 5 : 1;
      prevMatchIdx = ti;
      qi++;
    }
  }

  if (qi === q.length) {
    return { match: true, score };
  }
  return { match: false, score: 0 };
}

// ─── Shortcut display resolver ──────────────────────────────────────────────

function buildShortcutMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const kb of getEffectiveKeybindings()) {
    if (!map.has(kb.command)) {
      // Format: "ctrl+shift+p" -> "Ctrl+Shift+P"
      const display = kb.key.split("+").map((seg) => {
        if (seg.length === 1) return seg.toUpperCase();
        return seg.charAt(0).toUpperCase() + seg.slice(1);
      }).join("+");
      map.set(kb.command, display);
    }
  }
  return map;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CommandPalette({ open, setOpen, onAction }: {
  open: boolean;
  setOpen: (v: boolean) => void;
  onAction: (a: string) => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Resolve keybinding shortcuts for display
  const shortcutMap = useMemo(() => buildShortcutMap(), []);

  const ITEMS: CommandItem[] = useMemo(() => {
    const s = (cmd: string) => shortcutMap.get(cmd);
    return [
      // Files
      { id: "file.open",       label: "Open File",               shortcut: s("file.open"),    icon: <FileSearch size={14}/>,     category: "Files",        action: () => onAction("file.openGeneric") },
      { id: "file.save",       label: "Save",                    shortcut: s("file.save"),    icon: <Save size={14}/>,           category: "Files",        action: () => onAction("file.save") },
      { id: "file.saveAll",    label: "Save All",                                              icon: <Save size={14}/>,           category: "Files",        action: () => onAction("file.saveAll") },
      { id: "file.openVcd",    label: "Open VCD File",           shortcut: s("file.openVcd"), icon: <ActivitySquare size={14}/>, category: "Files",        action: () => onAction("file.openVcd") },
      { id: "file.openTrace",  label: "Load .pccx Trace",        shortcut: s("file.open"),    icon: <FileText size={14}/>,       category: "Files",        action: () => onAction("file.open") },
      { id: "tools.vcd",       label: "Export as VCD",                                         icon: <Download size={14}/>,       category: "Files",        action: () => onAction("tools.vcd") },
      { id: "tools.chromeTrace", label: "Export as Chrome Trace",                               icon: <Download size={14}/>,       category: "Files",        action: () => onAction("tools.chromeTrace") },

      // View
      { id: "view.theme",      label: "Toggle Theme",                                          icon: <Moon size={14}/>,           category: "View",         action: () => { theme.toggle(); } },
      { id: "view.sidebar",    label: "Toggle Sidebar",          shortcut: s("view.sidebar"), icon: <Sidebar size={14}/>,        category: "View",         action: () => onAction("view.sidebar") },
      { id: "view.bottom",     label: "Toggle Bottom Panel",     shortcut: s("view.bottom"),  icon: <PanelBottom size={14}/>,    category: "View",         action: () => onAction("view.bottom") },
      { id: "view.scenario",   label: "Scenario Flow",                                         icon: <Zap size={14}/>,            category: "View",         action: () => onAction("view.scenario") },
      { id: "view.timeline",   label: "Timeline Analysis",       shortcut: s("view.timeline"), icon: <Clock size={14}/>,          category: "View",         action: () => onAction("view.timeline") },
      { id: "view.flamegraph", label: "Flame Graph",                                           icon: <Layers size={14}/>,         category: "View",         action: () => onAction("view.flamegraph") },
      { id: "view.waves",      label: "Waveform Viewer",                                       icon: <ActivitySquare size={14}/>, category: "View",         action: () => onAction("view.waves") },
      { id: "view.hardware",   label: "System Simulator",                                      icon: <Activity size={14}/>,       category: "View",         action: () => onAction("view.hardware") },
      { id: "view.memory",     label: "Memory Dump",                                           icon: <Database size={14}/>,       category: "View",         action: () => onAction("view.memory") },
      { id: "view.nodes",      label: "Data Flow Editor",        shortcut: s("view.nodes"),   icon: <Activity size={14}/>,       category: "View",         action: () => onAction("view.nodes") },
      { id: "view.code",       label: "SV Editor",               shortcut: s("view.code"),    icon: <Code2 size={14}/>,          category: "View",         action: () => onAction("view.code") },
      { id: "view.tb_author",  label: "Testbench Author",                                      icon: <LayoutDashboard size={14}/>, category: "View",        action: () => onAction("view.tb_author") },
      { id: "view.report",     label: "Report Builder",          shortcut: s("view.report"),  icon: <FileText size={14}/>,       category: "View",         action: () => onAction("view.report") },
      { id: "view.canvas",     label: "3D View",                                               icon: <Box size={14}/>,            category: "View",         action: () => onAction("view.canvas") },
      { id: "view.extensions", label: "Extensions",                                             icon: <Settings2 size={14}/>,      category: "View",         action: () => onAction("view.extensions") },
      { id: "view.verify",     label: "Verification Suite",                                     icon: <CheckCircle size={14}/>,    category: "View",         action: () => onAction("view.verify") },
      { id: "view.copilot",    label: "Toggle AI Copilot",       shortcut: s("view.copilot"), icon: <Activity size={14}/>,       category: "View",         action: () => onAction("view.copilot") },
      { id: "view.fullscreen", label: "Toggle Fullscreen",       shortcut: s("view.fullscreen"), icon: <Box size={14}/>,          category: "View",         action: () => onAction("view.fullscreen") },

      // Editor
      { id: "edit.find",       label: "Find in Editor",          shortcut: s("edit.find"),    icon: <Search size={14}/>,         category: "Editor",       action: () => onAction("edit.find") },
      { id: "edit.goto",       label: "Go to Line",              shortcut: s("edit.goto"),    icon: <ArrowDownToLine size={14}/>, category: "Editor",      action: () => onAction("edit.goto") },
      { id: "edit.format",     label: "Format Document",                                       icon: <AlignLeft size={14}/>,      category: "Editor",       action: () => onAction("edit.format") },

      // Analysis
      { id: "analysis.roofline",    label: "Analyze Roofline",                                  icon: <PieChart size={14}/>,       category: "Analysis",     action: () => onAction("analysis.roofline") },
      { id: "analysis.bottleneck",  label: "Detect Bottlenecks",                                icon: <Triangle size={14}/>,       category: "Analysis",     action: () => onAction("analysis.bottleneck") },
      { id: "trace.benchmark",      label: "IPC Benchmark",      shortcut: s("trace.benchmark"), icon: <Zap size={14}/>,          category: "Analysis",     action: () => onAction("trace.benchmark") },
      { id: "analysis.pdf",         label: "Generate PDF Report",                               icon: <FileText size={14}/>,       category: "Analysis",     action: () => onAction("analysis.pdf") },

      // Run
      { id: "run.start",  label: "Start Simulation",  shortcut: s("run.start"),  icon: <Play size={14}/>,     category: "Run", action: () => onAction("run.start") },
      { id: "run.pause",  label: "Pause Simulation",  shortcut: s("run.pause"),  icon: <Activity size={14}/>, category: "Run", action: () => onAction("run.pause") },
      { id: "run.stop",   label: "Stop Simulation",   shortcut: s("run.stop"),   icon: <Activity size={14}/>, category: "Run", action: () => onAction("run.stop") },
      { id: "run.step",   label: "Step Over",          shortcut: s("run.step"),   icon: <Activity size={14}/>, category: "Run", action: () => onAction("run.step") },

      // Verification
      { id: "trace.validate",  label: "Validate Trace Integrity", shortcut: s("trace.validate"), icon: <ShieldCheck size={14}/>, category: "Verification", action: () => onAction("trace.validate") },
      { id: "verify.run",      label: "Run Verification Suite",                                  icon: <CheckCircle size={14}/>,  category: "Verification", action: () => onAction("verify.run") },
    ];
  }, [onAction, shortcutMap, theme]);

  // Fuzzy-filtered and scored command list
  const filtered = useMemo(() => {
    if (!query.trim()) return ITEMS;

    const q = query.trim();
    const scored: { item: CommandItem; score: number }[] = [];
    for (const item of ITEMS) {
      // Match against label, id, and category
      const labelResult = fuzzyMatch(q, item.label);
      const idResult = fuzzyMatch(q, item.id);
      const catResult = fuzzyMatch(q, item.category);
      const bestScore = Math.max(labelResult.score, idResult.score, catResult.score);
      const matched = labelResult.match || idResult.match || catResult.match;
      if (matched) {
        scored.push({ item, score: bestScore });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }, [query, ITEMS]);

  // Close on Escape (window-level)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, setOpen]);

  // Focus input and reset state on open
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  // Reset selection when query changes
  useEffect(() => { setSelectedIndex(0); }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(filtered.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(filtered.length, 1));
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      filtered[selectedIndex]?.action();
      setOpen(false);
    }
  }, [filtered, selectedIndex, setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }}
    >
      {/* Backdrop click to close */}
      <div className="absolute inset-0" onClick={() => setOpen(false)} />

      <div
        className="relative w-[600px] shadow-2xl rounded-lg overflow-hidden flex flex-col pointer-events-auto"
        style={{ background: theme.bgPanel, border: `0.5px solid ${theme.borderSubtle}` }}
      >
        {/* Search input */}
        <div
          className="flex items-center px-4"
          style={{ height: 46, borderBottom: `0.5px solid ${theme.borderSubtle}` }}
        >
          <Search size={18} style={{ color: theme.textMuted, marginRight: 12, flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search commands, files, or settings..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1, height: "100%", background: "transparent", border: "none", outline: "none",
              color: theme.text, fontSize: 13, fontFamily: "Inter, sans-serif",
            }}
          />
          {query && (
            <span style={{ fontSize: 10, color: theme.textMuted, flexShrink: 0, marginLeft: 8 }}>
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {/* Results list */}
        <div ref={listRef} className="flex-1 max-h-[400px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center" style={{ color: theme.textMuted, fontSize: 12 }}>
              No matching commands.
            </div>
          ) : (
            filtered.map((item, i) => (
              <div
                key={item.id}
                onClick={() => { item.action(); setOpen(false); }}
                className="flex items-center px-4 cursor-pointer"
                style={{
                  height: 32,
                  background: i === selectedIndex ? theme.bgHover : "transparent",
                  color: i === selectedIndex ? theme.text : theme.textDim,
                  transition: "background 80ms ease",
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {/* Icon */}
                <div style={{ color: i === selectedIndex ? theme.accent : theme.textMuted, flexShrink: 0 }} className="mr-3">
                  {item.icon}
                </div>

                {/* Label + category */}
                <div style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ fontWeight: 500 }}>{item.label}</span>
                  <span style={{ color: theme.textFaint, marginLeft: 8, fontSize: 10 }}>{item.category}</span>
                </div>

                {/* Shortcut badge */}
                {item.shortcut && (
                  <div style={{
                    fontSize: 10,
                    background: theme.bgInput,
                    padding: "2px 6px",
                    borderRadius: 4,
                    color: theme.textMuted,
                    fontFamily: theme.fontMono,
                    flexShrink: 0,
                    marginLeft: 8,
                  }}>
                    {item.shortcut}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div
          className="px-4 py-2 shrink-0 flex items-center justify-between"
          style={{
            borderTop: `0.5px solid ${theme.borderSubtle}`,
            background: theme.bgSurface,
            fontSize: 9,
            color: theme.textMuted,
          }}
        >
          <span>
            <kbd style={{ background: theme.bgInput, padding: "1px 4px", borderRadius: 2 }}>↑↓</kbd> navigate
          </span>
          <span>
            <kbd style={{ background: theme.bgInput, padding: "1px 4px", borderRadius: 2 }}>Enter</kbd> select
          </span>
          <span>
            <kbd style={{ background: theme.bgInput, padding: "1px 4px", borderRadius: 2 }}>Esc</kbd> dismiss
          </span>
        </div>
      </div>
    </div>
  );
}
