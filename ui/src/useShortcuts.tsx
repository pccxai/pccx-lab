/**
 * Single source of truth for keyboard shortcuts.
 *
 * Rationale (WCAG 2.2 SC 2.1.1 Keyboard, WAI-ARIA 1.2 §5.2.8.4 aria-label):
 * - Every non-trivial action must be reachable without a mouse.
 * - Users must be able to discover every binding from inside the app
 *   via one well-known key (`?` or `F1`).
 *
 * The actual key-to-command mapping lives in `keybindings.ts`; this
 * module re-exports a backward-compatible `SHORTCUT_MAP` and the
 * help modal / hook used by App.tsx.
 */
import React, { useState } from "react";
import { getEffectiveKeybindings, COMMAND_LABELS, type KeyBinding } from "./keybindings";
import { useTheme } from "./ThemeContext";

export interface Shortcut {
  key: string;
  desc: string;
  action: string;
}

/** Capitalise modifier names for display (ctrl -> Ctrl). */
function formatKeyForDisplay(raw: string): string {
  return raw
    .split("+")
    .map(part => {
      if (part === "ctrl") return "Ctrl";
      if (part === "shift") return "Shift";
      if (part === "alt") return "Alt";
      if (part === "escape") return "Escape";
      // F-keys: F1 -> F1
      if (/^f\d+$/.test(part)) return part.toUpperCase();
      // Single chars: keep as-is (already human-readable)
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

function toShortcut(kb: KeyBinding): Shortcut {
  return {
    key: formatKeyForDisplay(kb.key),
    desc: COMMAND_LABELS[kb.command] ?? kb.command,
    action: kb.command,
  };
}

export const SHORTCUT_MAP: Shortcut[] = getEffectiveKeybindings().map(toShortcut);

/**
 * Hook: provides open/close state for the shortcut help overlay.
 * Keyboard dispatch (? / F1 / Escape) is handled by the global
 * dispatcher in App.tsx via handleMenuAction("help.shortcuts").
 */
export function useShortcutHelp(): { open: boolean; setOpen: (v: boolean) => void } {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Modal overlay listing every effective keybinding. Focus-trapped by
 * `aria-modal="true"`; dismiss with `Escape` or the close button.
 */
export function ShortcutHelp({ open, onClose }: ShortcutHelpProps): React.ReactElement | null {
  const theme = useTheme();
  if (!open) return null;
  const bindings = getEffectiveKeybindings().map(toShortcut);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 460, maxWidth: 640, maxHeight: "80vh",
          background: "var(--pccx-surface, #1e1e1e)",
          color: "var(--pccx-text, #e6e6e6)",
          border: "0.5px solid rgba(255,255,255,0.12)",
          borderRadius: 6, padding: 20, overflow: "auto",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.04em", margin: 0 }}>
            KEYBOARD SHORTCUTS
          </h2>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label="Close shortcut help"
            onClick={onClose}
            style={{
              background: "transparent", border: "none", color: "inherit",
              cursor: "pointer", fontSize: 16, padding: "2px 8px",
            }}
          >
            x
          </button>
        </div>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <tbody>
            {bindings.map((s) => (
              <tr key={s.action} style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <td style={{ padding: "6px 10px 6px 0", whiteSpace: "nowrap" }}>
                  <kbd
                    style={{
                      fontFamily: theme.fontMono,
                      fontSize: 11, padding: "1px 6px", borderRadius: 3,
                      background: "rgba(255,255,255,0.08)",
                      border: "0.5px solid rgba(255,255,255,0.14)",
                    }}
                  >{s.key}</kbd>
                </td>
                <td style={{ padding: "6px 0", color: "rgba(230,230,230,0.8)" }}>{s.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 10, color: "rgba(230,230,230,0.5)", marginTop: 12 }}>
          Press <kbd>Esc</kbd> or click outside to dismiss. Full list in
          <code> docs/getting-started.md</code>.
        </p>
      </div>
    </div>
  );
}
