import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Editor from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./ThemeContext";
import { monarchCx, cxLanguageConfig } from "./monarch_cx";
import { ensureMonacoReady } from "./monacoSetup";
import { Play, Table2, FileText, AlertCircle, Terminal } from "lucide-react";


const DEFAULT_CX = `// CX — Compute eXtensions
// Hardware-bound language for NPU design
// Real-time feedback: results update as you type

let width = 32
let height = 32
let mac_units = width * height

let clock_mhz = 1000
let ops_per_cycle = mac_units * 2
let tops = ops_per_cycle * clock_mhz / 1000000

// NPU compute capacity
let batch_size = 4
let total_tops = tops * batch_size
total_tops
`;

interface CxResult {
  value: string;
  ast: unknown[];
  variables: Record<string, string>;
}

export function CxPlayground() {
  const theme = useTheme();
  const isDark = theme.mode === "dark";
  const [monacoReady, setMonacoReady] = useState(false);
  const [code, setCode] = useState(DEFAULT_CX);
  const [result, setResult] = useState<CxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activePreview, setActivePreview] = useState<"output" | "vars" | "ast">("output");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { ensureMonacoReady().then(() => setMonacoReady(true)); }, []);

  const evaluate = useCallback(async (source: string) => {
    try {
      const res = await invoke<CxResult>("eval_cx", { source });
      setResult(res);
      setError(null);
    } catch (e: unknown) {
      setError(String(e));
      setResult(null);
    }
  }, []);

  const handleChange = useCallback((val: string | undefined) => {
    const src = val ?? "";
    setCode(src);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => evaluate(src), 300);
  }, [evaluate]);

  useEffect(() => { evaluate(code); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleBeforeMount = useCallback((monaco: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const langs: Array<{ id: string }> = monaco.languages.getLanguages();
    if (!langs.some((l: { id: string }) => l.id === "cx")) {
      monaco.languages.register({ id: "cx", extensions: [".cx"], aliases: ["CX", "cx"] });
    }
    monaco.languages.setMonarchTokensProvider("cx", monarchCx);
    monaco.languages.setLanguageConfiguration("cx", cxLanguageConfig);
  }, []);

  const editorOptions = useMemo(() => ({
    fontFamily: theme.fontMono,
    fontSize: 13,
    lineNumbers: "on" as const,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    renderWhitespace: "selection" as const,
    padding: { top: 12 },
  }), [theme.fontMono]);

  const previewTabStyle = useCallback((active: boolean) => ({
    fontSize: 10, fontWeight: active ? 600 : 400,
    color: active ? theme.text : theme.textMuted,
    padding: "4px 10px", borderRadius: 6, cursor: "pointer" as const,
    background: active ? theme.bgGlassHover : "transparent",
    border: "none",
    transition: `all 0.15s ${theme.ease}`,
  }), [theme.text, theme.textMuted, theme.bgGlassHover, theme.ease]);

  const errorDisplay = useMemo(() => {
    if (!error) return null;
    return (
      <div style={{
        padding: 12, borderRadius: 8, marginBottom: 12,
        background: isDark ? "rgba(241,76,76,0.08)" : "rgba(205,49,49,0.04)",
        border: `0.5px solid ${isDark ? "rgba(241,76,76,0.2)" : "rgba(205,49,49,0.15)"}`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <AlertCircle size={13} color={theme.error} />
          <span style={{ fontSize: 11, fontWeight: 600, color: theme.error }}>Error</span>
        </div>
        <pre style={{ fontSize: 11, color: theme.error, margin: 0, whiteSpace: "pre-wrap", fontFamily: theme.fontMono }}>{error}</pre>
      </div>
    );
  }, [error, isDark, theme.error, theme.fontMono]);

  const outputPanel = useMemo(() => {
    if (!result) return null;
    return (
      <div>
        <div style={{
          padding: 16, borderRadius: 10, marginBottom: 12,
          background: isDark ? "rgba(78,200,107,0.06)" : "rgba(56,138,52,0.04)",
          border: `0.5px solid ${isDark ? "rgba(78,200,107,0.15)" : "rgba(56,138,52,0.1)"}`,
          textAlign: "center",
        }}>
          <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 1 }}>Result</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: theme.success, fontFamily: theme.fontMono }}>{result.value}</div>
        </div>
        {Object.keys(result.variables).length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Bindings</div>
            {Object.entries(result.variables).map(([name, val]) => (
              <div key={name} style={{
                display: "flex", justifyContent: "space-between", padding: "4px 8px",
                borderRadius: 6, marginBottom: 2,
                background: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
              }}>
                <span style={{ fontSize: 11, color: theme.accent, fontFamily: theme.fontMono }}>{name}</span>
                <span style={{ fontSize: 11, color: theme.text, fontFamily: theme.fontMono }}>{val}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }, [result, isDark, theme.textMuted, theme.success, theme.fontMono, theme.accent, theme.text]);

  const varsPanel = useMemo(() => {
    if (!result) return null;
    return (
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
            <th style={{ textAlign: "left", padding: "6px 8px", color: theme.textMuted, fontWeight: 600 }}>Variable</th>
            <th style={{ textAlign: "right", padding: "6px 8px", color: theme.textMuted, fontWeight: 600 }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(result.variables).map(([name, val]) => (
            <tr key={name} style={{ borderBottom: `0.5px solid ${isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)"}` }}>
              <td style={{ padding: "5px 8px", color: theme.accent, fontFamily: theme.fontMono }}>{name}</td>
              <td style={{ padding: "5px 8px", color: theme.text, fontFamily: theme.fontMono, textAlign: "right" }}>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }, [result, isDark, theme.borderSubtle, theme.textMuted, theme.accent, theme.fontMono, theme.text]);

  const astPanel = useMemo(() => {
    if (!result) return null;
    return (
      <pre style={{
        fontSize: 10, color: theme.textDim, fontFamily: theme.fontMono,
        background: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)",
        padding: 12, borderRadius: 8, overflow: "auto", whiteSpace: "pre-wrap",
      }}>
        {JSON.stringify(result.ast, null, 2)}
      </pre>
    );
  }, [result, isDark, theme.textDim, theme.fontMono]);

  if (!monacoReady) return <div style={{ padding: 16, color: theme.textMuted, fontSize: 12 }}>Loading editor...</div>;

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: theme.bg }}>
      {/* Left: CX Editor */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, borderRight: `0.5px solid ${theme.borderSubtle}` }}>
        <div style={{
          height: 32, display: "flex", alignItems: "center", padding: "0 12px", gap: 8,
          borderBottom: `0.5px solid ${theme.borderSubtle}`,
          background: theme.bgPanel,
        }}>
          <Terminal size={13} color={theme.accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: theme.textDim }}>CX Playground</span>
          <span style={{ fontSize: 10, color: theme.textFaint }}>(.cx)</span>
          <div style={{ flex: 1 }} />
          <span style={{
            fontSize: 9, padding: "2px 8px", borderRadius: 10,
            background: error ? (isDark ? "rgba(241,76,76,0.12)" : "rgba(205,49,49,0.06)") : (isDark ? "rgba(78,200,107,0.12)" : "rgba(56,138,52,0.06)"),
            color: error ? theme.error : theme.success,
          }}>
            {error ? "error" : "live"}
          </span>
        </div>
        <div style={{ flex: 1 }}>
          <Editor
            height="100%"
            language="cx"
            theme={isDark ? "vs-dark" : "vs"}
            value={code}
            onChange={handleChange}
            beforeMount={handleBeforeMount}
            options={editorOptions}
          />
        </div>
      </div>

      {/* Right: Live Preview */}
      <div style={{ width: 360, display: "flex", flexDirection: "column", minWidth: 280 }}>
        <div style={{
          height: 32, display: "flex", alignItems: "center", padding: "0 8px", gap: 4,
          borderBottom: `0.5px solid ${theme.borderSubtle}`,
          background: theme.bgPanel,
        }}>
          <button onClick={() => setActivePreview("output")} style={previewTabStyle(activePreview === "output")}>
            <Play size={10} style={{ marginRight: 3, display: "inline" }} /> Output
          </button>
          <button onClick={() => setActivePreview("vars")} style={previewTabStyle(activePreview === "vars")}>
            <Table2 size={10} style={{ marginRight: 3, display: "inline" }} /> Variables
          </button>
          <button onClick={() => setActivePreview("ast")} style={previewTabStyle(activePreview === "ast")}>
            <FileText size={10} style={{ marginRight: 3, display: "inline" }} /> AST
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {errorDisplay}
          {activePreview === "output" && outputPanel}
          {activePreview === "vars" && varsPanel}
          {activePreview === "ast" && astPanel}
        </div>
      </div>
    </div>
  );
}
