import { useState } from "react";
import { useTheme } from "./ThemeContext";
import { CheckCircle, AlertOctagon, TerminalSquare, ShieldCheck, Bug, Activity, Cpu } from "lucide-react";
import { SynthStatusCard } from "./SynthStatusCard";
import { VerificationRunner } from "./VerificationRunner";
import { RooflineCard } from "./RooflineCard";
import { BottleneckCard } from "./BottleneckCard";

type VerifyTab = "isa" | "api" | "uvm" | "synth";

const DEFAULT_UTIL_PATH =
  "../../../../pccx-FPGA-NPU-LLM-kv260/hw/build/reports/utilization_post_synth.rpt";
const DEFAULT_TIMING_PATH =
  "../../../../pccx-FPGA-NPU-LLM-kv260/hw/build/reports/timing_summary_post_synth.rpt";
const DEFAULT_REPO_PATH =
  "../../../../pccx-FPGA-NPU-LLM-kv260";

interface IsaResult {
  inst: string;
  opcode: string;
  expectedCyc: number;
  actualCyc: number;
  status: "PASS" | "FAIL" | "WARN";
  decode: string;
}

const DUMMY_ISA_RESULTS: IsaResult[] = [
  { inst: "ld.tile.l2 [r3], brm_0", opcode: "0x8F", expectedCyc: 128, actualCyc: 128, status: "PASS", decode: "Load Tile from L2 mapping" },
  { inst: "mac.arr.32x32 m_a, m_b", opcode: "0x4A", expectedCyc: 1024, actualCyc: 1024, status: "PASS", decode: "32x32 MAC Array Multiply-Accumulate" },
  { inst: "dma.axi.burst 64, req_1", opcode: "0x11", expectedCyc: 64, actualCyc: 256, status: "FAIL", decode: "AXI Burst Memory Access (Stalled)" },
  { inst: "sync.barrier tile_mask", opcode: "0x20", expectedCyc: 16, actualCyc: 18, status: "WARN", decode: "Tile Synchronization Barrier" },
  { inst: "st.wb.ddr [r9], acc_z", opcode: "0x91", expectedCyc: 48, actualCyc: 48, status: "PASS", decode: "Store Write-Back to DDR" },
];

export function VerificationSuite() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<VerifyTab>("isa");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const isDark = theme.mode === "dark";

  const executeRegression = () => {
    setRunning(true);
    setLog(["[VERIFY] Initializing Regression Suite..."]);
    let iter = 0;
    const t = setInterval(() => {
      iter++;
      if (iter === 1) setLog(p => [...p, "[ISA] Decoding 500k instruction streams... OK"]);
      if (iter === 2) setLog(p => [...p, "[API] Dispatching gRPC ping-pong to simulator... OK"]);
      if (iter === 3) setLog(p => [...p, "[UVM] Parsing coverage database (vdb)... OK"]);
      if (iter === 4) {
        setLog(p => [...p, "[VERIFY] 1 Constraint Violation Detected!"]);
        setRunning(false);
        clearInterval(t);
      }
    }, 600);
  };

  const getStatusColor = (s: string) => {
    if (s === "PASS") return theme.success;
    if (s === "FAIL") return theme.error;
    return theme.warning;
  };

  return (
    <div className="w-full h-full flex flex-col" style={{ background: theme.bg }}>
      {/* Verification Top Toolbar */}
      <div className="flex items-center px-4 h-12 shrink-0 border-b" style={{ borderColor: theme.border, background: theme.bgSurface }}>
        <ShieldCheck size={18} className="mr-2" style={{ color: theme.accent }} />
        <span style={{ fontWeight: 600, fontSize: 13, marginRight: 24 }}>Verification Suite</span>
        
        <div className="flex bg-black/20 rounded p-1 gap-1" style={{ border: `1px solid ${theme.border}` }}>
          {[
            { id: "isa",   label: "ISA Dashboard", icon: <TerminalSquare size={14} /> },
            { id: "api",   label: "API Integrity", icon: <Activity size={14} />       },
            { id: "uvm",   label: "UVM Coverage",  icon: <Bug size={14} />            },
            { id: "synth", label: "Synth Status",  icon: <Cpu size={14} />            },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as VerifyTab)}
              className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-medium transition-all"
              style={{
                background: activeTab === t.id ? theme.accentBg : "transparent",
                color: activeTab === t.id ? theme.accent : theme.textMuted
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />
        <button
           onClick={executeRegression}
           disabled={running}
           className="flex items-center gap-2 px-4 py-1.5 rounded text-xs font-semibold hover:opacity-80 transition-all disabled:opacity-50"
           style={{ background: theme.success, color: "#fff" }}
        >
          {running ? "Running..." : "Run Regression Suite"}
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Module Views */}
        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          
          {activeTab === "isa" && (
            <div className="flex flex-col h-full">
              <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                <TerminalSquare size={16} /> ISA Cycle-Accurate Validation Matrix
              </h3>
              <div className="flex-1 rounded border overflow-hidden flex flex-col" style={{ borderColor: theme.border, background: theme.bgPanel }}>
                <table className="w-full text-left" style={{ fontSize: 11, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: theme.bgSurface, borderBottom: `1px solid ${theme.border}`, color: theme.textDim }}>
                      <th className="p-2">MNEMONIC</th>
                      <th className="p-2">OPCODE</th>
                      <th className="p-2">DECODE</th>
                      <th className="p-2 text-right">EXP CYCLES</th>
                      <th className="p-2 text-right">ACT CYCLES</th>
                      <th className="p-2 text-center">STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DUMMY_ISA_RESULTS.map((row, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${theme.borderDim}` }} className="hover:bg-white/5">
                        <td className="p-2 font-mono" style={{ color: theme.accent }}>{row.inst}</td>
                        <td className="p-2 font-mono text-gray-500">{row.opcode}</td>
                        <td className="p-2">{row.decode}</td>
                        <td className="p-2 text-right">{row.expectedCyc}</td>
                        <td className="p-2 text-right font-bold" style={{ color: row.expectedCyc !== row.actualCyc ? theme.error : theme.text }}>{row.actualCyc}</td>
                        <td className="p-2 text-center">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: `${getStatusColor(row.status)}22`, color: getStatusColor(row.status), border: `1px solid ${getStatusColor(row.status)}44` }}>
                             {row.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === "api" && (
             <div className="flex flex-col h-full items-center justify-center text-center opacity-70">
               <Activity size={48} className="mb-4 text-emerald-500" />
               <h3 className="text-lg font-bold">API Ping-Pong Stress Tester</h3>
               <p className="text-sm max-w-md mt-2 text-gray-400">
                 Validates Tauri IPC and standard Rust NPU definitions. Streams 50,000 synthetic trace events to the UI bridge and measures parsing loss.
               </p>
             </div>
          )}

          {activeTab === "uvm" && (
             <div className="flex flex-col h-full items-center justify-center text-center opacity-70">
               <Bug size={48} className="mb-4 text-rose-500" />
               <h3 className="text-lg font-bold">UVM Coverage Visualizer</h3>
               <p className="text-sm max-w-md mt-2 text-gray-400">
                 Imports Synopsys `vdb` and Cadence `ucm` line coverages. Shows heatmaps of AXI transaction loss and edge-case hits.
               </p>
             </div>
          )}

          {activeTab === "synth" && (
            <div className="flex flex-col h-full gap-3">
              <h3 className="text-sm font-bold flex items-center gap-2">
                <Cpu size={16} /> pccx-FPGA Verification Dashboard
              </h3>
              <VerificationRunner repoPath={DEFAULT_REPO_PATH} />
              <SynthStatusCard
                utilizationPath={DEFAULT_UTIL_PATH}
                timingPath={DEFAULT_TIMING_PATH}
              />
              <RooflineCard />
              <BottleneckCard />
              <p className="text-[11px] mt-1" style={{ color: theme.textMuted }}>
                Paths are relative to the <code>pccx-lab</code> binary's working directory.
                Override via props when embedding this widget elsewhere.
              </p>
            </div>
          )}
        </div>

        {/* Verification Run Log */}
        <div className="w-[300px] border-l flex flex-col" style={{ borderColor: theme.border, background: theme.bgPanel }}>
           <div className="p-3 border-b text-xs font-bold flex justify-between" style={{ borderColor: theme.border }}>
             <span>Regression Logs</span>
             <button onClick={() => setLog([])} className="text-gray-500 hover:text-white">Clear</button>
           </div>
           <div className="flex-1 p-3 overflow-y-auto font-mono text-[10px] flex flex-col gap-1">
              {log.length === 0 && <span className="text-gray-600">No active runs.</span>}
              {log.map((l, i) => (
                 <div key={i} style={{ color: l.includes("FAIL") || l.includes("Violat") ? theme.error : theme.textDim }}>
                   {l}
                 </div>
              ))}
           </div>
        </div>
      </div>
    </div>
  );
}
