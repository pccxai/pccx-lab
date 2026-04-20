import { useEffect, useState } from "react";
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

/**
 * A compact card that re-runs `analyze_roofline` whenever a new trace is
 * loaded and surfaces the arithmetic-intensity / compute-vs-memory
 * classification. Designed to sit alongside SynthStatusCard in the
 * Verification -> Synth Status tab.
 */
export function RooflineCard() {
  const theme = useTheme();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const load = async () => {
    setStatus({ kind: "loading" });
    try {
      const point = await tauriInvoke<RooflinePoint>("analyze_roofline", {});
      setStatus({ kind: "ok", point });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  useEffect(() => {
    void load();
    // React to future trace loads via the native Tauri event bus. The
    // dynamic import keeps the file happy in the Vite browser preview
    // where @tauri-apps/api/event still resolves but listen() throws.
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(m => m.listen("trace-loaded", () => { void load(); }))
      .then(fn => { unlisten = fn; })
      .catch(() => { /* browser preview — no event bus */ });
    return () => {
      unlisten?.();
    };
  }, []);

  const formatNumber = (v: number, digits = 2) =>
    Number.isFinite(v) ? v.toFixed(digits) : "∞";

  return (
    <div
      className="flex flex-col gap-3 p-4 rounded-md"
      style={{ background: theme.bgSurface, border: `1px solid ${theme.border}`, minWidth: 320 }}
    >
      <div className="flex items-center gap-2">
        <TrendingUp size={16} style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Roofline Analysis</span>
        <div className="ml-auto">
          <button
            onClick={load}
            disabled={status.kind === "loading"}
            className="px-2 py-0.5 text-[11px] rounded"
            style={{
              background: theme.accentBg,
              color: theme.accent,
              border: `1px solid ${theme.border}`,
              cursor: status.kind === "loading" ? "wait" : "pointer",
            }}
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

      {status.kind === "ok" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div
              className="flex flex-col gap-0.5 px-3 py-2 rounded"
              style={{ background: theme.bg, border: `1px solid ${theme.border}` }}
            >
              <span style={{ fontSize: 10, color: theme.textMuted }}>AI (ops/byte)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {formatNumber(status.point.arithmetic_intensity)}
              </span>
            </div>
            <div
              className="flex flex-col gap-0.5 px-3 py-2 rounded"
              style={{ background: theme.bg, border: `1px solid ${theme.border}` }}
            >
              <span style={{ fontSize: 10, color: theme.textMuted }}>Achieved (GOPS)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {formatNumber(status.point.achieved_gops)}
              </span>
            </div>
            <div
              className="flex flex-col gap-0.5 px-3 py-2 rounded"
              style={{ background: theme.bg, border: `1px solid ${theme.border}` }}
            >
              <span style={{ fontSize: 10, color: theme.textMuted }}>Peak compute (GOPS)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {formatNumber(status.point.peak_gops, 0)}
              </span>
            </div>
            <div
              className="flex flex-col gap-0.5 px-3 py-2 rounded"
              style={{ background: theme.bg, border: `1px solid ${theme.border}` }}
            >
              <span style={{ fontSize: 10, color: theme.textMuted }}>Peak BW (GB/s)</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>
                {formatNumber(status.point.peak_bw_gbps, 1)}
              </span>
            </div>
          </div>

          <div
            className="flex items-center gap-2 px-3 py-2 rounded"
            style={{
              background: status.point.compute_bound
                ? "rgba(78,200,107,0.10)"
                : "rgba(229,164,0,0.12)",
              border: `1px solid ${status.point.compute_bound ? theme.success : theme.warning}`,
            }}
          >
            {status.point.compute_bound ? (
              <CheckCircle2 size={14} style={{ color: theme.success }} />
            ) : (
              <AlertTriangle size={14} style={{ color: theme.warning }} />
            )}
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {status.point.compute_bound ? "Compute-bound" : "Memory-bound"}
            </span>
            <span className="ml-auto" style={{ fontSize: 11, color: theme.textMuted }}>
              {status.point.mac_cycles.toLocaleString()} MAC cycles ·
              {" "}{status.point.dma_bytes_estimate.toLocaleString()} B DMA
            </span>
          </div>
        </>
      )}
    </div>
  );
}
