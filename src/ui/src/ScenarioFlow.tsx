import { useState, useMemo } from "react";
import { useTheme } from "./ThemeContext";
import { useI18n } from "./i18n";
import {
  ChevronRight, Cpu, Activity, Zap, Clock, Database, ArrowRight, Code2,
} from "lucide-react";

// ─── Data model ──────────────────────────────────────────────────────────────

type LatencyClass = "fast" | "medium" | "slow" | "critical";

interface IsaEvent {
  cycle: number;
  op:    string;       // e.g. "OP_GEMV"
  body:  string;       // e.g. "dst=r9  src=r3  flags=0x10"
  unit:  "Fetch" | "Decode" | "GEMV" | "GEMM" | "CVO" | "MEM" | "Retire";
}

interface DataMove {
  from: string;
  to:   string;
  bytes: number;
  cycles: number;
}

interface Stage {
  id:        string;
  name:      string;
  cycles:    number;
  latency:   LatencyClass;
  /** LaTeX / plain-math line rendered below the headline. */
  formula?:  string;
  /** C pseudo-code — concrete implementation for the reader. */
  code?:     string;
  /** Cycle-accurate opcode stream fired in this stage. */
  isa?:      IsaEvent[];
  /** Data movements issued (source → destination). */
  dataflow?: DataMove[];
  /** Sub-stages. Recursive. */
  children?: Stage[];
}

// ─── The Gemma 3N E4B decode scenario on pccx v002 ──────────────────────────
//
// This is intentionally synthetic — it shows the kind of reasoning chain
// the tool enables: click a block → math + ISA + data movement + latency
// reason surface together.

const SCENARIO: Stage = {
  id: "decode",
  name: "decode_step (Gemma 3N E4B · pccx v002)",
  cycles: 4820,
  latency: "slow",
  formula: "y_i \\; = \\; \\operatorname{softmax}(Wx_i)",
  children: [
    {
      id: "embed",
      name: "embed_lookup + rms_norm_pre",
      cycles: 180,
      latency: "fast",
      formula: "x = E[\\text{token}_i]; \\;\\; \\hat x = \\tfrac{x}{\\sqrt{\\overline{x^2} + 10^{-6}}}\\,\\gamma",
      code: "uca_embed_lookup(token, x);\nuca_rms_norm(x, gamma_ln, x_hat);",
      isa: [
        { cycle:   0, op: "OP_MEMCPY", body: "dst=brm_0  src=host_embed  len=2048×2B",  unit: "Fetch"  },
        { cycle:   4, op: "—",         body: "decode OP_MEMCPY",                        unit: "Decode" },
        { cycle:  12, op: "—",         body: "AXI-HP burst read from DDR",              unit: "MEM"    },
        { cycle: 120, op: "OP_CVO",    body: "reduce_sum → 1/√(⋅+ε)",                  unit: "CVO"    },
        { cycle: 160, op: "OP_CVO",    body: "scale × γ",                               unit: "CVO"    },
      ],
      dataflow: [
        { from: "DDR",     to: "L2",    bytes: 4096,  cycles: 80 },
        { from: "L2",      to: "CVO",   bytes: 4096,  cycles: 40 },
        { from: "CVO",     to: "L2",    bytes: 4096,  cycles: 20 },
      ],
    },
    {
      id: "attn",
      name: "Attention (layers × 35)",
      cycles: 2180,
      latency: "critical",
      formula:
        "A \\;=\\; \\operatorname{softmax}\\!\\Bigl(\\tfrac{QK^{\\!\\top}}{\\sqrt{d_h}}\\Bigr)\\,V",
      children: [
        {
          id: "qkv",
          name: "Q / K / V projection (GEMV)",
          cycles: 420,
          latency: "medium",
          formula: "Q = W_q \\hat x,\\; K = W_k \\hat x,\\; V = W_v \\hat x",
          code:
            "uca_gemv_w4a8(W_q, x_hat, q);\n" +
            "uca_gemv_w4a8(W_k, x_hat, k);\n" +
            "uca_gemv_w4a8(W_v, x_hat, v);",
          isa: [
            { cycle:   0, op: "OP_GEMV", body: "dst=q_reg  src=x̂  size=D×D  shape=3_stacked",      unit: "Fetch"  },
            { cycle:   4, op: "—",       body: "4-lane dispatch · upper[HP0] lower[HP1]",         unit: "Decode" },
            { cycle:  16, op: "—",       body: "weight stream D×D/4 per lane",                     unit: "MEM"    },
            { cycle: 120, op: "—",       body: "GEMV MAC × 32 · 5-stage pipeline",                 unit: "GEMV"   },
            { cycle: 400, op: "—",       body: "partial sums → CVO for e_max register",           unit: "CVO"    },
            { cycle: 420, op: "—",       body: "retire q, k, v",                                   unit: "Retire" },
          ],
          dataflow: [
            { from: "URAM",    to: "HP_buf", bytes: 32768, cycles: 120 },
            { from: "HP_buf",  to: "GEMV",   bytes: 32768, cycles: 280 },
            { from: "GEMV",    to: "L2",     bytes: 6144,  cycles: 20  },
          ],
        },
        {
          id: "rope",
          name: "RoPE rotation (5-layer cycle)",
          cycles: 110,
          latency: "fast",
          formula: "q'_j = q_j \\cos\\theta_j - q_{j+1}\\sin\\theta_j",
          code: "uca_cvo_rope(q, k, theta_table_local);",
          isa: [
            { cycle:   0, op: "OP_CVO", body: "cos/sin LUT broadcast",   unit: "CVO" },
            { cycle:  40, op: "OP_CVO", body: "per-head complex mul",     unit: "CVO" },
          ],
          dataflow: [
            { from: "LUT",  to: "CVO", bytes: 512,   cycles: 20 },
            { from: "CVO",  to: "L2",  bytes: 6144,  cycles: 40 },
          ],
        },
        {
          id: "scores",
          name: "attn_scores (Q·Kᵀ → softmax → A·V)",
          cycles: 1200,
          latency: "critical",
          formula:
            "A = \\operatorname{softmax}(QK^{\\top})V \\;\\; (\\text{scaling absorbed into } \\gamma)",
          code:
            "uca_gemm_w4a8(q, k_T, scores);    // (1×L_seq)\n" +
            "uca_cvo_softmax(scores, p);       // row-wise\n" +
            "uca_gemv_w4a8(p, v, ctx);         // A·V",
          isa: [
            { cycle:    0, op: "OP_GEMM", body: "dst=scores  src=q,kᵀ",       unit: "Fetch"  },
            { cycle:  400, op: "OP_CVO",  body: "exp → reduce_sum → recip",    unit: "CVO"    },
            { cycle:  800, op: "OP_GEMV", body: "dst=ctx  src=p,v",            unit: "GEMV"   },
            { cycle: 1150, op: "—",       body: "drain + barrier",             unit: "Retire" },
          ],
          dataflow: [
            { from: "L2",   to: "GEMM", bytes: 98304, cycles: 320 },
            { from: "GEMM", to: "CVO",  bytes: 2048,  cycles: 80  },
            { from: "CVO",  to: "GEMV", bytes: 2048,  cycles: 20  },
            { from: "GEMV", to: "L2",   bytes: 6144,  cycles: 40  },
          ],
        },
        {
          id: "attn_out",
          name: "attn_out projection + AltUp residual",
          cycles: 450,
          latency: "medium",
          formula: "y = W_o \\,A \\; + \\;\\sum_{s=0}^{3} \\alpha_s \\, xs[s]",
          code:
            "uca_gemv_w4a8(W_o, ctx, attn_out);\n" +
            "uca_cvo_altup_residual(xs, attn_out);",
          isa: [
            { cycle:   0, op: "OP_GEMV", body: "dst=attn_out  src=ctx",    unit: "Fetch"  },
            { cycle: 380, op: "OP_CVO",  body: "AltUp add across xs[0..3]",unit: "CVO"    },
            { cycle: 440, op: "—",       body: "barrier",                   unit: "Retire" },
          ],
          dataflow: [
            { from: "L2",    to: "GEMV", bytes: 16384, cycles: 240 },
            { from: "GEMV",  to: "CVO",  bytes: 4096,  cycles: 60  },
            { from: "CVO",   to: "L2",   bytes: 16384, cycles: 80  },
          ],
        },
      ],
    },
    {
      id: "ffn",
      name: "FFN + LAuReL (layers × 35)",
      cycles: 1850,
      latency: "slow",
      formula:
        "y = W_{\\mathrm{down}}\\,\\bigl(\\,\\operatorname{SiLU}(W_{\\mathrm{gate}}\\hat x)\\odot W_{\\mathrm{up}}\\hat x\\bigr)\\;+\\;W_{\\mathrm{laurel\\,down}}(W_{\\mathrm{laurel\\,up}}\\hat x)/\\sqrt 2",
      children: [
        {
          id: "ffn_gate",
          name: "Gate (top-K ≈ 5% sparsity)",
          cycles: 520,
          latency: "medium",
          formula: "m_i = \\mathbb{1}\\!\\bigl[\\,g_i \\ge \\mu + 1.645\\,\\sigma\\bigr]",
          code:
            "uca_gemv_w4a8(W_gate, x_hat, g_raw);\n" +
            "uca_cvo_gaussian_topk(g_raw, mask, &mean, &std);",
          isa: [
            { cycle:   0, op: "OP_GEMV", body: "dst=g_raw  src=x̂  size=D×H",                unit: "Fetch"  },
            { cycle: 320, op: "OP_CVO",  body: "mean / std / threshold",                   unit: "CVO"    },
            { cycle: 400, op: "OP_CVO",  body: "mask = (g_raw >= μ+1.645σ)",               unit: "CVO"    },
            { cycle: 510, op: "—",       body: "stall · skip masked rows of W_down",         unit: "Retire" },
          ],
          dataflow: [
            { from: "URAM", to: "GEMV", bytes: 65536, cycles: 300 },
            { from: "GEMV", to: "CVO",  bytes: 8192,  cycles: 60  },
            { from: "CVO",  to: "L2",   bytes: 1024,  cycles: 10  },
          ],
        },
        {
          id: "ffn_up",
          name: "Up + SiLU + Down",
          cycles: 820,
          latency: "slow",
          formula: "\\text{ffn\\_out} = W_{\\mathrm{down}}\\bigl(\\operatorname{SiLU}(W_{\\mathrm{gate}}\\hat x)\\odot (W_{\\mathrm{up}}\\hat x)\\bigr)",
          code:
            "uca_gemv_w4a8(W_up, x_hat, u);\n" +
            "uca_cvo_silu_mul(g_raw, u, gu);       // SiLU(g)·u\n" +
            "uca_gemv_w4a8_masked(W_down, gu, mask, ffn_out);",
          isa: [
            { cycle:   0, op: "OP_GEMV", body: "dst=u  src=x̂",                             unit: "Fetch"  },
            { cycle: 300, op: "OP_CVO",  body: "SiLU + elementwise mul",                   unit: "CVO"    },
            { cycle: 420, op: "OP_GEMV", body: "dst=ffn_out  src=gu  mask=mask",           unit: "GEMV"   },
            { cycle: 800, op: "—",       body: "retire + barrier",                          unit: "Retire" },
          ],
          dataflow: [
            { from: "URAM", to: "GEMV",  bytes: 65536,  cycles: 300 },
            { from: "GEMV", to: "CVO",   bytes: 8192,   cycles: 40  },
            { from: "CVO",  to: "GEMV",  bytes: 8192,   cycles: 40  },
            { from: "URAM", to: "GEMV",  bytes: 65536,  cycles: 320 },
            { from: "GEMV", to: "L2",    bytes: 4096,   cycles: 20  },
          ],
        },
        {
          id: "laurel",
          name: "LAuReL parallel branch",
          cycles: 510,
          latency: "medium",
          formula: "y_{\\text{laurel}} = W_{\\!D\\times 64}^{\\mathrm{down}} (W_{\\!64\\times D}^{\\mathrm{up}}\\hat x) \\cdot \\tfrac{1}{\\sqrt 2}",
          code:
            "uca_gemv_w4a8(W_laurel_up, x_hat, lu);\n" +
            "uca_gemv_w4a8(W_laurel_down, lu, ld);\n" +
            "uca_cvo_scale(ld, 0.70710678f);",
          isa: [
            { cycle:   0, op: "OP_GEMV", body: "dst=lu  src=x̂  size=D×64",   unit: "Fetch"  },
            { cycle: 200, op: "OP_GEMV", body: "dst=ld  src=lu  size=64×D",   unit: "GEMV"   },
            { cycle: 480, op: "OP_CVO",  body: "scale 1/√2",                   unit: "CVO"    },
          ],
          dataflow: [
            { from: "URAM", to: "GEMV", bytes: 4096, cycles: 100 },
            { from: "GEMV", to: "GEMV", bytes:  128, cycles:  20 },
            { from: "GEMV", to: "L2",   bytes: 4096, cycles:  40 },
          ],
        },
      ],
    },
    {
      id: "lm_head",
      name: "lm_head (GEMV) + top-k sampler",
      cycles: 610,
      latency: "medium",
      formula: "p = \\operatorname{softmax}(W_{\\!V\\times D}\\,\\hat x)",
      code:
        "uca_gemv_w4a8(W_vocab, x_hat, logits);\n" +
        "uca_cvo_topk_sampler(logits, /*k=*/64, token_out);",
      isa: [
        { cycle:   0, op: "OP_GEMV", body: "dst=logits  src=x̂  size=V×D",  unit: "Fetch"  },
        { cycle: 420, op: "OP_CVO",  body: "top-k extract + categorical",  unit: "CVO"    },
        { cycle: 600, op: "OP_MEMCPY", body: "token_out → host",            unit: "MEM"    },
      ],
      dataflow: [
        { from: "URAM", to: "GEMV", bytes: 524288, cycles: 420 },
        { from: "GEMV", to: "CVO",  bytes: 131072, cycles: 120 },
        { from: "CVO",  to: "DDR",  bytes:     2,  cycles:  20 },
      ],
    },
  ],
};

// ─── Latency → colour legend (blue = fast, yellow = medium, orange = slow,
//                              red = critical). Matches the request. ──────────

function latencyColours(lat: LatencyClass) {
  switch (lat) {
    case "fast":     return { border: "#3b82f6", tint: "rgba(59,130,246,0.12)",  label: "fast"     };
    case "medium":   return { border: "#eab308", tint: "rgba(234,179,8,0.12)",   label: "medium"   };
    case "slow":     return { border: "#f97316", tint: "rgba(249,115,22,0.12)",  label: "slow"     };
    case "critical": return { border: "#ef4444", tint: "rgba(239,68,68,0.15)",   label: "critical" };
  }
}

// ─── Block + breadcrumb ─────────────────────────────────────────────────────

function Breadcrumb(
  { path, onSelect }: { path: Stage[]; onSelect: (idx: number) => void }
) {
  const theme = useTheme();
  return (
    <div className="flex items-center gap-1 flex-wrap" style={{ fontSize: 11, color: theme.textMuted }}>
      {path.map((p, i) => (
        <span key={p.id} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={10} />}
          <button
            onClick={() => onSelect(i)}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: i === path.length - 1 ? theme.accent : theme.textDim,
              fontSize: 11, fontWeight: i === path.length - 1 ? 700 : 500,
              padding: "2px 4px",
            }}
          >
            {p.name}
          </button>
        </span>
      ))}
    </div>
  );
}

interface BlockProps { stage: Stage; onOpen: (s: Stage) => void; totalCycles: number; }

function Block({ stage, onOpen, totalCycles }: BlockProps) {
  const theme = useTheme();
  const col = latencyColours(stage.latency);
  const pct = ((stage.cycles / totalCycles) * 100).toFixed(1);
  const hasChildren = stage.children && stage.children.length > 0;
  return (
    <button
      onClick={() => onOpen(stage)}
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        gap: 2, padding: "8px 12px", minWidth: 180,
        background: col.tint,
        border: `1.5px solid ${col.border}`,
        borderRadius: 6, cursor: "pointer", color: theme.text,
        textAlign: "left",
      }}
      title={`${stage.cycles.toLocaleString()} cyc · ${col.label}${hasChildren ? " · click to drill down" : ""}`}
    >
      <div style={{ display: "flex", alignItems: "center", width: "100%", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>{stage.name}</span>
        {hasChildren && <ChevronRight size={12} style={{ marginLeft: "auto", opacity: 0.7 }} />}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: theme.textMuted }}>
        <Clock size={10} />
        <span style={{ fontFamily: "ui-monospace, monospace" }}>
          {stage.cycles.toLocaleString()} cyc
        </span>
        <span>·</span>
        <span>{pct}%</span>
        <span style={{ marginLeft: "auto", color: col.border, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
          {col.label}
        </span>
      </div>
    </button>
  );
}

// ─── Detail panel ───────────────────────────────────────────────────────────

type DetailTab = "overview" | "isa" | "data";

function Detail(
  { stage, onOpen, totalCycles }:
  { stage: Stage; onOpen: (s: Stage) => void; totalCycles: number }
) {
  const theme = useTheme();
  const [tab, setTab] = useState<DetailTab>("overview");
  const col = latencyColours(stage.latency);

  const tabBtn = (id: DetailTab, icon: ReactLike, label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 11, padding: "4px 10px",
        color: tab === id ? theme.accent : theme.textMuted,
        background: tab === id ? theme.accentBg : "transparent",
        border: "none",
        borderBottom: `2px solid ${tab === id ? theme.accent : "transparent"}`,
        cursor: "pointer",
      }}
    >
      {icon} {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{
        padding: "10px 14px", borderRadius: 6,
        background: col.tint, border: `1px solid ${col.border}`,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: theme.text }}>
          {stage.name}
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 4, fontSize: 11, color: theme.textMuted }}>
          <span><Clock size={10} style={{ marginRight: 3, verticalAlign: "middle" }}/>
            {stage.cycles.toLocaleString()} cyc ·
            {" "}{((stage.cycles / totalCycles) * 100).toFixed(1)}% of root
          </span>
          <span style={{ color: col.border, fontWeight: 600, textTransform: "uppercase" }}>
            {col.label}
          </span>
        </div>
        {stage.formula && (
          <div style={{
            marginTop: 8, padding: "6px 10px",
            background: theme.bg, border: `1px solid ${theme.borderDim}`, borderRadius: 4,
            fontSize: 12, fontFamily: "ui-serif, Georgia, serif",
            color: theme.text, whiteSpace: "pre-wrap",
          }}>
            {stage.formula}
          </div>
        )}
      </div>

      {/* Tab strip */}
      <div style={{ display: "flex", borderBottom: `1px solid ${theme.border}` }}>
        {tabBtn("overview", <Code2 size={11}/>,    "Overview")}
        {tabBtn("isa",      <Zap size={11}/>,      "ISA Timeline")}
        {tabBtn("data",     <Database size={11}/>, "Data Movement")}
      </div>

      {/* Tab body */}
      {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {stage.code && (
            <pre style={{
              margin: 0, padding: "10px 14px",
              background: theme.bg, border: `1px solid ${theme.borderDim}`, borderRadius: 4,
              fontSize: 11, color: theme.text, overflowX: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}>
              {stage.code}
            </pre>
          )}
          {stage.children && stage.children.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: theme.textDim, marginBottom: 6 }}>
                Sub-stages
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {stage.children.map(c => (
                  <Block key={c.id} stage={c} onOpen={onOpen} totalCycles={totalCycles} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "isa" && <IsaView events={stage.isa ?? []} total={stage.cycles} />}

      {tab === "data" && <DataFlowView moves={stage.dataflow ?? []} total={stage.cycles} />}
    </div>
  );
}

function IsaView({ events, total }: { events: IsaEvent[]; total: number }) {
  const theme = useTheme();
  if (events.length === 0) {
    return <div style={{ fontSize: 11, color: theme.textMuted }}>No ISA events recorded at this depth.</div>;
  }
  const unitColour: Record<IsaEvent["unit"], string> = {
    Fetch: "#94a3b8", Decode: "#60a5fa", GEMV: "#22d3ee",
    GEMM: "#a78bfa", CVO: "#e879f9", MEM: "#eab308", Retire: "#4ec86b",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11, color: theme.textMuted, display: "flex", gap: 10 }}>
        {Object.entries(unitColour).map(([u, c]) => (
          <span key={u} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} /> {u}
          </span>
        ))}
      </div>
      <table style={{ fontSize: 11, width: "100%", borderCollapse: "collapse", fontFamily: "ui-monospace, monospace" }}>
        <thead>
          <tr style={{ color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
            <th style={{ textAlign: "right", padding: "3px 10px", width: 60 }}>cycle</th>
            <th style={{ textAlign: "left",  padding: "3px 10px", width: 90 }}>opcode</th>
            <th style={{ textAlign: "left",  padding: "3px 10px", width: 70 }}>unit</th>
            <th style={{ textAlign: "left",  padding: "3px 10px" }}>body</th>
            <th style={{ textAlign: "left",  padding: "3px 10px", width: 180 }}>wave</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${theme.borderDim}` }}>
              <td style={{ textAlign: "right", padding: "3px 10px", color: theme.text }}>
                {e.cycle.toLocaleString()}
              </td>
              <td style={{ padding: "3px 10px", color: theme.accent }}>{e.op}</td>
              <td style={{ padding: "3px 10px", color: unitColour[e.unit] }}>{e.unit}</td>
              <td style={{ padding: "3px 10px", color: theme.textDim }}>{e.body}</td>
              <td style={{ padding: "3px 10px" }}>
                <div style={{ position: "relative", height: 10, background: theme.bg, border: `1px solid ${theme.borderDim}`, borderRadius: 2 }}>
                  <div style={{
                    position: "absolute", left: `${(e.cycle / Math.max(total, 1)) * 100}%`,
                    top: 0, bottom: 0, width: 4, background: unitColour[e.unit],
                  }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataFlowView({ moves, total }: { moves: DataMove[]; total: number }) {
  const theme = useTheme();
  if (moves.length === 0) {
    return <div style={{ fontSize: 11, color: theme.textMuted }}>No data movements at this depth.</div>;
  }
  const maxCycles = Math.max(...moves.map(m => m.cycles), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {moves.map((m, i) => {
        const pct   = (m.cycles / total) * 100;
        const barPct = (m.cycles / maxCycles) * 100;
        const colour = pct > 25 ? "#ef4444" : pct > 10 ? "#f97316" : pct > 4 ? "#eab308" : "#3b82f6";
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: theme.text, width: 80 }}>
              {m.from}
            </span>
            <ArrowRight size={12} style={{ color: theme.textMuted }} />
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: theme.text, width: 80 }}>
              {m.to}
            </span>
            <div style={{
              flex: 1, height: 14, background: theme.bg,
              border: `1px solid ${theme.borderDim}`, borderRadius: 3, overflow: "hidden",
            }}>
              <div style={{
                width: `${barPct}%`, height: "100%",
                background: `linear-gradient(90deg, ${colour}66, ${colour})`,
              }} />
            </div>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: theme.textMuted, width: 70, textAlign: "right" }}>
              {m.bytes.toLocaleString()} B
            </span>
            <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: colour, width: 60, textAlign: "right" }}>
              {m.cycles} cyc
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Top-level component ────────────────────────────────────────────────────

export function ScenarioFlow() {
  const theme = useTheme();
  const { t } = useI18n();
  const [path, setPath] = useState<Stage[]>([SCENARIO]);
  const current = path[path.length - 1];
  const total = useMemo(() => SCENARIO.cycles, []);

  const openStage = (s: Stage) => setPath(p => [...p, s]);
  const jumpToPath = (idx: number) => setPath(p => p.slice(0, idx + 1));

  return (
    <div className="w-full h-full flex flex-col overflow-hidden" style={{ background: theme.bg }}>
      {/* Header bar */}
      <div className="flex items-center px-4 shrink-0" style={{ height: 44, borderBottom: `1px solid ${theme.border}` }}>
        <Cpu size={16} style={{ color: theme.accent, marginRight: 8 }} />
        <span style={{ fontWeight: 700, fontSize: 13 }}>Scenario Flow</span>
        <span style={{ marginLeft: 10, fontSize: 11, color: theme.textMuted }}>
          {t("status.cycles")}: <span style={{ fontFamily: "ui-monospace, monospace", color: theme.text }}>{total.toLocaleString()}</span>
        </span>
        <div className="flex-1" />
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 10, color: theme.textMuted }}>
          {(["fast","medium","slow","critical"] as LatencyClass[]).map(l => {
            const c = latencyColours(l);
            return (
              <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 10, height: 10, background: c.tint, border: `1.5px solid ${c.border}`, borderRadius: 2 }} />
                {c.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="px-4 py-2 shrink-0" style={{ borderBottom: `1px solid ${theme.border}` }}>
        <Breadcrumb path={path} onSelect={jumpToPath} />
      </div>

      {/* Children grid (only when the current has children) + Detail panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 overflow-auto" style={{ padding: 16 }}>
          <Detail stage={current} onOpen={openStage} totalCycles={total} />
        </div>
        {/* Mini-map sidebar showing sibling stages */}
        {path.length > 1 && (
          <div className="shrink-0 overflow-auto" style={{
            width: 230, background: theme.bgPanel, borderLeft: `1px solid ${theme.border}`,
            padding: 12, display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ fontSize: 10, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
              <Activity size={10} style={{ marginRight: 4, verticalAlign: "middle" }} /> Siblings
            </div>
            {path[path.length - 2].children?.map(sib => (
              <button
                key={sib.id}
                onClick={() => setPath(p => [...p.slice(0, -1), sib])}
                style={{
                  textAlign: "left", cursor: "pointer",
                  background: sib.id === current.id ? theme.accentBg : "transparent",
                  border: `1px solid ${sib.id === current.id ? theme.accent : theme.borderDim}`,
                  borderRadius: 4, padding: "6px 8px", color: theme.text,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 600 }}>{sib.name}</div>
                <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>
                  {sib.cycles.toLocaleString()} cyc · {latencyColours(sib.latency).label}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type ReactLike = ReturnType<typeof Code2>;
