import { useState, useCallback } from "react";
import Editor from "@monaco-editor/react";
import { Play, Sparkles, TerminalSquare, X, Activity } from "lucide-react";
import { useTheme } from "./ThemeContext";
import { monarchSv, systemverilogLanguageConfig } from "./monarch_sv";

// ─── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { label: string; code: string }> = {
  uvm_driver: {
    label: "UVM Driver",
    code: `class pccx_driver extends uvm_driver #(pccx_transaction);
  \`uvm_component_utils(pccx_driver)

  virtual pccx_if vif;

  function new(string name, uvm_component parent);
    super.new(name, parent);
  endfunction

  virtual function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    if (!uvm_config_db#(virtual pccx_if)::get(this, "", "vif", vif))
      \`uvm_fatal("NO_VIF", "Virtual interface not found")
  endfunction

  virtual task run_phase(uvm_phase phase);
    forever begin
      pccx_transaction tx;
      seq_item_port.get_next_item(tx);
      drive_transaction(tx);
      seq_item_port.item_done();
    end
  endtask

  task drive_transaction(pccx_transaction tx);
    @(posedge vif.clk);
    vif.core_id    <= tx.core_id;
    vif.opcode     <= tx.opcode;
    vif.addr       <= tx.base_addr;
    vif.burst_len  <= tx.burst_len;
    vif.valid      <= 1'b1;
    @(posedge vif.clk);
    vif.valid      <= 1'b0;
  endtask
endclass`,
  },
  uvm_monitor: {
    label: "UVM Monitor",
    code: `class pccx_monitor extends uvm_monitor;
  \`uvm_component_utils(pccx_monitor)

  virtual pccx_if vif;
  uvm_analysis_port #(pccx_transaction) ap;

  function new(string name, uvm_component parent);
    super.new(name, parent);
    ap = new("ap", this);
  endfunction

  virtual task run_phase(uvm_phase phase);
    forever begin
      pccx_transaction tx = pccx_transaction::type_id::create("tx");
      @(posedge vif.clk iff vif.valid);
      tx.core_id   = vif.core_id;
      tx.opcode    = vif.opcode;
      tx.base_addr = vif.addr;
      tx.burst_len = vif.burst_len;
      ap.write(tx);
    end
  endtask
endclass`,
  },
  uvm_env: {
    label: "UVM Environment",
    code: `class pccx_env extends uvm_env;
  \`uvm_component_utils(pccx_env)

  pccx_agent    agent;
  pccx_scoreboard scoreboard;

  function new(string name, uvm_component parent);
    super.new(name, parent);
  endfunction

  virtual function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    agent      = pccx_agent::type_id::create("agent", this);
    scoreboard = pccx_scoreboard::type_id::create("scoreboard", this);
  endfunction

  virtual function void connect_phase(uvm_phase phase);
    agent.monitor.ap.connect(scoreboard.analysis_export);
  endfunction
endclass`,
  },
  dma_sequence: {
    label: "DMA Test Sequence",
    code: `class dma_burst_sequence extends uvm_sequence #(pccx_transaction);
  \`uvm_object_utils(dma_burst_sequence)

  rand int unsigned num_bursts;
  rand int unsigned base_addr;
  constraint c_default {
    num_bursts inside {[4:64]};
    base_addr  inside {[32'h1000:32'hFFFF]};
  }

  task body();
    pccx_transaction tx;
    for (int i = 0; i < num_bursts; i++) begin
      tx = pccx_transaction::type_id::create($sformatf("tx_%0d", i));
      start_item(tx);
      assert(tx.randomize() with {
        core_id   == i % 32;
        opcode    == 2'b01;  // DMA_READ
        base_addr == this.base_addr + i * 256;
        burst_len == 16;
      });
      finish_item(tx);
    end
  endtask
endclass`,
  },
  interface_def: {
    label: "NPU Interface",
    code: `interface pccx_if(input logic clk, input logic rst_n);
  // Control signals
  logic [4:0]  core_id;
  logic [1:0]  opcode;     // 00=NOP, 01=DMA_READ, 10=DMA_WRITE, 11=COMPUTE
  logic [31:0] addr;
  logic [7:0]  burst_len;
  logic        valid;
  logic        ready;

  // Data path
  logic [127:0] wdata;
  logic [127:0] rdata;
  logic         rvalid;

  // Status
  logic         busy;
  logic         done;
  logic [15:0]  cycle_count;

  // Clocking blocks
  clocking drv_cb @(posedge clk);
    output core_id, opcode, addr, burst_len, valid, wdata;
    input  ready, rdata, rvalid, busy, done;
  endclocking

  clocking mon_cb @(posedge clk);
    input core_id, opcode, addr, burst_len, valid, ready;
    input wdata, rdata, rvalid, busy, done, cycle_count;
  endclocking

  modport DRV(clocking drv_cb);
  modport MON(clocking mon_cb);
endinterface`,
  },
  scoreboard: {
    label: "Scoreboard",
    code: `class pccx_scoreboard extends uvm_scoreboard;
  \`uvm_component_utils(pccx_scoreboard)

  uvm_analysis_imp #(pccx_transaction, pccx_scoreboard) analysis_export;
  int unsigned total_transactions;
  int unsigned dma_reads, dma_writes, computes;

  function new(string name, uvm_component parent);
    super.new(name, parent);
    analysis_export = new("analysis_export", this);
  endfunction

  function void write(pccx_transaction tx);
    total_transactions++;
    case (tx.opcode)
      2'b01: dma_reads++;
      2'b10: dma_writes++;
      2'b11: computes++;
    endcase
    \`uvm_info("SCB", $sformatf("Core[%0d] op=%0b addr=0x%08x burst=%0d",
              tx.core_id, tx.opcode, tx.base_addr, tx.burst_len), UVM_MEDIUM)
  endfunction

  function void report_phase(uvm_phase phase);
    \`uvm_info("SCB", $sformatf(
      "Summary: %0d total, %0d reads, %0d writes, %0d computes",
      total_transactions, dma_reads, dma_writes, computes), UVM_LOW)
  endfunction
endclass`,
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

export function CodeEditor() {
  const theme = useTheme();
  const [activeFile, setActiveFile] = useState("interface_def");
  const [files, setFiles] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(TEMPLATES)) out[k] = v.code;
    return out;
  });

  // AI Copilot state
  const [aiBoxOpen, setAiBoxOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);

  // Simulation console state
  const [simDrawerOpen, setSimDrawerOpen] = useState(false);
  const [simLogs, setSimLogs] = useState<string[]>([]);
  const [isSimulating, setIsSimulating] = useState(false);

  const currentCode = files[activeFile] ?? "";

  const isDark = theme.mode === "dark";
  const bg      = theme.bgEditor;
  const bgAlt   = theme.bgPanel;
  const border  = theme.border;
  const lineCol = theme.textFaint;
  const kwColor = isDark ? "#c586c0" : "#7c3aed";

  const handleChange = useCallback((val: string | undefined) => {
    setFiles(f => ({ ...f, [activeFile]: val ?? "" }));
  }, [activeFile]);

  // Register the Monarch SV grammar against the Monaco instance.
  // `beforeMount` fires before the model is constructed, so the language
  // id is registered before the Editor's initial tokenize.
  //
  // Monaco ships a built-in "systemverilog" basic-language, but our
  // Monarch ruleset adds UVM type-keywords + IEEE 1800-2017 §B coverage
  // that the stock tokenizer omits. setMonarchTokensProvider overrides
  // any prior provider for the language id, so we unconditionally install
  // ours after ensuring the id is registered.
  const handleBeforeMount = useCallback((monaco: any) => {
    const langs: Array<{ id: string }> = monaco.languages.getLanguages();
    if (!langs.some(l => l.id === "systemverilog")) {
      monaco.languages.register({
        id: "systemverilog",
        extensions: [".sv", ".svh", ".v", ".vh"],
        aliases: ["SystemVerilog", "systemverilog", "sv"],
      });
    }
    monaco.languages.setMonarchTokensProvider("systemverilog", monarchSv);
    monaco.languages.setLanguageConfiguration(
      "systemverilog",
      systemverilogLanguageConfig,
    );
  }, []);

  const handleAiGenerate = async () => {
    if (!aiPrompt) return;
    setIsGenerating(true);
    await new Promise(r => setTimeout(r, 400));
    const snippet = `\n  // [AI Generated] -> "${aiPrompt}"\n  \`uvm_info("AI_COPILOT", "Traffic generator initialized.", UVM_MEDIUM)\n`;
    setFiles(f => ({ ...f, [activeFile]: f[activeFile] + snippet }));
    setAiPrompt("");
    setAiBoxOpen(false);
    setIsGenerating(false);
  };

  const runSimulation = () => {
    setSimDrawerOpen(true);
    setSimLogs([
      "Initializing Vivado XSIM engine...",
      "Compiling SystemVerilog targets...",
      "Parsing pccx_lab_uvm_env... [OK]",
      "Elaborating design for kv260 target...",
      "UVM_INFO @ 0: reporter [RNTST] Running test...",
      "UVM_INFO @ 15000: SCB [SCB] Summary: 64 total transactions",
      "Simulation finished successfully.",
      "Waveform trace saved to dump.vcd.",
    ]);
    setIsSimulating(false);
  };

  const lineCount = currentCode.split("\n").length;

  return (
    <div className="w-full h-full flex flex-col relative" style={{ background: bg }}>
      {/* ─── Toolbar ─── */}
      <div className="flex items-center overflow-x-auto shrink-0" style={{ height: 35, borderBottom: `1px solid ${border}`, background: bgAlt }}>
        {Object.entries(TEMPLATES).map(([key, { label }]) => (
          <button
            key={key}
            onClick={() => setActiveFile(key)}
            className="transition-colors duration-150"
            style={{
              fontSize: 11, padding: "0 14px", height: "100%",
              color: activeFile === key ? (isDark ? "#a78bfa" : "#6d28d9") : lineCol,
              borderBottom: activeFile === key ? `2px solid ${kwColor}` : "2px solid transparent",
              background: activeFile === key ? (isDark ? "rgba(139,92,246,0.1)" : "rgba(139,92,246,0.05)") : "transparent",
              fontWeight: activeFile === key ? 600 : 400,
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </button>
        ))}
        {Object.keys(files).filter(k => k.startsWith("gen_")).map(k => (
          <button key={k} onClick={() => setActiveFile(k)} style={{ fontSize: 11, padding: "0 14px", height: "100%", color: activeFile === k ? "#10b981" : lineCol, borderBottom: activeFile === k ? "2px solid #10b981" : "2px solid transparent", background: activeFile === k ? "rgba(16,185,129,0.1)" : "transparent", fontWeight: activeFile === k ? 600 : 400, whiteSpace: "nowrap" }}>
            {k.replace("gen_", "")}
          </button>
        ))}

        <div className="flex-1" />

        <div className="flex gap-2 pr-3">
          <button onClick={() => setAiBoxOpen(true)} className="flex items-center gap-1.5 px-3 py-1 rounded transition-all" style={{ fontSize: 11, background: isDark ? "#2a2a2a" : "#ede9fe", color: kwColor, border: `1px solid ${isDark ? "#444" : "#c4b5fd"}`, fontWeight: 600 }}>
            <Sparkles size={12} /> Ask AI
          </button>
          <button onClick={runSimulation} className="flex items-center gap-1.5 px-3 py-1 rounded transition-all hover:opacity-80" style={{ fontSize: 11, background: theme.success, color: "#fff", border: `1px solid ${theme.success}`, fontWeight: 600 }}>
            <Play size={12} fill="currentColor" /> Run SV Test
          </button>
        </div>
      </div>

      {/* ─── AI Copilot Floating Prompt ─── */}
      {aiBoxOpen && (
        <div className="absolute z-50 left-1/2 top-10 transform -translate-x-1/2 w-[400px] shadow-2xl rounded-lg overflow-hidden flex flex-col" style={{ background: theme.bgSurface, border: `1px solid ${theme.border}`, boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
           <div className="flex items-center px-3 py-2 bg-gradient-to-r from-purple-500/20 to-blue-500/20" style={{ borderBottom: `1px solid ${theme.border}` }}>
             <Sparkles size={14} color={kwColor} className="mr-2" />
             <span style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>AI Inline Generation</span>
             <div className="flex-1" />
             <button onClick={() => setAiBoxOpen(false)} style={{ color: theme.textMuted }}><X size={14} /></button>
           </div>
           <div className="p-2 flex gap-2">
             <input autoFocus value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAiGenerate()} disabled={isGenerating} placeholder="E.g., Generate a randomized AXI burst sequence..." className="flex-1 bg-transparent px-2 py-1 outline-none" style={{ fontSize: 12, color: theme.text }} />
             <button onClick={handleAiGenerate} disabled={isGenerating || !aiPrompt} className="px-3 rounded py-1" style={{ fontSize: 11, background: kwColor, color: "#fff", opacity: isGenerating ? 0.5 : 1 }}>
               {isGenerating ? "Generating..." : "Generate"}
             </button>
           </div>
        </div>
      )}

      {/* ─── Monaco Editor ─── */}
      <div className="flex-1 min-h-0 relative">
        <Editor
          height="100%"
          language="systemverilog"
          theme={isDark ? "vs-dark" : "light"}
          value={currentCode}
          onChange={handleChange}
          beforeMount={handleBeforeMount}
          options={{
            fontFamily: "JetBrains Mono, Menlo, monospace",
            fontSize: 12,
            lineNumbers: "on",
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderWhitespace: "selection",
            tabSize: 2,
            wordWrap: "off",
          }}
        />
      </div>

      {/* ─── Vivado / Simulation Terminal Drawer ─── */}
      {simDrawerOpen && (
        <div className="h-48 shrink-0 flex flex-col relative z-20" style={{ background: "#111111", borderTop: `1px solid ${theme.border}` }}>
          <div className="flex items-center px-3 py-1.5 shrink-0" style={{ background: "#1a1a1a", borderBottom: "1px solid #333 text-xs" }}>
            <TerminalSquare size={13} color={theme.success} className="mr-2" />
            <span style={{ fontSize: 11, color: "#e5e5e5", fontWeight: 600 }}>Vivado XSIM Console</span>
            <div className="flex-1" />
            {isSimulating && <Activity size={12} className="animate-spin mr-3 text-blue-400" />}
            <button onClick={() => setSimDrawerOpen(false)} style={{ color: "#888" }}><X size={14} /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 flex flex-col font-mono text-[11px]" style={{ color: "#d4d4d4", lineHeight: "1.6" }}>
            {simLogs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-gray-500">[{new Date().toISOString().split("T")[1].substring(0, 8)}]</span>
                <span style={{ color: log.includes("SUCCESS") || log.includes("[OK]") || log.includes("finished") ? "#4ade80" : log.includes("Error") ? "#f87171" : "#d4d4d4" }}>
                  {log}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Footer Status ─── */}
      <div className="flex items-center px-3 shrink-0" style={{ height: 22, borderTop: `1px solid ${border}`, background: bgAlt }}>
        <span style={{ fontSize: 9, color: lineCol }}>{TEMPLATES[activeFile]?.label ?? activeFile} — {lineCount} lines — SystemVerilog</span>
        <div className="flex-1" />
        <span style={{ fontSize: 9, color: lineCol }}>UTF-8 · LF · SystemVerilog</span>
      </div>
    </div>
  );
}
