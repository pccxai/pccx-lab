import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";

interface StatusBarProps {
  traceLoaded: boolean;
  totalCycles?: number;
  numCores?: number;
  license?: string;
  activeTab?: string;
  debugMode?: boolean;
}

export function StatusBar({ traceLoaded, totalCycles, numCores, license, activeTab, debugMode }: StatusBarProps) {
  const theme = useTheme();
  const { lang, setLang, t } = useI18n();

  // ─── FPS counter (debug mode only) ─────────────────────────────────────────
  const [fps, setFps] = useState(0);
  const frameRef = useRef(0);
  const lastRef = useRef(performance.now());
  const rafRef = useRef(0);

  useEffect(() => {
    if (!debugMode) return;
    const tick = (now: number) => {
      frameRef.current++;
      if (now - lastRef.current >= 1000) {
        setFps(frameRef.current);
        frameRef.current = 0;
        lastRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [debugMode]);

  // ─── Memoized styles ──────────────────────────────────────────────────────
  const barStyle = useMemo(() => ({
    background: theme.bgPanel,
    borderTop: `0.5px solid ${theme.borderSubtle}`,
    fontSize: 10 as const,
  }), [theme.bgPanel, theme.borderSubtle]);

  const toggleBtnStyle = useMemo(() => ({
    fontSize: 10 as const,
    padding: "0 6px",
    color: theme.textMuted,
    background: "transparent" as const,
    border: `0.5px solid ${theme.borderSubtle}`,
    borderRadius: 3,
    cursor: "pointer" as const,
    lineHeight: "14px",
    transition: `all 0.12s ${theme.ease}`,
  }), [theme.textMuted, theme.borderSubtle, theme.ease]);

  // ─── Language pill renderer ────────────────────────────────────────────────
  const pill = useCallback((text: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        fontSize: 9, padding: "0 6px", margin: "0 1px",
        fontWeight: active ? 700 : 500,
        color: active ? theme.accent : theme.textMuted,
        background: active ? theme.accentBg : "transparent",
        border: `0.5px solid ${active ? theme.accent : "transparent"}`,
        borderRadius: 3, cursor: "pointer", lineHeight: "14px",
        transition: `all 0.12s ${theme.ease}`,
      }}
    >
      {text}
    </button>
  ), [theme.accent, theme.textMuted, theme.accentBg, theme.ease]);

  const handleSetEn = useCallback(() => setLang("en"), [setLang]);
  const handleSetKo = useCallback(() => setLang("ko"), [setLang]);

  // ─── Memoized trace indicator ──────────────────────────────────────────────
  const traceIndicator = useMemo(() => (
    <span style={{ color: traceLoaded ? theme.success : theme.textMuted }}>
      {traceLoaded ? `● ${t("status.trace")}` : `○ ${t("status.noTrace")}`}
    </span>
  ), [traceLoaded, theme.success, theme.textMuted, t]);

  const separator = useMemo(() => (
    <span style={{ color: theme.textFaint }}>|</span>
  ), [theme.textFaint]);

  return (
    <div className="h-6 flex items-center px-3 gap-4 shrink-0 select-none" style={barStyle}>
      {traceIndicator}

      {totalCycles != null && (
        <>
          {separator}
          <span style={{ color: theme.textMuted }}>
            {t("status.cycles")}: <span style={{ color: theme.text, fontFamily: theme.fontMono }}>{totalCycles.toLocaleString()}</span>
          </span>
        </>
      )}

      {numCores != null && (
        <>
          {separator}
          <span style={{ color: theme.textMuted }}>
            {t("status.cores")}: <span style={{ color: theme.text, fontFamily: theme.fontMono }}>{numCores}</span>
          </span>
        </>
      )}

      <div className="flex-1" />

      {/* Debug FPS counter */}
      {debugMode && (
        <>
          <span style={{
            color: fps >= 50 ? theme.success : fps >= 30 ? theme.warning : theme.error,
            fontFamily: theme.fontMono,
            fontWeight: 600,
            fontSize: 9,
          }}>
            {fps} {t("status.fps")}
          </span>
          {separator}
        </>
      )}

      {activeTab && (
        <span style={{ color: theme.textMuted, textTransform: "capitalize" }}>{activeTab}</span>
      )}
      {separator}
      <span style={{ color: theme.textMuted }}>{t("status.version")}</span>

      {license && (
        <>
          {separator}
          <span style={{ color: theme.accent }}>{license}</span>
        </>
      )}

      {separator}
      <button
        onClick={theme.toggle}
        title={t("status.toggleTheme")}
        style={toggleBtnStyle}
      >
        {theme.mode === "dark" ? t("status.dark") : t("status.light")}
      </button>
      <div style={{ display: "inline-flex" }}>
        {pill("EN", lang === "en", handleSetEn)}
        {pill("한", lang === "ko", handleSetKo)}
      </div>
    </div>
  );
}
