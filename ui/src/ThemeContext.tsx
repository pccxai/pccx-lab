import { createContext, useContext, useState, useEffect, ReactNode } from "react";

// ─── Charcoal Neutral Palette (Nsight / VS Code style) ──────────────────────

const DARK = {
  mode: "dark" as const,
  // Backgrounds (neutral charcoal, warmer Apple-style blacks)
  bg:        "#1c1c1e",  // deepest (Apple dark mode)
  bgEditor:  "#1e1e1e",  // main editor
  bgPanel:   "#252526",  // panels / sidebars
  bgSurface: "#2d2d2d",  // elevated cards
  bgHover:   "#333333",  // hover state
  bgInput:   "#3c3c3c",  // input fields
  // Borders
  border:       "#3e3e3e",
  borderDim:    "#2a2a2a",
  borderSubtle: "rgba(255,255,255,0.06)",
  // Glass
  bgGlass:      "rgba(255,255,255,0.04)",
  bgGlassHover: "rgba(255,255,255,0.08)",
  // Text
  text:       "#d4d4d4",
  textDim:    "#cccccc",
  textMuted:  "#858585",
  textFaint:  "#5a5a5a",
  // Accent
  accent:     "#0098ff",  // Nsight cyan-blue
  accentDim:  "#0078d4",
  accentBg:   "rgba(0,152,255,0.12)",
  // Semantic
  success:    "#4ec86b",
  successBg:  "rgba(78,200,107,0.12)",
  successText:"#4ec86b",
  warning:    "#e5a400",
  warningBg:  "rgba(229,164,0,0.12)",
  warningText:"#e5a400",
  error:      "#f14c4c",
  errorBg:    "rgba(241,76,76,0.12)",
  errorText:  "#f14c4c",
  info:       "#3794ff",
  // Typography
  fontSans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace',
  // Radius
  radiusSm: 6,
  radiusMd: 10,
  radiusLg: 14,
  // Animation
  ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
  // Elevation
  shadowSm: "0 1px 2px rgba(0,0,0,0.08)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.12)",
};

const LIGHT = {
  mode: "light" as const,
  bg:        "#f2f2f7",  // Apple-style light
  bgEditor:  "#ffffff",
  bgPanel:   "#f0f0f0",
  bgSurface: "#e8e8e8",
  bgHover:   "#e0e0e0",
  bgInput:   "#ffffff",
  border:       "#d4d4d4",
  borderDim:    "#e5e5e5",
  borderSubtle: "rgba(0,0,0,0.08)",
  bgGlass:      "rgba(0,0,0,0.03)",
  bgGlassHover: "rgba(0,0,0,0.06)",
  text:       "#1e1e1e",
  textDim:    "#333333",
  textMuted:  "#717171",
  textFaint:  "#a0a0a0",
  accent:     "#0066b8",
  accentDim:  "#005a9e",
  accentBg:   "rgba(0,102,184,0.08)",
  success:    "#388a34",
  successBg:  "rgba(56,138,52,0.08)",
  successText:"#14532d",
  warning:    "#bf8803",
  warningBg:  "rgba(191,136,3,0.08)",
  warningText:"#92400e",
  error:      "#cd3131",
  errorBg:    "rgba(205,49,49,0.08)",
  errorText:  "#cd3131",
  info:       "#1a85ff",
  // Typography
  fontSans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif',
  fontMono: '"JetBrains Mono", "SF Mono", "Fira Code", "Cascadia Code", monospace',
  // Radius
  radiusSm: 6,
  radiusMd: 10,
  radiusLg: 14,
  // Animation
  ease: "cubic-bezier(0.25, 0.1, 0.25, 1)",
  // Elevation
  shadowSm: "0 1px 2px rgba(0,0,0,0.04)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.06)",
};

type Theme = (typeof DARK | typeof LIGHT) & { toggle: () => void };

const ThemeContext = createContext<Theme>(null!);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"dark" | "light">(() => {
    try { return (localStorage.getItem("pccx-theme") as "dark" | "light") ?? "dark"; }
    catch { return "dark"; }
  });

  useEffect(() => {
    try { localStorage.setItem("pccx-theme", mode); } catch {}
    document.documentElement.setAttribute("data-theme", mode);
  }, [mode]);

  const toggle = () => setMode(m => m === "dark" ? "light" : "dark");
  const tokens = mode === "dark" ? DARK : LIGHT;

  return (
    <ThemeContext.Provider value={{ ...tokens, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
