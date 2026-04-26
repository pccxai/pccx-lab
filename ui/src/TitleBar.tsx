import { useCallback, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import { Play, Pause, Square, StepForward, Sun, Moon, Minus, X, Maximize2 } from "lucide-react";

// ─── Shared icon size constant ──────────────────────────────────────────────

const ICON_SM = 13;
const ICON_MD = 14;

// ─── Hover-aware button (no state — inline event handlers) ──────────────────

function RunButton({ style, onClick, title, hoverBg, children }: {
  style: React.CSSProperties; onClick: () => void; title: string; hoverBg: string; children: React.ReactNode;
}) {
  return (
    <button style={style} onClick={onClick} title={title}
      onMouseEnter={e => e.currentTarget.style.background = hoverBg}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {children}
    </button>
  );
}

interface TitleBarProps {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  onAction?: (action: string) => void;
}

export function TitleBar({ title = "pccx-lab", subtitle, children, onAction }: TitleBarProps) {
  const theme = useTheme();
  const { t } = useI18n();

  // ─── Window control callbacks (stable refs) ────────────────────────────────
  const handleMinimize = useCallback(() => getCurrentWindow().minimize(), []);
  const handleMaximize = useCallback(() => getCurrentWindow().toggleMaximize(), []);
  const handleClose = useCallback(() => getCurrentWindow().close(), []);

  // ─── Memoized run-button style factory ─────────────────────────────────────
  const runBtnStyle = useCallback((color: string): React.CSSProperties => ({
    width: 28, height: 28,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "transparent", border: "none", cursor: "pointer",
    color, borderRadius: theme.radiusSm,
    transition: `all 0.15s ${theme.ease}`,
  }), [theme.radiusSm, theme.ease]);

  // ─── Window button base style ──────────────────────────────────────────────
  const winBtnBase = useMemo((): React.CSSProperties => ({
    width: 28, height: 28,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "transparent", border: "none", cursor: "pointer",
    borderRadius: theme.radiusSm, color: theme.textMuted,
    transition: `all 0.12s ${theme.ease}`,
  }), [theme.radiusSm, theme.textMuted, theme.ease]);

  // ─── Container style ──────────────────────────────────────────────────────
  const containerStyle = useMemo(() => ({
    height: 38,
    background: theme.bgPanel,
    borderBottom: `0.5px solid ${theme.borderSubtle}`,
  }), [theme.bgPanel, theme.borderSubtle]);

  // ─── Brand badge gradient ──────────────────────────────────────────────────
  const badgeStyle = useMemo(() => ({
    background: `linear-gradient(135deg, ${theme.accent}, ${theme.accentDim})`,
    borderRadius: 5,
  }), [theme.accent, theme.accentDim]);

  // ─── Run control group style ──────────────────────────────────────────────
  const runGroupStyle = useMemo(() => ({
    background: theme.bgGlass,
    border: `0.5px solid ${theme.borderSubtle}`,
  }), [theme.bgGlass, theme.borderSubtle]);

  // ─── Action callbacks ─────────────────────────────────────────────────────
  const onStart = useCallback(() => onAction?.("run.start"), [onAction]);
  const onPause = useCallback(() => onAction?.("run.pause"), [onAction]);
  const onStop = useCallback(() => onAction?.("run.stop"), [onAction]);
  const onStep = useCallback(() => onAction?.("run.step"), [onAction]);

  return (
    <div
      data-tauri-drag-region
      className="flex items-center shrink-0 select-none"
      style={containerStyle}
    >
      {/* Left: Brand — 76px matches macOS traffic light safe zone */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pr-4" style={{ minWidth: 76, paddingLeft: 14 }}>
        <div className="flex items-center gap-1.5 pointer-events-none" data-tauri-drag-region>
          <div className="w-4 h-4 rounded flex items-center justify-center shrink-0" style={badgeStyle}>
            <span style={{ fontSize: 8, fontWeight: 800, color: "#fff" }}>P</span>
          </div>
          <span style={{ fontSize: 12, fontWeight: 600, color: theme.text, letterSpacing: -0.3 }}>{title}</span>
        </div>
      </div>

      {/* Menu bar slot */}
      <div className="flex items-center h-full" data-tauri-drag-region>
        {children}
      </div>

      <div className="flex-1" data-tauri-drag-region />

      {/* Run controls */}
      <div className="flex items-center gap-0.5 px-1 py-1 rounded-lg" style={runGroupStyle}>
        <RunButton style={runBtnStyle(theme.success)} onClick={onStart} title={`${t("title.start")} (F5)`} hoverBg={theme.successBg}>
          <Play size={ICON_SM} fill="currentColor" />
        </RunButton>
        <RunButton style={runBtnStyle(theme.warning)} onClick={onPause} title={`${t("title.pause")} (F7)`} hoverBg={theme.warningBg}>
          <Pause size={ICON_SM} />
        </RunButton>
        <RunButton style={runBtnStyle(theme.error)} onClick={onStop} title={`${t("title.stop")} (Shift+F5)`} hoverBg={theme.errorBg}>
          <Square size={11} fill="currentColor" />
        </RunButton>
        <div style={{ width: 1, height: 16, background: theme.borderSubtle, margin: "0 2px" }} />
        <RunButton style={runBtnStyle(theme.info)} onClick={onStep} title={`${t("title.step")} (F10)`} hoverBg="rgba(55,148,255,0.12)">
          <StepForward size={ICON_SM} />
        </RunButton>
      </div>

      {/* Centre status subtitle */}
      <div data-tauri-drag-region className="flex-1 flex items-center justify-center pointer-events-none">
        {subtitle && (
          <span style={{
            fontSize: 11, color: theme.textMuted, fontWeight: 500,
            padding: "2px 10px",
          }}>
            {subtitle}
          </span>
        )}
      </div>

      {/* Right: Theme toggle + Window controls */}
      <div className="flex items-center gap-0.5 pr-1">
        <span style={{ fontSize: 10, color: theme.textFaint, fontFamily: theme.fontMono, marginRight: 8 }}>
          {t("title.simTarget")}
        </span>
        <button onClick={theme.toggle} title={t("title.toggleTheme")} style={winBtnBase}
          onMouseEnter={e => e.currentTarget.style.background = theme.bgGlassHover}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          {theme.mode === "dark" ? <Sun size={ICON_SM} color={theme.warning} /> : <Moon size={ICON_SM} color={theme.textMuted} />}
        </button>
        <div style={{ width: 1, height: 14, background: theme.borderSubtle, margin: "0 2px" }} />
        <button onClick={handleMinimize} title={t("title.minimize")} style={winBtnBase}
          onMouseEnter={e => e.currentTarget.style.background = theme.bgGlassHover}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          <Minus size={ICON_MD} />
        </button>
        <button onClick={handleMaximize} title={t("title.maximize")} style={winBtnBase}
          onMouseEnter={e => e.currentTarget.style.background = theme.bgGlassHover}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          <Maximize2 size={12} />
        </button>
        <button onClick={handleClose} title={t("title.close")} style={winBtnBase}
          onMouseEnter={e => { e.currentTarget.style.background = theme.errorBg; e.currentTarget.style.color = theme.error; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}>
          <X size={ICON_MD} />
        </button>
      </div>
    </div>
  );
}
