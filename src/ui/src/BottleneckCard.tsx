import { useEffect, useState } from "react";
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

const KIND_COLOR: Record<BottleneckInterval["kind"], string> = {
  dma_read:       "#6a9955",
  dma_write:      "#dcdcaa",
  systolic_stall: "#c586c0",
  barrier_sync:   "#f14c4c",
};

const KIND_LABEL: Record<BottleneckInterval["kind"], string> = {
  dma_read:       "DMA read",
  dma_write:      "DMA write",
  systolic_stall: "Systolic stall",
  barrier_sync:   "Barrier sync",
};

/**
 * Table of bottleneck intervals surfaced by the detect_bottlenecks IPC.
 * Re-runs whenever a new trace is loaded.
 */
export function BottleneckCard() {
  const theme = useTheme();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const load = async () => {
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
  };

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(m => m.listen("trace-loaded", () => { void load(); }))
      .then(fn => { unlisten = fn; })
      .catch(() => { /* browser preview */ });
    return () => { unlisten?.(); };
  }, []);

  return (
    <div
      className="flex flex-col gap-3 p-4 rounded-md"
      style={{ background: theme.bgSurface, border: `1px solid ${theme.border}`, minWidth: 320 }}
    >
      <div className="flex items-center gap-2">
        <Zap size={16} style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Bottleneck Windows</span>
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

      {status.kind === "ok" && status.intervals.length === 0 && (
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          No windows cross the default 50% threshold — nothing to flag.
        </div>
      )}

      {status.kind === "ok" && status.intervals.length > 0 && (
        <table style={{ fontSize: 11, width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
              <th className="p-1 text-left">Window</th>
              <th className="p-1 text-left">Class</th>
              <th className="p-1 text-right">Share</th>
              <th className="p-1 text-right">Events</th>
            </tr>
          </thead>
          <tbody>
            {status.intervals.slice(0, 12).map((b, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${theme.borderDim}` }}>
                <td className="p-1 font-mono" style={{ color: theme.text }}>
                  {b.start_cycle.toLocaleString()} – {b.end_cycle.toLocaleString()}
                </td>
                <td className="p-1">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-semibold"
                    style={{
                      color: KIND_COLOR[b.kind],
                      border: `1px solid ${KIND_COLOR[b.kind]}`,
                    }}
                  >
                    {KIND_LABEL[b.kind]}
                  </span>
                </td>
                <td className="p-1 text-right">{(b.share * 100).toFixed(0)}%</td>
                <td className="p-1 text-right">{b.event_count}</td>
              </tr>
            ))}
            {status.intervals.length > 12 && (
              <tr>
                <td colSpan={4} style={{ fontSize: 10, color: theme.textMuted, padding: 4 }}>
                  +{status.intervals.length - 12} more windows…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
