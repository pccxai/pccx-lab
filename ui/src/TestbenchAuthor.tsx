import { useMemo, useState } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import { Terminal, FileCode, Binary, Code2, Copy, Download, Plus, Trash2, GripVertical, Blocks } from "lucide-react";

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

type View = "builder" | "isa" | "api" | "sv";

const OPCODE_META: Record<IsaInstr["opcode"], { color: string; label: string; hint: string; template: string }> = {
  OP_MEMCPY: { color: "#4ec86b", label: "MEMCPY", hint: "DDR ↔ BRM transfer",         template: "dst=brm_0  src=host  len=2048*2B" },
  OP_MEMSET: { color: "#6b7280", label: "MEMSET", hint: "shape/size register setup",  template: "shape_ptr=0  size_ptr=0  (D=2048, H=6144)" },
  OP_GEMV:   { color: "#4fc1ff", label: "GEMV",   hint: "W4A8 GEMV (matrix · vector)", template: "dst=q_reg  src=brm_0  flags=0x20" },
  OP_GEMM:   { color: "#0098ff", label: "GEMM",   hint: "W4A8 GEMM (tile matmul)",     template: "dst=mat_out  src=a,b  flags=0x20" },
  OP_CVO:    { color: "#dcdcaa", label: "CVO",    hint: "SFU: softmax / silu / rsqrt", template: "op=softmax  src=scores  dst=prob" },
};

export function TestbenchAuthor() {
  const theme = useTheme();
  const { t } = useI18n();
  const [isa, setIsa] = useState<IsaInstr[]>(DEFAULT_ISA);
  const [active, setActive] = useState<View>("builder");
  const [isaText_, setIsaText] = useState(isaText(DEFAULT_ISA));
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const apiCode = useMemo(() => apiFromIsa(isa), [isa]);
  const svCode  = useMemo(() => svFromIsa(isa),  [isa]);

  const onIsaChange = (v: string) => {
    setIsaText(v);
    const parsed = parseIsaFromText(v);
    if (parsed.length > 0) setIsa(parsed);
  };

  // Block-editor mutations
  const addBlock = (op: IsaInstr["opcode"]) => {
    const next: IsaInstr[] = [...isa, { opcode: op, body: OPCODE_META[op].template, note: "" }];
    setIsa(next); setIsaText(isaText(next));
  };
  const deleteBlock = (idx: number) => {
    const next = isa.filter((_, i) => i !== idx);
    setIsa(next); setIsaText(isaText(next));
  };
  const updateBlock = (idx: number, patch: Partial<IsaInstr>) => {
    const next = isa.map((b, i) => i === idx ? { ...b, ...patch } : b);
    setIsa(next); setIsaText(isaText(next));
  };
  const moveBlock = (from: number, to: number) => {
    if (from === to) return;
    const next = isa.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    setIsa(next); setIsaText(isaText(next));
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
      <div className="flex items-center px-4 shrink-0" style={{ height: 40, borderBottom: `0.5px solid ${theme.borderSubtle}` }}>
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

      <div className="flex items-center shrink-0" style={{ borderBottom: `0.5px solid ${theme.borderSubtle}`, padding: "0 12px" }}>
        {tabBtn("builder", <Blocks size={11}/>, "Builder", "Drag-drop opcode blocks — GUI-first authoring")}
        {tabBtn("isa", <Binary size={11}/>,  "ISA",     "Cycle-authoritative opcode list (editable)")}
        {tabBtn("api", <Code2 size={11}/>,   "API",     "C driver call sequence (generated from ISA)")}
        {tabBtn("sv",  <FileCode size={11}/>,"SV",      "SystemVerilog testbench skeleton (generated)")}
        <div className="flex-1" />
        <span style={{ fontSize: 10, color: theme.textMuted }}>
          {active === "builder" ? "GUI editor" : readOnly ? "read-only (generated)" : "editable"}
        </span>
      </div>

      {active === "builder" ? (
        <div className="flex-1 flex overflow-hidden">
          {/* Palette */}
          <div className="shrink-0 flex flex-col overflow-y-auto" style={{ width: 180, borderRight: `0.5px solid ${theme.borderSubtle}`, background: theme.bgEditor }}>
            <div style={{ padding: "8px 12px", fontSize: 9, color: theme.textMuted, letterSpacing: "0.05em", borderBottom: `0.5px solid ${theme.borderSubtle}`, background: theme.bgPanel }}>
              OPCODE PALETTE
            </div>
            <div className="p-2 flex flex-col gap-1.5">
              {(Object.keys(OPCODE_META) as IsaInstr["opcode"][]).map(op => {
                const meta = OPCODE_META[op];
                return (
                  <button key={op} onClick={() => addBlock(op)} title={meta.hint}
                    style={{
                      padding: "8px 10px", fontSize: 11, fontWeight: 600,
                      background: meta.color + "15", color: meta.color,
                      border: `0.5px solid ${meta.color}44`, borderRadius: 4,
                      textAlign: "left", cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 8,
                    }}>
                    <Plus size={10}/> {meta.label}
                    <span style={{ marginLeft: "auto", fontSize: 9, color: theme.textMuted }}>add</span>
                  </button>
                );
              })}
            </div>
            <div className="flex-1"/>
            <div style={{ padding: "8px 12px", fontSize: 9, color: theme.textMuted, borderTop: `0.5px solid ${theme.borderSubtle}` }}>
              Click a palette entry to append; drag a block's handle to reorder.
            </div>
          </div>

          {/* Block canvas */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2" style={{ background: theme.bg }}>
            {isa.map((b, i) => {
              const meta = OPCODE_META[b.opcode];
              const isDragging = dragIdx === i;
              return (
                <div key={i}
                  draggable
                  onDragStart={e => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                  onDrop={e => { e.preventDefault(); if (dragIdx != null && dragIdx !== i) moveBlock(dragIdx, i); setDragIdx(null); }}
                  onDragEnd={() => setDragIdx(null)}
                  style={{
                    background: theme.bgPanel,
                    border: `0.5px solid ${isDragging ? theme.accent : meta.color + "44"}`,
                    borderLeft: `4px solid ${meta.color}`,
                    borderRadius: 5,
                    padding: "10px 12px",
                    display: "grid",
                    gridTemplateColumns: "18px 72px 1fr 180px 24px",
                    gap: 10,
                    alignItems: "center",
                    opacity: isDragging ? 0.55 : 1,
                    cursor: isDragging ? "grabbing" : "default",
                    transition: "all 0.1s",
                  }}>
                  <span style={{ color: theme.textMuted, cursor: "grab" }} title="drag to reorder"><GripVertical size={14}/></span>
                  <select value={b.opcode} onChange={e => updateBlock(i, { opcode: e.target.value as IsaInstr["opcode"], body: OPCODE_META[e.target.value as IsaInstr["opcode"]].template })}
                    style={{
                      fontSize: 11, fontWeight: 700, color: meta.color,
                      background: meta.color + "15", border: `0.5px solid ${meta.color}44`,
                      borderRadius: 3, padding: "3px 6px", fontFamily: theme.fontMono,
                      outline: "none", cursor: "pointer",
                    }}>
                    {(Object.keys(OPCODE_META) as IsaInstr["opcode"][]).map(op => (
                      <option key={op} value={op}>{OPCODE_META[op].label}</option>
                    ))}
                  </select>
                  <input
                    value={b.body}
                    onChange={e => updateBlock(i, { body: e.target.value })}
                    placeholder={meta.template}
                    style={{
                      fontSize: 11, fontFamily: theme.fontMono,
                      background: theme.bgInput, border: `0.5px solid ${theme.borderSubtle}`,
                      color: theme.text, borderRadius: 3, padding: "4px 8px", outline: "none",
                    }}/>
                  <input
                    value={b.note ?? ""}
                    onChange={e => updateBlock(i, { note: e.target.value })}
                    placeholder="note (optional)"
                    style={{
                      fontSize: 10, fontStyle: "italic",
                      background: "transparent", border: `1px dashed ${theme.borderDim}`,
                      color: theme.textDim, borderRadius: 3, padding: "4px 8px", outline: "none",
                    }}/>
                  <button onClick={() => deleteBlock(i)} style={{ color: theme.textMuted, padding: 2, cursor: "pointer", border: "none", background: "transparent" }} title="delete">
                    <Trash2 size={12}/>
                  </button>
                </div>
              );
            })}
            {isa.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: theme.textMuted, fontSize: 12 }}>
                No blocks. Click an opcode in the palette on the left to append.
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 10, color: theme.textMuted }}>
              {isa.length} block{isa.length !== 1 ? "s" : ""} · will generate {isa.length} ISA instructions and a <code>tb_scenario_auto</code> SV skeleton.
            </div>
          </div>
        </div>
      ) : (
        <textarea
          readOnly={readOnly}
          value={body}
          onChange={e => onIsaChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, padding: "12px 16px",
            fontFamily: theme.fontMono,
            fontSize: 12, lineHeight: 1.55,
            color: theme.text, background: theme.bg,
            border: "none", outline: "none", resize: "none",
            whiteSpace: "pre", overflow: "auto",
          }}
        />
      )}

      <div className="px-4 py-2 shrink-0" style={{
        borderTop: `0.5px solid ${theme.borderSubtle}`, background: theme.bgPanel,
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
    border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 3, cursor: "pointer" as const,
  };
}
