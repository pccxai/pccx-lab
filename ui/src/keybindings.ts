/**
 * VS Code-style keybindings registry.
 *
 * Provides default bindings, user overrides (persisted to localStorage),
 * and event-to-command matching used by the global dispatcher in App.tsx.
 */

export interface KeyBinding {
  key: string;
  command: string;
  when?: string;
}

const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  { key: "ctrl+o",        command: "file.open" },
  { key: "ctrl+shift+o",  command: "file.openVcd" },
  { key: "ctrl+s",        command: "file.save" },
  { key: "ctrl+p",        command: "command.palette" },
  { key: "ctrl+shift+p",  command: "command.palette" },
  { key: "ctrl+f",        command: "edit.find" },
  { key: "ctrl+g",        command: "edit.goto" },
  { key: "ctrl+b",        command: "view.sidebar" },
  { key: "ctrl+shift+d",  command: "flame.diff" },
  { key: "ctrl+i",        command: "trace.validate" },
  { key: "ctrl+`",        command: "view.copilot" },
  { key: "ctrl+j",        command: "view.bottom" },
  { key: "f1",            command: "view.timeline" },
  { key: "f2",            command: "view.nodes" },
  { key: "f3",            command: "view.code" },
  { key: "f4",            command: "view.report" },
  { key: "f5",            command: "run.start" },
  { key: "f7",            command: "run.pause" },
  { key: "shift+f5",      command: "run.stop" },
  { key: "f10",           command: "run.step" },
  { key: "f11",           command: "view.fullscreen" },
  { key: "shift+a",       command: "nodes.add", when: "nodeEditorFocused" },
  { key: "escape",        command: "ui.escape" },
  { key: "?",             command: "help.shortcuts" },
];

let userOverrides: KeyBinding[] = [];

export function loadUserKeybindings(): void {
  try {
    const stored = localStorage.getItem("pccx-keybindings");
    if (stored) userOverrides = JSON.parse(stored);
  } catch { /* ignore malformed data */ }
}

export function saveUserKeybindings(bindings: KeyBinding[]): void {
  userOverrides = bindings;
  localStorage.setItem("pccx-keybindings", JSON.stringify(bindings));
}

export function getEffectiveKeybindings(): KeyBinding[] {
  const overrideMap = new Map(userOverrides.map(b => [b.command, b]));
  return DEFAULT_KEYBINDINGS.map(def => overrideMap.get(def.command) ?? def);
}

export function getDefaultKeybindings(): KeyBinding[] {
  return [...DEFAULT_KEYBINDINGS];
}

export function getUserKeybindings(): KeyBinding[] {
  return [...userOverrides];
}

/**
 * Normalise a DOM KeyboardEvent into the canonical string form used
 * by the binding table (e.g. "ctrl+shift+o", "f5", "?").
 *
 * Shifted punctuation glyphs ("?", "!", "~", etc.) are kept as-is
 * without a redundant "shift+" prefix — the physical Shift is
 * implicit in the glyph itself.
 */
export function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");

  let key = e.key.toLowerCase();
  if (key === " ") key = "space";

  // Shift is a real modifier for letters (a-z) and multi-char keys
  // (F5, Escape, etc.). For single-char non-letter glyphs produced
  // by shift (?, !, ~, etc.) the glyph already encodes the shift.
  const isMultiChar = e.key.length > 1;
  const isLetter = /^[a-z]$/i.test(e.key);
  if (e.shiftKey && (isMultiChar || isLetter)) parts.push("shift");

  if (e.altKey) parts.push("alt");

  if (!["control", "shift", "alt", "meta"].includes(key)) {
    parts.push(key);
  }

  return parts.join("+");
}

export function matchKeybinding(e: KeyboardEvent): KeyBinding | undefined {
  const pressed = normalizeKeyEvent(e);
  const bindings = getEffectiveKeybindings();
  return bindings.find(b => b.key === pressed);
}

export const COMMAND_LABELS: Record<string, string> = {
  "file.open": "Open .pccx trace",
  "file.openVcd": "Open VCD file",
  "file.save": "Save file",
  "command.palette": "Command Palette",
  "edit.find": "Find event / signal",
  "edit.goto": "Go to cycle",
  "view.sidebar": "Toggle Sidebar",
  "flame.diff": "Toggle Flame Graph diff mode",
  "trace.validate": "Validate trace integrity",
  "view.copilot": "Toggle workflow assistant panel",
  "view.bottom": "Toggle Bottom Panel",
  "view.timeline": "Timeline",
  "view.nodes": "Data Flow",
  "view.code": "SV Editor",
  "view.report": "Report",
  "run.start": "Start Simulation",
  "run.pause": "Pause Simulation",
  "run.stop": "Stop Simulation",
  "run.step": "Step Over",
  "view.fullscreen": "Toggle fullscreen",
  "nodes.add": "Node Editor quick-add",
  "ui.escape": "Close modal / menu",
  "help.shortcuts": "Show shortcut help",
};

loadUserKeybindings();
