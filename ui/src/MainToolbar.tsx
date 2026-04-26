import { useCallback, useMemo } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import { Play, Pause, Square, StepForward, Activity, Settings, RefreshCw, Layers, Bug } from "lucide-react";

// ─── Consistent icon size across all toolbar buttons ────────────────────────

const ICON_SIZE = 14;

interface MainToolbarProps {
  onAction?: (action: string) => void;
}

export function MainToolbar({ onAction }: MainToolbarProps) {
  const theme = useTheme();
  const { t } = useI18n();

  // ─── Memoized base button style ────────────────────────────────────────────
  const btnStyle = useMemo((): React.CSSProperties => ({
    padding: "4px 8px",
    display: "flex",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.radiusSm,
    color: theme.text,
    fontSize: 11,
    cursor: "pointer",
    background: "transparent",
    border: "1px solid transparent",
    transition: `all 0.12s ${theme.ease}`,
  }), [theme.radiusSm, theme.text, theme.ease]);

  // ─── Hover handlers (stable refs) ─────────────────────────────────────────
  const handleEnter = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = theme.bgHover;
  }, [theme.bgHover]);

  const handleLeave = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = "transparent";
  }, []);

  const hoverProps = useMemo(() => ({
    onMouseEnter: handleEnter,
    onMouseLeave: handleLeave,
  }), [handleEnter, handleLeave]);

  // ─── Action callbacks ─────────────────────────────────────────────────────
  const onStart     = useCallback(() => onAction?.("run.start"), [onAction]);
  const onPause     = useCallback(() => onAction?.("run.pause"), [onAction]);
  const onStop      = useCallback(() => onAction?.("run.stop"), [onAction]);
  const onStep      = useCallback(() => onAction?.("run.step"), [onAction]);
  const onReload    = useCallback(() => onAction?.("trace.reload"), [onAction]);
  const onBenchmark = useCallback(() => onAction?.("trace.benchmark"), [onAction]);
  const onReport    = useCallback(() => onAction?.("view.report"), [onAction]);
  const onConfig    = useCallback(() => onAction?.("run.config"), [onAction]);
  const onDebug     = useCallback(() => onAction?.("tools.debug"), [onAction]);

  // ─── Container style ──────────────────────────────────────────────────────
  const barStyle = useMemo(() => ({
    background: theme.bgPanel,
    borderBottom: `0.5px solid ${theme.borderSubtle}`,
  }), [theme.bgPanel, theme.borderSubtle]);

  // ─── Divider ──────────────────────────────────────────────────────────────
  const Divider = useMemo(() => {
    const D = () => <div style={{ width: 1, height: 16, background: theme.border, margin: "0 4px" }} />;
    D.displayName = "Divider";
    return D;
  }, [theme.border]);

  return (
    <div className="flex items-center px-2 py-1 gap-1 shrink-0 select-none" style={barStyle}>

      {/* Run Controls */}
      <button style={btnStyle} {...hoverProps} onClick={onStart} title={`${t("toolbar.start")} (F5)`}>
        <Play size={ICON_SIZE} color={theme.success} />
      </button>
      <button style={btnStyle} {...hoverProps} onClick={onPause} title={`${t("toolbar.pause")} (F7)`}>
        <Pause size={ICON_SIZE} color={theme.warning} />
      </button>
      <button style={btnStyle} {...hoverProps} onClick={onStop} title={`${t("toolbar.stop")} (Shift+F5)`}>
        <Square size={ICON_SIZE} color={theme.error} />
      </button>
      <button style={btnStyle} {...hoverProps} onClick={onStep} title={`${t("toolbar.step")} (F10)`}>
        <StepForward size={ICON_SIZE} color={theme.info} />
      </button>

      <Divider />

      {/* Analysis Controls */}
      <button style={btnStyle} {...hoverProps} onClick={onReload} title={t("toolbar.reload")}>
        <RefreshCw size={ICON_SIZE} color={theme.textMuted} />
      </button>
      <button style={btnStyle} {...hoverProps} onClick={onBenchmark} title={t("toolbar.telemetry")}>
        <Activity size={ICON_SIZE} color={theme.accent} />
      </button>

      <Divider />

      {/* Report button with label */}
      <button style={btnStyle} {...hoverProps} onClick={onReport} title={t("toolbar.report")}>
        <Layers size={ICON_SIZE} color={theme.textMuted} /> <span style={{ color: theme.textDim }}>{t("toolbar.report")}</span>
      </button>

      <div className="flex-1" />

      {/* Right controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 8 }}>
        <span style={{ fontSize: 10, color: theme.textMuted, fontFamily: theme.fontMono }}>
          {t("toolbar.target")}
        </span>
        <Divider />
        <button style={btnStyle} {...hoverProps} onClick={onConfig} title={t("toolbar.config")}>
          <Settings size={ICON_SIZE} color={theme.textMuted} />
        </button>
        <button style={btnStyle} {...hoverProps} onClick={onDebug} title={t("toolbar.debug")}>
          <Bug size={ICON_SIZE} color={theme.textMuted} />
        </button>
      </div>

    </div>
  );
}
