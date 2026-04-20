import { useMemo, useState } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import { Terminal, FileCode, Binary, Code2, Copy, Download } from "lucide-react";

// ─── Shared scenario model ───────────────────────────────────────────────────
//
// The author writes their intent at **one** level (ISA / API / SV) and
// the other two views are generated. Round-trip authoring is out of scope
// for this first version — ISA and API flow to SV, but the SV pane is
// read-only in the other direction.

interface IsaInstr {
  opcode: "OP_GEMV" | "OP_GEMM" | "OP_MEMCPY" | "OP_MEMSET" | "OP_CVO";
  /** ISA body encoded as a hex literal for now; the toolchain will
   *  later surface a structured editor. */
  body:   string;
  /** Optional annotation shown in the generated SV comment. */
  note?:  string;
}

const DEFAULT_ISA: IsaInstr[] = [
  { opcode: "OP_MEMCPY", body: "dst=brm_0  src=host_embed  len=2048*2B",     note: "load embed x"        },
  { opcode: "OP_MEMSET", body: "shape_ptr=0  size_ptr=0  (D=2048, H=6144)",  note: "FFN shape constants" },
  { opcode: "OP_GEMV",   body: "dst=q_reg  src=brm_0  flags=0x20  (W_q)",    note: "Q = W_q · x̂"         },
  { opcode: "OP_GEMV",   body: "dst=k_reg  src=brm_0  flags=0x20  (W_k)",    note: "K = W_k · x̂"         },
  { opcode: "OP_GEMV",   body: "dst=v_reg  src=brm_0  flags=0x20  (W_v)",    note: "V = W_v · x̂"         },
  { opcode: "OP_CVO",    body: "op=softmax  src=scores  dst=prob",           note: "row-wise softmax"    },
  { opcode: "OP_GEMV",   body: "dst=ctx  src=prob,v  flags=0x20",            note: "A · V"               },
  { opcode: "OP_MEMCPY", body: "dst=host_out  src=ctx  len=2048*2B",         note: "ship output"         },
];

// ─── API view ────────────────────────────────────────────────────────────────
//
// The driver API is the compiled surface a C / C++ user actually calls.
// Each call translates to one or more ISA instructions.

function apiFromIsa(isa: IsaInstr[]): string {
  const lines: string[] = [];
  lines.push("// Driver API author — each call is translated to the ISA.");
  lines.push("#include <uca.h>");
  lines.push("");
  lines.push("void tb_scenario(uca_ctx_t *c) {");
  for (const i of isa) {
    switch (i.opcode) {
      case "OP_MEMCPY":
        lines.push(`    uca_memcpy(c, /* ${i.note ?? ""} */  ${i.body});`);
        break;
      case "OP_MEMSET":
        lines.push(`    uca_memset(c, /* ${i.note ?? ""} */  ${i.body});`);
        break;
      case "OP_GEMV":
        lines.push(`    uca_gemv_w4a8(c, /* ${i.note ?? ""} */  ${i.body});`);
        break;
      case "OP_GEMM":
        lines.push(`    uca_gemm_w4a8(c, /* ${i.note ?? ""} */  ${i.body});`);
        break;
      case "OP_CVO":
        lines.push(`    uca_cvo(c,     /* ${i.note ?? ""} */  ${i.body});`);
        break;
    }
  }
  lines.push("    uca_sync(c);   // drain + barrier");
  lines.push("}");
  return lines.join("\n");
}

// ─── ISA view ────────────────────────────────────────────────────────────────
//
// Each row shows the 64-bit packed form (4-bit opcode + 60-bit body).
// We render the opcode nybble in the left column and the body free-text
// that will be parsed downstream; an editor with structured fields
// is future work.

function isaText(isa: IsaInstr[]): string {
  return isa
    .map((i, idx) => `${idx.toString().padStart(2, "0")} | ${i.opcode.padEnd(10)} | ${i.body}${i.note ? `  ; ${i.note}` : ""}`)
    .join("\n");
}

// ─── SV view ─────────────────────────────────────────────────────────────────
//
// Generated testbench skeleton that wraps the canonical `PASS:` marker
// the pccx-lab xsim bridge recognises, and pushes each ISA into the
// controller's AXI-Lite command FIFO.

function svFromIsa(isa: IsaInstr[], tbName = "tb_scenario_auto"): string {
  const pushLines = isa.map((i, idx) => {
    const op = i.opcode;
    const body = i.body.replace(/"/g, "\\\"");
    return `      push_cmd(${String(idx).padStart(2, "0")}, ${op.padEnd(10)}, "${body}");${i.note ? `  // ${i.note}` : ""}`;
  }).join("\n");

  return `\`timescale 1ns / 1ps

// ===============================================================================
// Testbench: ${tbName}
// Auto-generated from pccx-lab Testbench Author.
// ===============================================================================

\`include "GLOBAL_CONST.svh"

import isa_pkg::*;

module ${tbName};

  localparam int N_INSTR = ${isa.length};

  logic clk;
  logic rst_n;
  initial clk = 1'b0;
  always #2 clk = ~clk;

  // push_cmd(index, opcode_sym, body) — wraps the controller AXI-Lite FIFO
  task push_cmd(input int idx, input string opsym, input string body);
    \`uvm_info("SCN", $sformatf("[%0d] %s  %s", idx, opsym, body), UVM_LOW);
    @(posedge clk);
  endtask

  initial begin
    int errors = 0;
    rst_n = 1'b0;
    repeat (3) @(posedge clk);
    rst_n = 1'b1;
    @(posedge clk);

${pushLines}

    // Drain + barrier
    repeat (32) @(posedge clk);

    if (errors == 0) begin
      $display("PASS: %0d cycles, both channels match golden.", N_INSTR);
    end else begin
      $display("FAIL: %0d mismatches over %0d cycles.", errors, N_INSTR);
    end
    $finish;
  end

  initial begin
    #100000 $display("TIMEOUT"); $finish;
  end

endmodule
`;
}

// ─── Editor helpers ──────────────────────────────────────────────────────────

function parseIsaFromText(txt: string): IsaInstr[] {
  const out: IsaInstr[] = [];
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;
    // Accept "idx | OP_GEMV | body" or "OP_GEMV body"
    const parts = t.split("|").map(p => p.trim());
    let op: IsaInstr["opcode"] | null = null;
    let body = "";
    let note: string | undefined;
    if (parts.length === 3) {
      op = parts[1] as IsaInstr["opcode"];
      const rest = parts[2].split(";");
      body = rest[0].trim();
      note = rest[1]?.trim();
    } else {
      const m = t.match(/^(OP_\w+)\s+(.*?)(?:;\s*(.*))?$/);
      if (m) {
        op = m[1] as IsaInstr["opcode"];
        body = m[2].trim();
        note = m[3]?.trim();
      }
    }
    if (op && /^OP_(GEMV|GEMM|MEMCPY|MEMSET|CVO)$/.test(op)) {
      out.push({ opcode: op, body, note });
    }
  }
  return out;
}

// ─── Component ──────────────────────────────────────────────────────────────

type View = "isa" | "api" | "sv";

export function TestbenchAuthor() {
  const theme = useTheme();
  const { t } = useI18n();
  const [isa, setIsa] = useState<IsaInstr[]>(DEFAULT_ISA);
  const [active, setActive] = useState<View>("isa");
  const [isaText_, setIsaText] = useState(isaText(DEFAULT_ISA));

  const apiCode = useMemo(() => apiFromIsa(isa), [isa]);
  const svCode  = useMemo(() => svFromIsa(isa),  [isa]);

  const onIsaChange = (v: string) => {
    setIsaText(v);
    const parsed = parseIsaFromText(v);
    if (parsed.length > 0) setIsa(parsed);
  };

  const tabBtn = (id: View, icon: React.ReactNode, label: string, hint: string) => (
    <button
      onClick={() => setActive(id)}
      title={hint}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 11, padding: "5px 12px",
        color: active === id ? theme.accent : theme.textMuted,
        background: active === id ? theme.accentBg : "transparent",
        border: "none",
        borderBottom: `2px solid ${active === id ? theme.accent : "transparent"}`,
        cursor: "pointer", fontWeight: active === id ? 700 : 500,
      }}
    >
      {icon} {label}
    </button>
  );

  const body = active === "isa" ? isaText_ : active === "api" ? apiCode : svCode;
  const readOnly = active !== "isa";
  const filename = active === "isa" ? "scenario.isa"
                 : active === "api" ? "tb_scenario.c"
                 : "tb_scenario_auto.sv";

  const copy = async () => {
    try { await navigator.clipboard.writeText(body); } catch { /* ignore */ }
  };

  const download = () => {
    const blob = new Blob([body], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden" style={{ background: theme.bg }}>
      <div className="flex items-center px-4 shrink-0" style={{ height: 40, borderBottom: `1px solid ${theme.border}` }}>
        <Terminal size={16} style={{ color: theme.accent, marginRight: 8 }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>Testbench Author</span>
        <span style={{ marginLeft: 10, fontSize: 11, color: theme.textMuted }}>
          {isa.length} {t("status.cycles") /* re-used label */} · authored at ISA level · API + SV auto-generated
        </span>
        <div className="flex-1" />
        <button onClick={copy} style={iconBtn(theme)}>
          <Copy size={12} /> Copy
        </button>
        <button onClick={download} style={{ ...iconBtn(theme), marginLeft: 6 }}>
          <Download size={12} /> {filename}
        </button>
      </div>

      <div className="flex items-center shrink-0" style={{ borderBottom: `1px solid ${theme.border}`, padding: "0 12px" }}>
        {tabBtn("isa", <Binary size={11}/>,  "ISA",     "Cycle-authoritative opcode list (editable)")}
        {tabBtn("api", <Code2 size={11}/>,   "API",     "C driver call sequence (generated from ISA)")}
        {tabBtn("sv",  <FileCode size={11}/>,"SV",      "SystemVerilog testbench skeleton (generated)")}
        <div className="flex-1" />
        <span style={{ fontSize: 10, color: theme.textMuted }}>
          {readOnly ? "read-only (generated)" : "editable"}
        </span>
      </div>

      <textarea
        readOnly={readOnly}
        value={body}
        onChange={e => onIsaChange(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1, padding: "12px 16px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12, lineHeight: 1.55,
          color: theme.text, background: theme.bg,
          border: "none", outline: "none", resize: "none",
          whiteSpace: "pre", overflow: "auto",
        }}
      />

      <div className="px-4 py-2 shrink-0" style={{
        borderTop: `1px solid ${theme.border}`, background: theme.bgPanel,
        fontSize: 10, color: theme.textMuted,
      }}>
        Tip — the ISA view is the authoring source. Edit, then switch to
        <strong style={{ color: theme.text, margin: "0 4px" }}>API</strong>
        or <strong style={{ color: theme.text, margin: "0 4px" }}>SV</strong>
        to inspect the downstream translation. Click <strong style={{ color: theme.text, margin: "0 4px" }}>Copy</strong>
        or <strong style={{ color: theme.text, margin: "0 4px" }}>Download</strong> to hand the SV
        off to <code>hw/sim/run_verification.sh</code>.
      </div>
    </div>
  );
}

function iconBtn(theme: ReturnType<typeof useTheme>) {
  return {
    display: "inline-flex" as const, alignItems: "center" as const, gap: 4,
    fontSize: 10, padding: "4px 10px",
    color: theme.textMuted, background: "transparent",
    border: `1px solid ${theme.border}`, borderRadius: 3, cursor: "pointer" as const,
  };
}
