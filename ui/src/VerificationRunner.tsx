import { useState } from "react";
import { useTheme } from "./ThemeContext";
import { PlayCircle, CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react";

interface TbResult {
  name: string;
  verdict: "PASS" | "FAIL";
  cycles: number;
  pccx_path: string | null;
}

interface VerificationSummary {
  testbenches: TbResult[];
  synth_timing_met: boolean | null;
  synth_status: string;
  stdout: string;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; summary: VerificationSummary }
  | { kind: "error"; message: string };

interface Props {
  repoPath: string;
}

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

export function VerificationRunner({ repoPath }: Props) {
  const theme = useTheme();
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [lastOpened, setLastOpened] = useState<string | null>(null);

  const run = async () => {
    setState({ kind: "running" });
    try {
      const summary = await tauriInvoke<VerificationSummary>("run_verification", {
        repoPath,
      });
      setState({ kind: "ok", summary });
    } catch (err) {
      setState({ kind: "error", message: String(err) });
    }
  };

  const openInTimeline = async (path: string) => {
    try {
      await tauriInvoke("load_pccx", { path });
      setLastOpened(path);
    } catch (err) {
      console.error("load_pccx failed", err);
    }
  };

  const isRunning = state.kind === "running";
  const passCount = state.kind === "ok"
    ? state.summary.testbenches.filter(t => t.verdict === "PASS").length
    : 0;
  const failCount = state.kind === "ok"
    ? state.summary.testbenches.filter(t => t.verdict === "FAIL").length
    : 0;
  const allPassed = state.kind === "ok" && failCount === 0 && passCount > 0;

  return (
    <div
      className="flex flex-col gap-3 p-4 rounded-md"
      style={{ background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, minWidth: 320 }}
    >
      <div className="flex items-center gap-2">
        <PlayCircle size={16} style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>Run Verification Suite</span>
        <div className="ml-auto">
          <button
            onClick={run}
            disabled={isRunning}
            className="flex items-center gap-2 px-3 py-1 text-[11px] rounded font-semibold"
            style={{
              background: isRunning ? theme.bgHover : theme.success,
              color: isRunning ? theme.textMuted : "#ffffff",
              cursor: isRunning ? "wait" : "pointer",
              border: "none",
            }}
          >
            {isRunning
              ? (<><Loader2 size={12} className="animate-spin" /> Running…</>)
              : (<><PlayCircle size={12} /> Run</>)}
          </button>
        </div>
      </div>

      <p style={{ fontSize: 11, color: theme.textMuted }}>
        Executes <code>hw/sim/run_verification.sh</code> in
        <code style={{ marginLeft: 4 }}>{repoPath}</code>
        and parses the emitted PASS / FAIL lines plus the synth verdict.
      </p>

      {state.kind === "error" && (
        <div
          className="px-3 py-2 rounded"
          style={{
            background: "rgba(241,76,76,0.12)",
            border: `0.5px solid ${theme.error}`,
            color: theme.text,
            fontSize: 12,
          }}
        >
          <strong>Error:</strong> {state.message}
        </div>
      )}

      {state.kind === "ok" && (
        <>
          <div
            className="flex items-center gap-2 px-3 py-2 rounded"
            style={{
              background: allPassed
                ? "rgba(78,200,107,0.10)"
                : "rgba(241,76,76,0.12)",
              border: `0.5px solid ${allPassed ? theme.success : theme.error}`,
            }}
          >
            {allPassed
              ? <CheckCircle2 size={14} style={{ color: theme.success }} />
              : <XCircle size={14} style={{ color: theme.error }} />}
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {passCount} pass / {failCount} fail ({state.summary.testbenches.length} testbenches)
            </span>
            <span className="ml-auto" style={{ fontSize: 11, color: theme.textMuted }}>
              Synth: {state.summary.synth_timing_met === true
                ? "met"
                : state.summary.synth_timing_met === false
                  ? "NOT met"
                  : "—"}
            </span>
          </div>

          <table style={{ fontSize: 11, width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{
                color: theme.textMuted,
                borderBottom: `0.5px solid ${theme.borderSubtle}`,
              }}>
                <th className="p-1 text-left">Testbench</th>
                <th className="p-1 text-right">Cycles</th>
                <th className="p-1 text-center">Status</th>
                <th className="p-1 text-center">Trace</th>
              </tr>
            </thead>
            <tbody>
              {state.summary.testbenches.map((tb) => (
                <tr key={tb.name} style={{ borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
                  <td className="p-1 font-mono" style={{ color: theme.text }}>{tb.name}</td>
                  <td className="p-1 text-right">{tb.cycles.toLocaleString()}</td>
                  <td className="p-1 text-center">
                    <span
                      className="px-2 py-0.5 rounded text-[10px] font-bold"
                      style={{
                        color: tb.verdict === "PASS" ? theme.success : theme.error,
                        border: `0.5px solid ${tb.verdict === "PASS" ? theme.success : theme.error}`,
                      }}
                    >
                      {tb.verdict}
                    </span>
                  </td>
                  <td className="p-1 text-center">
                    {tb.pccx_path ? (
                      <button
                        onClick={() => openInTimeline(tb.pccx_path!)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px]"
                        style={{
                          color: lastOpened === tb.pccx_path ? theme.success : theme.accent,
                          border: `0.5px solid ${lastOpened === tb.pccx_path ? theme.success : theme.accent}`,
                          background: "transparent",
                          cursor: "pointer",
                        }}
                        title={`Load ${tb.pccx_path} into Timeline`}
                      >
                        <ExternalLink size={10} />
                        {lastOpened === tb.pccx_path ? "Loaded" : "Open"}
                      </button>
                    ) : (
                      <span style={{ color: theme.textMuted }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
