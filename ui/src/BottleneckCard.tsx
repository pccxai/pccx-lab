import { useEffect, useState, useCallback, useMemo, memo } from "react";
import { useTheme } from "./ThemeContext";
import { Zap, AlertTriangle } from "lucide-react";

interface BottleneckInterval {
  kind:        "dma_read" | "dma_write" | "systolic_stall" | "barrier_sync";
  start_cycle: number;
  end_cycle:   number;
  share:       number;
  event_count: number;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; intervals: BottleneckInterval[] }
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

const KIND_LABEL: Record<BottleneckInterval["kind"], string> = {
  dma_read:       "DMA read",
  dma_write:      "DMA write",
  systolic_stall: "Systolic stall",
  barrier_sync:   "Barrier sync",
};

const MAX_VISIBLE_ROWS = 12;

/** Compact card: top-N bottleneck windows from detect_bottlenecks IPC. */
export const BottleneckCard = memo(function BottleneckCard() {
  const theme = useTheme();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const kindColor = useMemo<Record<BottleneckInterval["kind"], string>>(() => ({
    dma_read:       theme.success,
    dma_write:      theme.warning,
    systolic_stall: theme.accent,
    barrier_sync:   theme.error,
  }), [theme.success, theme.warning, theme.accent, theme.error]);

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const intervals = await tauriInvoke<BottleneckInterval[]>(
        "detect_bottlenecks",
        {}
      );
      setStatus({ kind: "ok", intervals });
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

  const visibleIntervals = useMemo(() => {
    if (status.kind !== "ok") return [];
    return status.intervals.slice(0, MAX_VISIBLE_ROWS);
  }, [status]);

  const overflowCount = useMemo(() => {
    if (status.kind !== "ok") return 0;
    return Math.max(0, status.intervals.length - MAX_VISIBLE_ROWS);
  }, [status]);

  return (
    <div className="flex flex-col gap-3 p-4" style={cardStyle}>
      <div className="flex items-center gap-2">
        <Zap size={16} style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Bottleneck Windows</span>
        <div className="ml-auto">
          <button
            onClick={load}
            disabled={status.kind === "loading"}
            className="px-2 py-0.5 text-[11px]"
            style={buttonStyle}
          >
            {status.kind === "loading" ? "Scanning…" : "Reload"}
          </button>
        </div>
      </div>

      {status.kind === "idle" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>Idle.</div>
      )}

      {status.kind === "loading" && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          Scanning for contended windows…
        </div>
      )}

      {status.kind === "error" && (
        <div className="flex items-start gap-2" style={{ fontSize: 12 }}>
          <AlertTriangle size={14} style={{ color: theme.error, marginTop: 2 }} />
          <span style={{ color: theme.error }}>{status.message}</span>
        </div>
      )}

      {status.kind === "ok" && visibleIntervals.length === 0 && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          No windows cross the default 50% threshold -- nothing to flag.
        </div>
      )}

      {status.kind === "ok" && visibleIntervals.length > 0 && (
        <table style={{ fontSize: 11, width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: theme.textMuted, borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
              <th className="p-1 text-left">Window</th>
              <th className="p-1 text-left">Class</th>
              <th className="p-1 text-right">Share</th>
              <th className="p-1 text-right">Events</th>
            </tr>
          </thead>
          <tbody>
            {visibleIntervals.map((b, i) => (
              <tr key={i} style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
                <td className="p-1 font-mono" style={{ color: theme.text }}>
                  {b.start_cycle.toLocaleString()} – {b.end_cycle.toLocaleString()}
                </td>
                <td className="p-1">
                  <span
                    className="px-2 py-0.5 text-[10px] font-semibold"
                    style={{
                      color: kindColor[b.kind],
                      border: `0.5px solid ${kindColor[b.kind]}`,
                      borderRadius: theme.radiusSm,
                    }}
                  >
                    {KIND_LABEL[b.kind]}
                  </span>
                </td>
                <td className="p-1 text-right">{(b.share * 100).toFixed(0)}%</td>
                <td className="p-1 text-right">{b.event_count.toLocaleString()}</td>
              </tr>
            ))}
            {overflowCount > 0 && (
              <tr>
                <td colSpan={4} style={{ fontSize: 10, color: theme.textMuted, padding: 4 }}>
                  +{overflowCount.toLocaleString()} more windows…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
});
