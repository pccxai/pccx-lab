import { createContext, useContext, useCallback, useEffect, useMemo, useState, ReactNode } from "react";

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
  "status.version":       { en: "pccx-lab v0.4.0",   ko: "pccx-lab v0.4.0" },
  "status.dark":          { en: "Dark",              ko: "다크" },
  "status.light":         { en: "Light",             ko: "라이트" },
  "status.toggleTheme":   { en: "Toggle theme",      ko: "테마 전환" },
  "status.fps":           { en: "FPS",               ko: "FPS" },

  // TitleBar
  "title.start":          { en: "Start",             ko: "시작" },
  "title.pause":          { en: "Pause",             ko: "일시정지" },
  "title.stop":           { en: "Stop",              ko: "정지" },
  "title.step":           { en: "Step",              ko: "스텝" },
  "title.toggleTheme":    { en: "Toggle theme",      ko: "테마 전환" },
  "title.minimize":       { en: "Minimize",          ko: "최소화" },
  "title.maximize":       { en: "Maximize",          ko: "최대화" },
  "title.close":          { en: "Close",             ko: "닫기" },
  "title.simTarget":      { en: "NPU SIM",           ko: "NPU SIM" },

  // MainToolbar — run controls
  "toolbar.start":        { en: "Start Simulation",  ko: "시뮬레이션 시작" },
  "toolbar.pause":        { en: "Pause Simulation",  ko: "시뮬레이션 일시정지" },
  "toolbar.stop":         { en: "Stop Simulation",   ko: "시뮬레이션 정지" },
  "toolbar.step":         { en: "Step Over",         ko: "스텝 오버" },
  "toolbar.reload":       { en: "Reload Trace",      ko: "트레이스 리로드" },
  "toolbar.telemetry":    { en: "Live Telemetry",    ko: "실시간 모니터" },
  "toolbar.report":       { en: "Report",            ko: "리포트" },
  "toolbar.target":       { en: "Target: NPU SIM [Local]", ko: "타겟: NPU SIM [로컬]" },
  "toolbar.config":       { en: "Target Configuration",     ko: "타겟 설정" },
  "toolbar.debug":        { en: "Debug Mode",        ko: "디버그 모드" },

  // Panels
  "panel.aiCopilot":      { en: "AI Copilot",        ko: "AI Copilot" },
  "panel.telemetry":      { en: "LIVE TELEMETRY",    ko: "실시간 모니터" },
  "panel.logs":           { en: "Logs",              ko: "로그" },
  "panel.console":        { en: "Console",           ko: "콘솔" },
  "panel.clear":          { en: "Clear",             ko: "지우기" },

  // Common actions
  "action.open":          { en: "Open",              ko: "열기" },
  "action.save":          { en: "Save",              ko: "저장" },
  "action.cancel":        { en: "Cancel",            ko: "취소" },
  "action.confirm":       { en: "Confirm",           ko: "확인" },
  "action.delete":        { en: "Delete",            ko: "삭제" },
  "action.reset":         { en: "Reset",             ko: "초기화" },
  "action.export":        { en: "Export",            ko: "내보내기" },
  "action.import":        { en: "Import",            ko: "불러오기" },
  "action.search":        { en: "Search",            ko: "검색" },
  "action.refresh":       { en: "Refresh",           ko: "새로고침" },

  // Misc
  "btn.send":             { en: "Send",              ko: "전송" },
  "placeholder.ask":      { en: "Ask anything…",     ko: "질문 입력…" },

  // AI copilot chat — system / error messages.
  // Any runtime error message the copilot appends must go through t()
  // so English mode stays fully English.
  "copilot.idle":         { en: "AI Copilot is idle. Load a .pccx trace to start analysing.", ko: "AI Copilot 대기 중. .pccx 트레이스를 로드하면 분석을 시작합니다." },
  "copilot.traceLoaded":  { en: "Trace loaded.",     ko: "트레이스 로드 완료." },
  "copilot.traceFailed":  { en: "Trace load failed", ko: "트레이스 로드 실패" },
  "copilot.ipcError":     { en: "IPC error",         ko: "IPC 오류" },
  "copilot.httpError":    { en: "HTTP error",        ko: "HTTP 오류" },
  "copilot.apiError":     { en: "API response error", ko: "API 응답 오류" },
  "copilot.uvmFailed":    { en: "UVM generation failed", ko: "UVM 생성 실패" },
  "copilot.error":        { en: "Error",             ko: "오류" },
  "copilot.context":      { en: "Context",           ko: "컨텍스트" },
  "copilot.none":         { en: "none",              ko: "없음" },
  "copilot.hintApiKey":   { en: "(Enter an OpenAI token above for real API completions)", ko: "(Real API 통신을 원하면 상단에 토큰을 입력하세요)" },
  "copilot.hintExamples": { en: "Try asking:\n• \"bottleneck analysis\"\n• \"generate UVM testbench\"\n• \"build report\"\n• \"roofline analysis\"",
                            ko: "질문 예시:\n• \"병목 분석\"\n• \"UVM testbench 생성\"\n• \"보고서 생성\"\n• \"roofline 분석\"" },
  "copilot.bottleneck":   { en: "Analysis: AXI bus contention is the primary bottleneck. With 32 cores doing simultaneous DMA, each core sees 0.5 B/cycle.\n\n→ Raise L2 prefetch depth or stagger core groups.",
                            ko: "분석: AXI 버스 경합이 주요 병목. 32코어 동시 DMA 시 코어당 0.5 B/cycle.\n\n→ L2 프리페치 깊이 증가 또는 코어 그룹 스태거링 권장" },
  "copilot.uvmIntro":     { en: "UVM sequence",      ko: "UVM 시퀀스" },
  "copilot.uvmHint":      { en: "→ editable in the SV Editor tab", ko: "→ SV Editor 탭에서 편집 가능" },
  "copilot.reportHint":   { en: "In the Report tab you can pick sections and generate a PDF.\n• Executive Summary\n• Hardware Config\n• Utilisation Heatmap\n• Bottleneck Analysis\n• Roofline Model",
                            ko: "Report 탭에서 섹션 선택 후 PDF를 생성할 수 있습니다.\n• Executive Summary\n• Hardware Config\n• Utilisation Heatmap\n• Bottleneck Analysis\n• Roofline Model" },
  "copilot.kbdHint":      { en: "Enter to send · Shift+Enter for newline", ko: "Enter 전송 · Shift+Enter 줄바꿈" },
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

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(LS_KEY, l); } catch { /* ignore */ }
    document.documentElement.setAttribute("lang", l);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("lang", lang);
  }, [lang]);

  const t = useCallback((key: string) => {
    const entry = STRINGS[key];
    if (!entry) return key;
    return entry[lang] ?? entry.en ?? key;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
