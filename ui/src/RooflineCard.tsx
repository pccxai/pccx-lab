import { useEffect, useState, useCallback, useMemo, memo } from "react";
import { useTheme } from "./ThemeContext";
import { TrendingUp, CheckCircle2, AlertTriangle } from "lucide-react";

interface RooflinePoint {
  arithmetic_intensity: number;
  achieved_gops:        number;
  peak_gops:            number;
  peak_bw_gbps:         number;
  compute_bound:        boolean;
  mac_cycles:           number;
  dma_bytes_estimate:   number;
  total_cycles:         number;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; point: RooflinePoint }
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

const formatNumber = (v: number, digits = 2) =>
  Number.isFinite(v) ? v.toFixed(digits) : "∞";

/** Compact roofline classification card for the dashboard. */
export const RooflineCard = memo(function RooflineCard() {
  const theme = useTheme();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const point = await tauriInvoke<RooflinePoint>("analyze_roofline", {});
      setStatus({ kind: "ok", point });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(m => m.listen("trace-loaded", () => { void load(); }))
      .then(fn => { unlisten = fn; })
      .catch(() => { /* browser preview */ });
    return () => { unlisten?.(); };
  }, [load]);

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

  const metricCellStyle = useMemo(() => ({
    background: theme.bg,
    border: `0.5px solid ${theme.borderSubtle}`,
    borderRadius: theme.radiusSm,
  }), [theme.bg, theme.borderSubtle, theme.radiusSm]);

  // Derived display values, recomputed only when the roofline point changes
  const metrics = useMemo(() => {
    if (status.kind !== "ok") return null;
    const p = status.point;
    return {
      ai:       formatNumber(p.arithmetic_intensity),
      achieved: formatNumber(p.achieved_gops),
      peak:     formatNumber(p.peak_gops, 0),
      bw:       formatNumber(p.peak_bw_gbps, 1),
      macCycles: p.mac_cycles.toLocaleString(),
      dmaBytes:  p.dma_bytes_estimate.toLocaleString(),
    };
  }, [status]);

  const boundBannerStyle = useMemo(() => {
    if (status.kind !== "ok") return {};
    const isCB = status.point.compute_bound;
    return {
      background: isCB ? theme.successBg : theme.warningBg,
      border: `0.5px solid ${isCB ? theme.success : theme.warning}`,
      borderRadius: theme.radiusSm,
    };
  }, [status, theme.successBg, theme.warningBg, theme.success, theme.warning, theme.radiusSm]);

  return (
    <div className="flex flex-col gap-3 p-4" style={cardStyle}>
      <div className="flex items-center gap-2">
        <TrendingUp size={16} style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Roofline Analysis</span>
        <div className="ml-auto">
          <button
            onClick={load}
            disabled={status.kind === "loading"}
            className="px-2 py-0.5 text-[11px]"
            style={buttonStyle}
          >
            {status.kind === "loading" ? "Analysing…" : "Reload"}
          </button>
        </div>
      </div>

      {status.kind === "idle" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Idle.</div>
      )}

      {status.kind === "loading" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          Running roofline analysis…
        </div>
      )}

      {status.kind === "error" && (
        <div className="flex items-start gap-2" style={{ fontSize: 12 }}>
          <AlertTriangle size={14} style={{ color: theme.error, marginTop: 2 }} />
          <span style={{ color: theme.error }}>{status.message}</span>
        </div>
      )}

      {status.kind === "ok" && metrics && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-0.5 px-3 py-2" style={metricCellStyle}>
              <span style={{ fontSize: 10, color: theme.textMuted }}>AI (ops/byte)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {metrics.ai}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 px-3 py-2" style={metricCellStyle}>
              <span style={{ fontSize: 10, color: theme.textMuted }}>Achieved (GOPS)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {metrics.achieved}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 px-3 py-2" style={metricCellStyle}>
              <span style={{ fontSize: 10, color: theme.textMuted }}>Peak compute (GOPS)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {metrics.peak}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 px-3 py-2" style={metricCellStyle}>
              <span style={{ fontSize: 10, color: theme.textMuted }}>Peak BW (GB/s)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {metrics.bw}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 px-3 py-2" style={boundBannerStyle}>
            {status.point.compute_bound ? (
              <CheckCircle2 size={14} style={{ color: theme.success }} />
            ) : (
              <AlertTriangle size={14} style={{ color: theme.warning }} />
            )}
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {status.point.compute_bound ? "Compute-bound" : "Memory-bound"}
            </span>
            <span className="ml-auto" style={{ fontSize: 11, color: theme.textMuted }}>
              {metrics.macCycles} MAC cycles · {metrics.dmaBytes} B DMA
            </span>
          </div>
        </>
      )}
    </div>
  );
});
