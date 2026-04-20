import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";

interface StatusBarProps {
  traceLoaded: boolean;
  totalCycles?: number;
  numCores?: number;
  license?: string;
  activeTab?: string;
}

export function StatusBar({ traceLoaded, totalCycles, numCores, license, activeTab }: StatusBarProps) {
  const theme = useTheme();
  const { lang, setLang, t } = useI18n();

  const pill = (text: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        fontSize: 9, padding: "0 6px", margin: "0 1px",
        fontWeight: active ? 700 : 500,
        color: active ? theme.accent : theme.textMuted,
        background: active ? theme.accentBg : "transparent",
        border: `1px solid ${active ? theme.accent : theme.border}`,
        borderRadius: 3, cursor: "pointer", lineHeight: "14px",
      }}
    >
      {text}
    </button>
  );

  return (
    <div className="h-6 flex items-center px-3 gap-4 shrink-0 select-none"
      style={{ background: theme.bgPanel, borderTop: `1px solid ${theme.border}`, fontSize: 10 }}>
      <span style={{ color: traceLoaded ? theme.success : theme.textMuted }}>
        {traceLoaded ? `● ${t("status.trace")}` : `○ ${t("status.noTrace")}`}
      </span>
      {totalCycles != null && (
        <>
          <span style={{ color: theme.textFaint }}>|</span>
          <span style={{ color: theme.textMuted }}>
            {t("status.cycles")}: <span style={{ color: theme.text, fontFamily: "monospace" }}>{totalCycles.toLocaleString()}</span>
          </span>
        </>
      )}
      {numCores != null && (
        <>
          <span style={{ color: theme.textFaint }}>|</span>
          <span style={{ color: theme.textMuted }}>
            {t("status.cores")}: <span style={{ color: theme.text, fontFamily: "monospace" }}>{numCores}</span>
          </span>
        </>
      )}
      <div className="flex-1" />
      {activeTab && <span style={{ color: theme.textMuted, textTransform: "capitalize" }}>{activeTab}</span>}
      <span style={{ color: theme.textFaint }}>|</span>
      <span style={{ color: theme.textMuted }}>pccx-lab v0.4.0</span>
      {license && (
        <>
          <span style={{ color: theme.textFaint }}>|</span>
          <span style={{ color: theme.accent }}>{license}</span>
        </>
      )}
      <span style={{ color: theme.textFaint }}>|</span>
      <button
        onClick={theme.toggle}
        title="Toggle theme"
        style={{
          fontSize: 10, padding: "0 6px",
          color: theme.textMuted, background: "transparent",
          border: `1px solid ${theme.border}`, borderRadius: 3,
          cursor: "pointer", lineHeight: "14px",
        }}
      >
        {theme.mode === "dark" ? "☾ Dark" : "☀ Light"}
      </button>
      <div style={{ display: "inline-flex" }}>
        {pill("EN", lang === "en", () => setLang("en"))}
        {pill("한", lang === "ko", () => setLang("ko"))}
      </div>
    </div>
  );
}
