import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";

import { useTheme } from "./ThemeContext";
import type { LabStatus, ThemeTokenContract } from "./labStatus";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: LabStatus; themeContract: ThemeTokenContract };

function StatusBadge({ value }: { value: string }) {
  const theme = useTheme();
  const color =
    value.includes("available") || value.includes("ready") || value.includes("thin")
      ? theme.success
      : value.includes("not-") || value.includes("placeholder")
        ? theme.warning
        : theme.accent;

  return (
    <span
      style={{
        color,
        border: `0.5px solid ${color}`,
        borderRadius: theme.radiusSm,
        fontFamily: theme.fontMono,
        fontSize: 10,
        lineHeight: "16px",
        padding: "0 6px",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </span>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "96px minmax(0, 1fr)",
        gap: 8,
        padding: "5px 0",
        borderBottom: `0.5px solid ${theme.borderSubtle}`,
      }}
    >
      <span style={{ color: theme.textMuted }}>{label}</span>
      <span
        style={{
          color: theme.text,
          fontFamily: theme.fontMono,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          color: theme.textMuted,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0,
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

export function LabStatusPanel() {
  const theme = useTheme();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [status, themeContract] = await Promise.all([
        invoke<LabStatus>("lab_status"),
        invoke<ThemeTokenContract>("theme_contract"),
      ]);
      setState({ kind: "ready", status, themeContract });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const content = useMemo(() => {
    if (state.kind === "loading") {
      return <span style={{ color: theme.textMuted }}>Loading status...</span>;
    }

    if (state.kind === "error") {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: theme.warning }}>
            <AlertTriangle size={14} />
            <span>Status unavailable</span>
          </div>
          <span style={{ color: theme.textFaint, wordBreak: "break-word" }}>{state.message}</span>
        </div>
      );
    }

    const { status, themeContract } = state;

    return (
      <>
        <Section title="Boundary">
          <FieldRow label="schema" value={status.schemaVersion} />
          <FieldRow label="mode" value={status.labMode} />
          <FieldRow label="source" value={status.guiState.statusSource} />
          <FieldRow label="theme" value={themeContract.schemaVersion} />
        </Section>

        <Section title="Workspace">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusBadge value={status.workspaceState.state} />
            <span style={{ color: theme.textMuted }}>
              trace loaded: {status.workspaceState.traceLoaded ? "yes" : "no"}
            </span>
          </div>
          <span style={{ color: theme.textFaint, lineHeight: 1.5 }}>{status.workspaceState.note}</span>
        </Section>

        <Section title="Workflows">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {status.availableWorkflows.map((workflow) => (
              <div
                key={workflow.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 8,
                  alignItems: "center",
                  paddingBottom: 6,
                  borderBottom: `0.5px solid ${theme.borderSubtle}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: theme.text, fontSize: 11 }}>{workflow.label}</div>
                  <div
                    title={workflow.boundary}
                    style={{
                      color: theme.textFaint,
                      fontFamily: theme.fontMono,
                      fontSize: 10,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {workflow.boundary}
                  </div>
                </div>
                <StatusBadge value={workflow.status} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Theme Presets">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {themeContract.presets.map((preset) => (
              <span
                key={preset.name}
                style={{
                  border: `0.5px solid ${theme.borderSubtle}`,
                  borderRadius: theme.radiusSm,
                  color: theme.textMuted,
                  fontFamily: theme.fontMono,
                  fontSize: 10,
                  padding: "2px 6px",
                }}
              >
                {preset.name}
              </span>
            ))}
          </div>
        </Section>

        <Section title="Evidence">
          <FieldRow label="hardware" value={status.evidenceState.hardwareProbe} />
          <FieldRow label="timing" value={status.evidenceState.timingClosure} />
          <FieldRow label="inference" value={status.evidenceState.inference} />
          <FieldRow label="throughput" value={status.evidenceState.throughput} />
        </Section>

        <Section title="Limits">
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {status.limitations.map((item) => (
              <div key={item} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                <ShieldCheck size={12} style={{ color: theme.textMuted, marginTop: 2, flexShrink: 0 }} />
                <span style={{ color: theme.textMuted, lineHeight: 1.45 }}>{item}</span>
              </div>
            ))}
          </div>
        </Section>
      </>
    );
  }, [state, theme]);

  return (
    <div
      className="h-full min-h-0 overflow-y-auto"
      style={{
        background: theme.bg,
        color: theme.text,
        display: "flex",
        flexDirection: "column",
        fontSize: 11,
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: `0.5px solid ${theme.borderSubtle}`,
          display: "flex",
          gap: 8,
          justifyContent: "space-between",
          padding: "8px 10px",
        }}
      >
        <span style={{ color: theme.text, fontWeight: 700 }}>Lab Status</span>
        <button
          onClick={load}
          title="Reload status"
          style={{
            alignItems: "center",
            background: "transparent",
            border: `0.5px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            color: theme.textMuted,
            cursor: "pointer",
            display: "inline-flex",
            height: 22,
            justifyContent: "center",
            width: 24,
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 10 }}>
        {content}
      </div>
    </div>
  );
}
