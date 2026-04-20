import { createContext, useContext, useEffect, useState, ReactNode } from "react";

// ─── Supported languages ─────────────────────────────────────────────────────

export type Lang = "en" | "ko";

// ─── Translation tables ─────────────────────────────────────────────────────
//
// Keep the keys stable — every `t("key")` call is a lookup here. Add keys
// here first, then reference them in components. Unknown keys fall back
// to the key itself so missing strings are visible but non-fatal.

const STRINGS: Record<string, Record<Lang, string>> = {
  // Shell
  "tab.timeline":         { en: "Timeline",          ko: "타임라인" },
  "tab.flamegraph":       { en: "Flame Graph",       ko: "플레임 그래프" },
  "tab.waveform":         { en: "Waveform",          ko: "웨이브폼" },
  "tab.systemSim":        { en: "System Simulator",  ko: "시스템 시뮬레이터" },
  "tab.memoryDump":       { en: "Memory Dump",       ko: "메모리 덤프" },
  "tab.dataFlow":         { en: "Data Flow",         ko: "데이터 플로우" },
  "tab.svEditor":         { en: "SV Editor",         ko: "SV 에디터" },
  "tab.report":           { en: "Report",            ko: "리포트" },
  "tab.canvas":           { en: "3D View",           ko: "3D 뷰" },
  "tab.extensions":       { en: "Extensions",        ko: "확장" },
  "tab.verification":     { en: "Verification",      ko: "검증" },
  "tab.roofline":         { en: "Roofline",          ko: "루프라인" },

  // Menu bar top-level
  "menu.file":            { en: "File",              ko: "파일" },
  "menu.edit":            { en: "Edit",              ko: "편집" },
  "menu.view":            { en: "View",              ko: "보기" },
  "menu.trace":           { en: "Trace",             ko: "트레이스" },
  "menu.analysis":        { en: "Analysis",          ko: "분석" },
  "menu.verify":          { en: "Verify",            ko: "검증" },
  "menu.run":             { en: "Run",               ko: "실행" },
  "menu.tools":           { en: "Tools",             ko: "도구" },
  "menu.window":          { en: "Window",            ko: "창" },
  "menu.help":            { en: "Help",              ko: "도움말" },

  // Bottom tabs
  "bottom.log":           { en: "Log",               ko: "로그" },
  "bottom.console":       { en: "Console",           ko: "콘솔" },
  "bottom.telemetry":     { en: "Live Telemetry",    ko: "실시간 모니터" },

  // Status bar
  "status.trace":         { en: "Trace",             ko: "트레이스" },
  "status.noTrace":       { en: "No Trace",          ko: "트레이스 없음" },
  "status.cycles":        { en: "Cycles",            ko: "사이클" },
  "status.cores":         { en: "Cores",             ko: "코어" },

  // Panels
  "panel.aiCopilot":      { en: "AI Copilot",        ko: "AI Copilot" },
  "panel.telemetry":      { en: "LIVE TELEMETRY",    ko: "실시간 모니터" },
  "panel.logs":           { en: "Logs",              ko: "로그" },
  "panel.console":        { en: "Console",           ko: "콘솔" },
  "panel.clear":          { en: "Clear",             ko: "지우기" },

  // Misc
  "btn.send":             { en: "Send",              ko: "전송" },
  "placeholder.ask":      { en: "Ask anything…",     ko: "질문 입력…" },
};

// ─── Context ────────────────────────────────────────────────────────────────

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue>(null!);

const LS_KEY = "pccx-lang";

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_KEY) as Lang | null;
    if (saved === "en" || saved === "ko") return saved;
  } catch { /* private-mode fallback */ }
  // Default to English per product rule. Respect navigator.language only
  // the first time a user opens the app — after that the explicit toggle
  // wins via localStorage.
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("ko")) {
    return "ko";
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LS_KEY, l); } catch { /* ignore */ }
    document.documentElement.setAttribute("lang", l);
  };

  useEffect(() => {
    document.documentElement.setAttribute("lang", lang);
  }, [lang]);

  const t = (key: string) => {
    const entry = STRINGS[key];
    if (!entry) return key;
    return entry[lang] ?? entry.en ?? key;
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
