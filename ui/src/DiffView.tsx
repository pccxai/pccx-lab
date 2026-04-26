import { useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useTheme } from "./ThemeContext";
import { ensureMonacoReady } from "./monacoSetup";

interface DiffViewProps {
  original: string;
  modified: string;
  originalTitle?: string;
  modifiedTitle?: string;
  language?: string;
}

export function DiffView({ original, modified, originalTitle, modifiedTitle, language = "systemverilog" }: DiffViewProps) {
  const theme = useTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureMonacoReady().then(() => setReady(true));
  }, []);

  if (!ready) {
    return <div style={{ padding: 24, color: theme.textMuted }}>Loading diff view...</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      <div style={{
        display: "flex",
        height: 28,
        alignItems: "center",
        borderBottom: `0.5px solid ${theme.borderSubtle}`,
        background: theme.bgPanel,
        fontSize: 11,
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, padding: "0 12px", color: theme.textMuted }}>
          {originalTitle || "Original"}
        </div>
        <div style={{ width: 1, height: "100%", background: theme.border }} />
        <div style={{ flex: 1, padding: "0 12px", color: theme.accent }}>
          {modifiedTitle || "Modified"}
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          theme={theme.mode === "dark" ? "vs-dark" : "vs"}
          options={{
            readOnly: true,
            renderSideBySide: true,
            fontSize: 13,
            fontFamily: theme.fontMono,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
        />
      </div>
    </div>
  );
}
