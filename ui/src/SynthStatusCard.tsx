import { useEffect, useState, useCallback, useMemo, memo } from "react";
import { useTheme } from "./ThemeContext";
import { Cpu, Timer, CheckCircle2, AlertTriangle } from "lucide-react";

export interface SynthReport {
  utilisation: {
    top_module: string;
    total_luts: number;
    logic_luts: number;
    ffs: number;
    rams_36: number;
    rams_18: number;
    urams: number;
    dsps: number;
  };
  timing: {
    wns_ns: number;
    tns_ns: number;
    failing_endpoints: number;
    total_endpoints: number;
    is_timing_met: boolean;
    worst_clock: string;
  };
  device: string;
}

/** Mirrors `pccx_core::vivado_timing::TimingReport` across the Tauri bridge. */
export interface TimingReport {
  wns_ns:             number;
  tns_ns:             number;
  failing_endpoints:  number;
  clock_domains:      ClockDomain[];
}

export interface ClockDomain {
  name:       string;
  wns_ns:     number;
  tns_ns:     number;
  period_ns:  number;
}

interface Props {
  utilizationPath: string;
  timingPath: string;
  autoLoad?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; report: SynthReport }
  | { kind: "error"; message: string };

function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const w = window as unknown as {
    __TAURI__?: {
      core?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T> };
      invoke?: (cmd: string, args: Record<string, unknown>) => Promise<T>;
    };
  };
  const bridge = w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke;
  if (!bridge) {
    return Promise.reject(new Error("Tauri IPC not available (browser-only build)"));
  }
  return bridge(cmd, args);
}

// Memoized stat cell to avoid re-renders when sibling cells change
const Stat = memo(function Stat(
  { label, value, style }: { label: string; value: string; style: React.CSSProperties },
) {
  const theme = useTheme();
  return (
    <div
      className="flex flex-col items-center justify-center px-3 py-2"
      style={style}
    >
      <span style={{ fontSize: 10, color: theme.textMuted, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginTop: 2 }}>{value}</span>
    </div>
  );
});

export const SynthStatusCard = memo(function SynthStatusCard(
  { utilizationPath, timingPath, autoLoad = true }: Props,
) {
  const theme = useTheme();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [timing, setTiming] = useState<TimingReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    setErr(null);
    try {
      const report = await tauriInvoke<SynthReport>("load_synth_report", {
        utilizationPath,
        timingPath,
      });
      setStatus({ kind: "ok", report });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      setErr(String(e));
    }
  }, [utilizationPath, timingPath]);

  useEffect(() => {
    if (autoLoad) void load();
  }, [load, autoLoad]);

  useEffect(() => {
    if (!autoLoad || !timingPath) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await tauriInvoke<TimingReport>("load_timing_report", {
          path: timingPath,
        });
        if (!cancelled) setTiming(t);
      } catch (e) {
        if (!cancelled) {
          setTiming(null);
          setErr(String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [timingPath, autoLoad]);

  // -- Memoized styles --

  const cardStyle = useMemo(() => ({
    background: theme.bgSurface,
    border: `0.5px solid ${theme.borderSubtle}`,
    borderRadius: theme.radiusMd,
    boxShadow: theme.shadowSm,
    minWidth: 320,
    transition: `box-shadow 0.2s ${theme.ease}`,
  }), [theme.bgSurface, theme.borderSubtle, theme.radiusMd, theme.shadowSm, theme.ease]);

  const buttonStyle = useMemo(() => ({
    background: theme.accentBg,
    color: theme.accent,
    border: `0.5px solid ${theme.borderSubtle}`,
    borderRadius: theme.radiusSm,
    cursor: status.kind === "loading" ? "wait" as const : "pointer" as const,
    transition: `background 0.15s ${theme.ease}`,
  }), [theme.accentBg, theme.accent, theme.borderSubtle, theme.radiusSm, theme.ease, status.kind]);

  const statCellStyle = useMemo(() => ({
    background: theme.bg,
    border: `0.5px solid ${theme.borderSubtle}`,
    borderRadius: theme.radiusSm,
  }), [theme.bg, theme.borderSubtle, theme.radiusSm]);

  // Formatted utilization stats
  const statEntries = useMemo(() => {
    if (status.kind !== "ok") return [];
    const u = status.report.utilisation;
    const t = status.report.timing;
    return [
      { label: "LUT",       value: u.total_luts.toLocaleString() },
      { label: "FF",        value: u.ffs.toLocaleString() },
      { label: "RAMB36",    value: u.rams_36.toLocaleString() },
      { label: "RAMB18",    value: u.rams_18.toLocaleString() },
      { label: "URAM",      value: u.urams.toLocaleString() },
      { label: "DSP",       value: u.dsps.toLocaleString() },
      { label: "Logic",     value: u.logic_luts.toLocaleString() },
      { label: "Endpoints", value: t.total_endpoints.toLocaleString() },
    ];
  }, [status]);

  const timingBannerStyle = useMemo(() => {
    if (status.kind !== "ok") return {};
    const met = status.report.timing.is_timing_met;
    return {
      background: met ? theme.successBg : theme.errorBg,
      border: `0.5px solid ${met ? theme.success : theme.error}`,
      borderRadius: theme.radiusSm,
    };
  }, [status, theme.successBg, theme.errorBg, theme.success, theme.error, theme.radiusSm]);

  // Per-clock-domain structured timing section
  const timingSectionStyle = useMemo(() => ({
    borderTop: `0.5px solid ${theme.borderSubtle}`,
  }), [theme.borderSubtle]);

  return (
    <div className="flex flex-col gap-3 p-4" style={cardStyle}>
      <div className="flex items-center gap-2">
        <Cpu size={16} style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Synthesis Status</span>
        <div className="ml-auto">
          <button
            onClick={load}
            disabled={status.kind === "loading"}
            className="px-2 py-0.5 text-[11px]"
            style={buttonStyle}
          >
            {status.kind === "loading" ? "Loading…" : "Reload"}
          </button>
        </div>
      </div>

      {status.kind === "idle" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Not loaded.</div>
      )}

      {status.kind === "loading" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Loading synth reports…</div>
      )}

      {status.kind === "error" && (
        <div className="flex items-start gap-2" style={{ fontSize: 12 }}>
          <AlertTriangle size={14} style={{ color: theme.error, marginTop: 2 }} />
          <span style={{ color: theme.error }}>{err ?? status.message}</span>
        </div>
      )}

      {status.kind === "ok" && (
        <>
          <div className="flex items-center gap-2" style={{ fontSize: 11, color: theme.textMuted }}>
            <span>Top: <strong style={{ color: theme.text }}>{status.report.utilisation.top_module}</strong></span>
            <span>·</span>
            <span>Device: <strong style={{ color: theme.text }}>{status.report.device || "—"}</strong></span>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {statEntries.map(s => (
              <Stat key={s.label} label={s.label} value={s.value} style={statCellStyle} />
            ))}
          </div>

          <div className="flex items-center gap-2 px-3 py-2" style={timingBannerStyle}>
            {status.report.timing.is_timing_met ? (
              <CheckCircle2 size={16} style={{ color: theme.success }} />
            ) : (
              <AlertTriangle size={16} style={{ color: theme.error }} />
            )}
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>
              {status.report.timing.is_timing_met ? "Timing met" : "Timing NOT met"}
            </span>
            <span className="ml-auto" style={{ fontSize: 11, color: theme.textMuted }}>
              <Timer size={10} className="inline mr-1" />
              WNS {status.report.timing.wns_ns.toFixed(3)} ns
              {status.report.timing.worst_clock && ` on ${status.report.timing.worst_clock}`}
              {!status.report.timing.is_timing_met &&
                ` · ${status.report.timing.failing_endpoints.toLocaleString()} failing`}
            </span>
          </div>
        </>
      )}

      {timing && (
        <div className="flex flex-col gap-2 pt-2" style={timingSectionStyle}>
          <div className="flex items-center gap-2" style={{ fontSize: 11, color: theme.textMuted }}>
            <Timer size={12} style={{ color: theme.accent }} />
            <strong style={{ color: theme.text, fontSize: 12 }}>Timing Report</strong>
            <span className="ml-auto">
              <span style={{ color: timing.wns_ns < 0 ? theme.error : theme.success, fontWeight: 600 }}>
                WNS {timing.wns_ns.toFixed(3)} ns
              </span>
              <span style={{ margin: "0 6px", color: theme.textFaint }}>·</span>
              <span style={{ color: timing.tns_ns < 0 ? theme.error : theme.success, fontWeight: 600 }}>
                TNS {timing.tns_ns.toFixed(3)} ns
              </span>
              <span style={{ margin: "0 6px", color: theme.textFaint }}>·</span>
              <span style={{ color: timing.failing_endpoints > 0 ? theme.error : theme.textMuted }}>
                {timing.failing_endpoints.toLocaleString()} failing
              </span>
            </span>
          </div>
          {timing.clock_domains.length > 0 && (
            <table style={{ fontSize: 11, width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: theme.textMuted, textAlign: "left" }}>
                  <th style={{ padding: "2px 6px", fontWeight: 500 }}>Clock</th>
                  <th style={{ padding: "2px 6px", fontWeight: 500, textAlign: "right" }}>Period</th>
                  <th style={{ padding: "2px 6px", fontWeight: 500, textAlign: "right" }}>WNS</th>
                  <th style={{ padding: "2px 6px", fontWeight: 500, textAlign: "right" }}>TNS</th>
                </tr>
              </thead>
              <tbody>
                {timing.clock_domains.map(c => (
                  <tr key={c.name} style={{ borderTop: `0.5px solid ${theme.borderSubtle}` }}>
                    <td style={{ padding: "2px 6px", color: theme.text }}>{c.name}</td>
                    <td style={{ padding: "2px 6px", textAlign: "right", color: theme.textDim }}>
                      {c.period_ns.toFixed(3)} ns
                    </td>
                    <td style={{ padding: "2px 6px", textAlign: "right",
                                  color: c.wns_ns < 0 ? theme.error : theme.textDim }}>
                      {c.wns_ns.toFixed(3)}
                    </td>
                    <td style={{ padding: "2px 6px", textAlign: "right",
                                  color: c.tns_ns < 0 ? theme.error : theme.textDim }}>
                      {c.tns_ns.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
});
