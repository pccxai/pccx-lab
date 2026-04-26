import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  NodeTypes,
  Handle,
  Position,
  NodeProps,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "./ThemeContext";

// ─── Shared ───────────────────────────────────────────────────────────────────

function useNodeStyle() {
  const theme = useTheme();
  return useMemo(() => ({
    background: theme.bgPanel,
    border: "1.5px solid",
    borderRadius: 8,
    minWidth: 210,
    fontFamily: "Inter, sans-serif",
    boxShadow: theme.mode === "dark" ? "0 4px 20px rgba(0,0,0,0.4)" : "0 2px 12px rgba(0,0,0,0.08)",
  }), [theme.bgPanel, theme.mode]);
}

function Header({ title, sub, color }: { title: string; sub?: string; color: string }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "6px 10px", borderBottom: `1px solid ${theme.border}`, background: `linear-gradient(135deg, ${color}22, ${color}11)`, borderRadius: "6px 6px 0 0" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color }}>● {title}</div>
      {sub && <div style={{ fontSize: 9, color: theme.textDim, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Field({ label, value, unit, type = "number", options, onChange, min, max }: {
  label: string; value: string | number; unit?: string;
  type?: "number" | "select" | "text" | "range";
  options?: string[]; onChange?: (v: string) => void; min?: number; max?: number;
}) {
  const theme = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 py-[3px] px-3">
      <span style={{ fontSize: 10, color: theme.textMuted, whiteSpace: "nowrap" }}>{label}</span>
      <div className="flex items-center gap-1">
        {type === "select" && options ? (
          <select value={value} onChange={e => onChange?.(e.target.value)}
            style={{ fontSize: 10, background: theme.bgInput, border: `1px solid ${theme.border}`, borderRadius: 3, color: theme.text, padding: "1px 4px" }}>
            {options.map(o => <option key={o}>{o}</option>)}
          </select>
        ) : type === "range" ? (
          <input type="range" min={min} max={max} value={value} onChange={e => onChange?.(e.target.value)} style={{ width: 65, accentColor: theme.accent }} />
        ) : (
          <input type={type === "number" ? "number" : "text"} value={value} min={min} max={max} onChange={e => onChange?.(e.target.value)}
            style={{ width: 65, fontSize: 10, background: theme.bgInput, border: `1px solid ${theme.border}`, borderRadius: 3, color: theme.text, padding: "1px 6px", textAlign: "right" }} />
        )}
        {unit && <span style={{ fontSize: 9, color: theme.textMuted }}>{unit}</span>}
      </div>
    </div>
  );
}

interface PortDef {
  id: string;
  label: string;
  color: string;
}

function BlenderPorts({ inputs, outputs }: {
  inputs: PortDef[];
  outputs: PortDef[];
}) {
  const theme = useTheme();
  const ROW_H = 22;
  const maxRows = Math.max(inputs.length, outputs.length);

  return (
    <div style={{ position: "relative", borderTop: `0.5px solid ${theme.borderSubtle}` }}>
      {Array.from({ length: maxRows }, (_, i) => {
        const inp = inputs[i];
        const out = outputs[i];
        return (
          <div key={i} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            height: ROW_H, padding: "0 10px",
          }}>
            <span style={{ fontSize: 10, color: inp ? inp.color : "transparent" }}>
              {inp ? inp.label : ""}
            </span>
            <span style={{ fontSize: 10, color: out ? out.color : "transparent", textAlign: "right" }}>
              {out ? out.label : ""}
            </span>
          </div>
        );
      })}
      {inputs.map((p, i) => (
        <Handle key={`in-${p.id}`} type="target" id={p.id} position={Position.Left}
          style={{
            background: p.color, border: `2px solid ${theme.bgPanel}`,
            width: 10, height: 10, left: -5,
            top: `${((i + 0.5) / maxRows) * 100}%`,
          }} />
      ))}
      {outputs.map((p, i) => (
        <Handle key={`out-${p.id}`} type="source" id={p.id} position={Position.Right}
          style={{
            background: p.color, border: `2px solid ${theme.bgPanel}`,
            width: 10, height: 10, right: -5,
            top: `${((i + 0.5) / maxRows) * 100}%`,
          }} />
      ))}
    </div>
  );
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

const HostNode = React.memo(function HostNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#94a3b8";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="Host CPU" sub="Command interface" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Interface" value="PCIe 4.0" type="select" options={["PCIe 3.0","PCIe 4.0","PCIe 5.0","CXL 3.0"]} />
        <Field label="Bandwidth" value="32" unit="GB/s" type="number" />
      </div>
      <BlenderPorts
        inputs={[]}
        outputs={[
          { id: "cmd", label: "CMD", color: "#94a3b8" },
          { id: "dma", label: "DMA", color: "#94a3b8" },
        ]}
      />
    </div>
  );
});

const DramNode = React.memo(function DramNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#60a5fa";
  const [bw, setBw] = useState("68"); const [cap, setCap] = useState("16");
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="DRAM" sub="Off-chip memory" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Bandwidth" value={bw} unit="GB/s" onChange={setBw} />
        <Field label="Capacity" value={cap} unit="GB" onChange={setCap} />
        <Field label="Type" value="LPDDR5" type="select" options={["LPDDR5","HBM2E","DDR5","GDDR6X"]} />
      </div>
      <BlenderPorts
        inputs={[{ id: "wb_in", label: "Write-back", color: "#60a5fa" }]}
        outputs={[
          { id: "read", label: "Read Data", color: "#60a5fa" },
          { id: "stat", label: "Status", color: "#60a5fa" },
        ]}
      />
    </div>
  );
});

const AxiNode = React.memo(function AxiNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#818cf8";
  const [bw, setBw] = useState("16"); const [burst, setBurst] = useState("16");
  return (
    <div style={{ ...s, borderColor: c + "55", minWidth: 230 }}>
      <Header title="AXI-128 Interconnect" sub="Multi-port fabric" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Bandwidth" value={bw} unit="B/cyc" onChange={setBw} />
        <Field label="Burst Len" value={burst} unit="beats" onChange={setBurst} />
        <Field label="Width" value="128-bit" type="select" options={["64-bit","128-bit","256-bit","512-bit"]} />
        <Field label="Overhead" value="15" unit="cycles" />
        <Field label="Ports" value="4" type="select" options={["1","2","4","8"]} />
      </div>
      <BlenderPorts
        inputs={[
          { id: "in_host", label: "Host CMD", color: "#94a3b8" },
          { id: "in_dram", label: "DRAM Data", color: "#60a5fa" },
        ]}
        outputs={[
          { id: "out_bram", label: "To BRAM", color: "#818cf8" },
          { id: "out_ctrl", label: "Control", color: "#818cf8" },
        ]}
      />
    </div>
  );
});

const BramNode = React.memo(function BramNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#34d399";
  const [cap, setCap] = useState("1024");
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="L2 / BRAM" sub="On-chip scratchpad" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Capacity" value={cap} unit="KB" onChange={setCap} />
        <Field label="Read BW" value="64" unit="B/cyc" />
        <Field label="Write BW" value="64" unit="B/cyc" />
        <Field label="Read Ports" value="2" type="select" options={["1","2","4"]} />
        <Field label="Banks" value="4" type="select" options={["1","2","4","8","16"]} />
      </div>
      <BlenderPorts
        inputs={[{ id: "in", label: "AXI In", color: "#34d399" }]}
        outputs={[
          { id: "to_mac_a", label: "A Tile", color: "#34d399" },
          { id: "to_mac_b", label: "B Tile", color: "#22d3ee" },
        ]}
      />
    </div>
  );
});

const MacNode = React.memo(function MacNode(_: NodeProps) {
  const theme = useTheme();
  const s = useNodeStyle(); const c = "#a78bfa";
  const [rows, setRows] = useState("32"); const [cols, setCols] = useState("32"); const [clk, setClk] = useState("1000");
  const tops = (Number(rows) * Number(cols) * 2 * 32 * Number(clk) * 1e6 / 1e12).toFixed(2);
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="MAC Array" sub={`Systolic · ${tops} TOPS`} color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Rows" value={rows} type="range" min={4} max={128} onChange={setRows} />
        <Field label="Cols" value={cols} type="range" min={4} max={128} onChange={setCols} />
        <Field label="Precision" value="BF16" type="select" options={["INT8","BF16","FP16","FP32"]} />
        <Field label="Clock" value={clk} unit="MHz" onChange={setClk} />
        <Field label="Pipeline" value="10" unit="stg" />
        <div style={{ margin: "4px 12px 2px", padding: "4px 6px", background: theme.bgHover, borderRadius: 4, textAlign: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: c }}>{tops} TOPS</span>
        </div>
      </div>
      <BlenderPorts
        inputs={[
          { id: "tile_a", label: "A Tile", color: "#a78bfa" },
          { id: "tile_b", label: "B Tile", color: "#22d3ee" },
        ]}
        outputs={[
          { id: "partial", label: "Partial Sum", color: "#a78bfa" },
          { id: "stall", label: "Stall", color: "#6366f1" },
        ]}
      />
    </div>
  );
});

const AccumNode = React.memo(function AccumNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#f59e0b";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="Accumulator" sub="Register file + adder tree" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Precision" value="FP32" type="select" options={["INT32","FP32","FP64"]} />
        <Field label="Depth" value="64" unit="regs" />
        <Field label="Adder Tree" value="Yes" type="select" options={["No","Yes"]} />
      </div>
      <BlenderPorts
        inputs={[{ id: "in", label: "Partial Sum", color: "#f59e0b" }]}
        outputs={[{ id: "out", label: "C Matrix", color: "#f59e0b" }]}
      />
    </div>
  );
});

const PostProcNode = React.memo(function PostProcNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#fb923c";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="Post-Proc Unit" sub="Activation / Norm / Quant" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Activation" value="ReLU" type="select" options={["None","ReLU","GELU","SiLU","Sigmoid","Swish"]} />
        <Field label="Normalizer" value="LayerNorm" type="select" options={["None","LayerNorm","BatchNorm","RMSNorm","GroupNorm"]} />
        <Field label="Quantize" value="None" type="select" options={["None","INT8","FP8"]} />
        <Field label="Softmax" value="Yes" type="select" options={["No","Yes"]} />
      </div>
      <BlenderPorts
        inputs={[{ id: "in", label: "Raw Data", color: "#fb923c" }]}
        outputs={[
          { id: "out", label: "Processed", color: "#fb923c" },
          { id: "stats", label: "Stats", color: "#fb7185" },
        ]}
      />
    </div>
  );
});

const WriteBackNode = React.memo(function WriteBackNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#f472b6";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="Write-back Engine" sub="DMA write unit" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Mode" value="DMA" type="select" options={["DMA","MMIO","Streaming"]} />
        <Field label="Channels" value="4" type="select" options={["1","2","4","8"]} />
        <Field label="Buffer" value="16" unit="KB" />
      </div>
      <BlenderPorts
        inputs={[{ id: "in", label: "Output Data", color: "#f472b6" }]}
        outputs={[{ id: "to_dram", label: "DMA Write", color: "#f472b6" }]}
      />
    </div>
  );
});

// ─── pccx v002-specific nodes (Blender-style rich palette) ────────────────────

const GemvNode = React.memo(function GemvNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#22d3ee";
  const [lanes, setLanes] = useState("4");
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="GEMV Engine" sub="v002 · 32-MAC × 5-stage × N lanes" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Lanes"     value={lanes} type="select" options={["1","2","4","8"]} onChange={setLanes} />
        <Field label="Per-lane"  value="32"    unit="MAC" />
        <Field label="Stages"    value="5"     unit="cyc" />
        <Field label="Throughput" value={`${Number(lanes) * 32}/cyc`} />
      </div>
      <BlenderPorts
        inputs={[
          { id: "fmap", label: "Feature Map", color: "#22d3ee" },
          { id: "weight", label: "Weights", color: "#818cf8" },
        ]}
        outputs={[
          { id: "partial", label: "Partial", color: "#22d3ee" },
          { id: "stall", label: "Stall", color: "#f59e0b" },
        ]}
      />
    </div>
  );
});

const CvoNode = React.memo(function CvoNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#e879f9";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="CVO SFU" sub="v002 · single instance · CORDIC + LUT" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Ops" value="exp" type="select"
               options={["exp","sqrt","GELU","sin","cos","reduce_sum","scale","recip"]} />
        <Field label="Throughput" value="1" unit="op/cyc" />
        <Field label="Latency"    value="16" unit="cyc" />
      </div>
      <BlenderPorts
        inputs={[{ id: "in", label: "Operand", color: "#e879f9" }]}
        outputs={[{ id: "out", label: "Result", color: "#e879f9" }]}
      />
    </div>
  );
});

const HpBufferNode = React.memo(function HpBufferNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#f87171";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="HP Buffer" sub="v002 · 4 × HP AXI, weight pre-fetch FIFO" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Ports" value="4" type="select" options={["1","2","4"]} />
        <Field label="Width" value="128-bit" type="select" options={["64-bit","128-bit","256-bit"]} />
        <Field label="Depth" value="512"     unit="entries" />
      </div>
      <BlenderPorts
        inputs={[{ id: "axi_in", label: "AXI In", color: "#f87171" }]}
        outputs={[
          { id: "upper_ch", label: "Upper Ch", color: "#818cf8" },
          { id: "lower_ch", label: "Lower Ch", color: "#22d3ee" },
        ]}
      />
    </div>
  );
});

const UramNode = React.memo(function UramNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#14b8a6";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="URAM L2" sub="v002 · 64 URAMs · 1.75 MB · 2-cycle read" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="URAMs"   value="64" unit="blocks" />
        <Field label="Size"    value="1.75" unit="MB" />
        <Field label="Read Latency" value="2" unit="cyc" />
        <Field label="Ports"   value="2" type="select" options={["1","2"]} />
      </div>
      <BlenderPorts
        inputs={[{ id: "wr", label: "Write", color: "#14b8a6" }]}
        outputs={[
          { id: "rd_a", label: "Read A", color: "#14b8a6" },
          { id: "rd_b", label: "Read B", color: "#06b6d4" },
        ]}
      />
    </div>
  );
});

const FmapCacheNode = React.memo(function FmapCacheNode(_: NodeProps) {
  const s = useNodeStyle(); const c = "#eab308";
  return (
    <div style={{ ...s, borderColor: c + "55" }}>
      <Header title="fmap Cache" sub="v002 · 27 b × 2048 · 32-lane broadcast" color={c} />
      <div style={{ padding: "4px 0" }}>
        <Field label="Data width" value="27"   unit="bits" />
        <Field label="Depth"      value="2048" unit="words" />
        <Field label="Write lanes" value="16" />
        <Field label="Broadcast"  value="32" unit="lanes" />
      </div>
      <BlenderPorts
        inputs={[{ id: "wr_bf16", label: "BF16 Write", color: "#eab308" }]}
        outputs={[{ id: "bcast", label: "Broadcast", color: "#f59e0b" }]}
      />
    </div>
  );
});

// ─── Registration ─────────────────────────────────────────────────────────────
const nodeTypes: NodeTypes = {
  host: HostNode as any, dram: DramNode as any, axi: AxiNode as any,
  bram: BramNode as any, mac: MacNode as any, accum: AccumNode as any,
  postproc: PostProcNode as any, writeback: WriteBackNode as any,
  gemv: GemvNode as any, cvo: CvoNode as any, hpbuf: HpBufferNode as any,
  uram: UramNode as any, fmapcache: FmapCacheNode as any,
};

const MINIMAP_NODE_COLORS: Record<string, string> = {
  dram: "#60a5fa", axi: "#818cf8", bram: "#34d399",
  mac: "#a78bfa", accum: "#f59e0b", postproc: "#fb923c",
  writeback: "#f472b6", host: "#94a3b8",
  gemv: "#22d3ee", cvo: "#e879f9", hpbuf: "#f87171",
  uram: "#14b8a6", fmapcache: "#eab308",
};
const minimapNodeColor = (n: Node) => MINIMAP_NODE_COLORS[n.type ?? ""] ?? "#4a4a4a";
const DEFAULT_EDGE_STYLE = { stroke: "#6b7280", strokeWidth: 1.5 };

function buildGraph() {
  const nodes: Node[] = [
    { id: "host",      type: "host",      position: { x: 20,   y: 0   }, data: {} },
    { id: "dram",      type: "dram",      position: { x: 20,   y: 200 }, data: {} },
    { id: "axi",       type: "axi",       position: { x: 280,  y: 80  }, data: {} },
    { id: "bram",      type: "bram",      position: { x: 560,  y: 20  }, data: {} },
    { id: "mac",       type: "mac",       position: { x: 820,  y: 20  }, data: {} },
    { id: "accum",     type: "accum",     position: { x: 1060, y: 60  }, data: {} },
    { id: "postproc",  type: "postproc",  position: { x: 1060, y: 240 }, data: {} },
    { id: "writeback", type: "writeback", position: { x: 820,  y: 340 }, data: {} },
  ];

  const mkEdge = (id: string, src: string, srcH: string, tgt: string, tgtH: string, color: string, label?: string): Edge => ({
    id, source: src, sourceHandle: srcH, target: tgt, targetHandle: tgtH,
    animated: true, style: { stroke: color, strokeWidth: 1.5 },
    label, labelStyle: { fill: color, fontSize: 9 }, labelBgStyle: { fill: "#252526", fillOpacity: 0.9 },
    deletable: true,
  });

  const edges: Edge[] = [
    mkEdge("host-axi",  "host", "cmd",     "axi", "in_host",  "#94a3b8", "CMD"),
    mkEdge("dram-axi",  "dram", "read",    "axi", "in_dram",  "#60a5fa", "DMA READ"),
    mkEdge("axi-bram",  "axi",  "out_bram","bram","in",       "#818cf8", "AXI burst"),
    mkEdge("bram-macA", "bram", "to_mac_a","mac", "tile_a",   "#34d399", "A tile"),
    mkEdge("bram-macB", "bram", "to_mac_b","mac", "tile_b",   "#22d3ee", "B tile"),
    mkEdge("mac-accum", "mac",  "partial", "accum","in",      "#a78bfa", "partial Σ"),
    mkEdge("accum-pp",  "accum","out",     "postproc","in",   "#f59e0b", "C matrix"),
    mkEdge("pp-wb",     "postproc","out",  "writeback","in",  "#fb923c", "output"),
    mkEdge("wb-dram",   "writeback","to_dram","dram","wb_in", "#f472b6", "DMA WRITE"),
  ];

  return { nodes, edges };
}

import { ReactFlowProvider, useReactFlow } from '@xyflow/react';

// ─── DnD Sidebar ──────────────────────────────────────────────────────────────

interface PaletteEntry { id: string; label: string; color: string; hint?: string; }
interface PaletteCategory { name: string; entries: PaletteEntry[]; }

const PALETTE: PaletteCategory[] = [
  { name: "Input", entries: [
    { id: "host", label: "Host CPU",           color: "#94a3b8", hint: "AXI-Lite master" },
  ]},
  { name: "Memory", entries: [
    { id: "dram",       label: "DRAM",         color: "#60a5fa", hint: "LPDDR5 / HBM2E"       },
    { id: "axi",        label: "AXI Fabric",   color: "#818cf8", hint: "128 b interconnect"   },
    { id: "bram",       label: "BRAM L1",      color: "#34d399", hint: "On-chip scratchpad"   },
    { id: "uram",       label: "URAM L2",      color: "#14b8a6", hint: "v002 · 1.75 MB"       },
    { id: "hpbuf",      label: "HP Buffer",    color: "#f87171", hint: "4× HP AXI, weight FIFO" },
    { id: "fmapcache",  label: "fmap Cache",   color: "#eab308", hint: "27 b × 2048 · 32-lane"},
  ]},
  { name: "Compute", entries: [
    { id: "mac",   label: "GEMM MAC Array", color: "#a78bfa", hint: "v002 · 32×32 W4A8"  },
    { id: "gemv",  label: "GEMV Engine",    color: "#22d3ee", hint: "v002 · 4 lanes × 32 MAC" },
    { id: "cvo",   label: "CVO SFU",        color: "#e879f9", hint: "v002 · single instance"  },
    { id: "accum", label: "Accumulator",    color: "#f59e0b", hint: "Register file + adder"   },
  ]},
  { name: "Output", entries: [
    { id: "postproc",  label: "Post-Proc",      color: "#fb923c", hint: "Activation / Norm / Quant" },
    { id: "writeback", label: "Write-back DMA", color: "#f472b6", hint: "AXI egress"            },
  ]},
];

function paletteSearch(q: string): PaletteCategory[] {
  if (!q.trim()) return PALETTE;
  const needle = q.trim().toLowerCase();
  return PALETTE.map(cat => ({
    name: cat.name,
    entries: cat.entries.filter(e =>
      e.label.toLowerCase().includes(needle) ||
      e.id.includes(needle) ||
      (e.hint ?? "").toLowerCase().includes(needle)
    ),
  })).filter(cat => cat.entries.length > 0);
}

function Sidebar({ onSpawn }: { onSpawn: (id: string) => void }) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  const visible = useMemo(() => paletteSearch(query), [query]);

  return (
    <div className="w-[240px] shrink-0 flex flex-col" style={{ background: theme.bgPanel, borderRight: `1px solid ${theme.border}` }}>
      <div style={{ padding: "10px 14px", fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${theme.border}`, color: theme.text, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Node Palette</span>
        <span style={{ fontSize: 9, color: theme.textMuted }}>Shift+A · drag-drop</span>
      </div>
      <div style={{ padding: "8px 12px", borderBottom: `1px solid ${theme.border}` }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search nodes…"
          style={{
            width: "100%", fontSize: 11, padding: "5px 8px",
            background: theme.bgSurface,
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
            color: theme.text,
          }}
        />
      </div>
      <div className="flex px-3 py-2 gap-2 border-b" style={{ borderColor: theme.border }}>
         <button onClick={() => alert("Topology cleared")} className="flex-1 py-1 rounded text-[10px] font-bold shadow" style={{ background: theme.bgSurface, color: theme.textDim, border: `1px solid ${theme.border}` }}>
            Clear Graph
         </button>
         <button onClick={() => alert("Exported pccx_topology.json")} className="flex-1 py-1 rounded text-[10px] font-bold shadow" style={{ background: theme.accent, color: "#fff" }}>
            Export
         </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {visible.length === 0 && (
          <div style={{ fontSize: 11, color: theme.textMuted, padding: 12, textAlign: "center" }}>
            No matching nodes.
          </div>
        )}
        {visible.map(cat => (
          <div key={cat.name} style={{ marginBottom: 6 }}>
            <button
              onClick={() => setCollapsed(c => ({ ...c, [cat.name]: !c[cat.name] }))}
              style={{
                width: "100%", textAlign: "left", padding: "4px 8px",
                fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                color: theme.textMuted, background: "transparent",
                border: "none", cursor: "pointer",
                letterSpacing: 0.6,
              }}
            >
              {collapsed[cat.name] ? "▸" : "▾"} {cat.name}
              <span style={{ marginLeft: 6, fontWeight: 400, opacity: 0.6 }}>
                ({cat.entries.length})
              </span>
            </button>
            {!collapsed[cat.name] && cat.entries.map(opt => (
              <div
                key={opt.id}
                onDragStart={(e) => onDragStart(e, opt.id)}
                draggable
                onDoubleClick={() => onSpawn(opt.id)}
                title={opt.hint ? `${opt.hint} — double-click to add` : "double-click to add"}
                style={{
                  margin: "3px 4px",
                  padding: "6px 10px", background: theme.bgSurface,
                  border: `1px solid ${theme.borderDim}`, borderRadius: 5,
                  cursor: "grab", display: "flex", alignItems: "center", gap: 8,
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: opt.color, boxShadow: `0 0 6px ${opt.color}88` }} />
                <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                  <span style={{ fontSize: 11, color: theme.text, fontWeight: 600 }}>{opt.label}</span>
                  {opt.hint && (
                    <span style={{ fontSize: 9, color: theme.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {opt.hint}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Shift+A quick-add menu (Blender-style) ───────────────────────────────────

function QuickAddMenu(
  { pos, onClose, onPick }: {
    pos: { x: number; y: number } | null;
    onClose: () => void;
    onPick: (id: string) => void;
  }
) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  useEffect(() => { setQuery(""); }, [pos]);
  if (!pos) return null;
  const results = paletteSearch(query);
  return (
    <div
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: "absolute", left: pos.x, top: pos.y, zIndex: 1000,
        width: 260, background: theme.bgEditor,
        border: `1px solid ${theme.border}`, borderRadius: 6,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)", padding: 6,
      }}
    >
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}
        placeholder="Add node…  (Esc to close)"
        style={{
          width: "100%", fontSize: 11, padding: "5px 8px", marginBottom: 4,
          background: theme.bgSurface,
          border: `1px solid ${theme.border}`, borderRadius: 4,
          color: theme.text,
        }}
      />
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {results.map(cat => (
          <div key={cat.name} style={{ marginBottom: 4 }}>
            <div style={{
              padding: "3px 8px", fontSize: 9, fontWeight: 700, textTransform: "uppercase",
              color: theme.textMuted, letterSpacing: 0.5,
            }}>
              {cat.name}
            </div>
            {cat.entries.map(e => (
              <div
                key={e.id}
                onClick={() => { onPick(e.id); onClose(); }}
                style={{
                  padding: "5px 10px", fontSize: 11, cursor: "pointer",
                  color: theme.text, borderRadius: 3,
                  display: "flex", alignItems: "center", gap: 8,
                }}
                onMouseEnter={ev => ((ev.currentTarget.style.background = theme.bgHover))}
                onMouseLeave={ev => ((ev.currentTarget.style.background = "transparent"))}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: e.color }} />
                <span>{e.label}</span>
                {e.hint && (
                  <span style={{ marginLeft: "auto", fontSize: 9, color: theme.textMuted }}>
                    {e.hint}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Flow Component ──────────────────────────────────────────────────────

let idIndex = 0;
const getId = () => `node_drop_${idIndex++}`;

function DnDFlow() {
  const theme = useTheme();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { nodes: initN, edges: initE } = useMemo(buildGraph, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initN);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initE);
  const { screenToFlowPosition } = useReactFlow();

  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

  const onConnect = useCallback((p: Connection) => setEdges(eds => addEdge({ ...p, animated: true, style: DEFAULT_EDGE_STYLE, deletable: true }, eds)), [setEdges]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const spawnAtFlowPos = useCallback((type: string, flowPos: { x: number; y: number }) => {
    const newNode: Node = { id: getId(), type, position: flowPos, data: {} };
    setNodes((nds) => nds.concat(newNode));
  }, [setNodes]);

  const spawnAtCentre = useCallback((type: string) => {
    const rect = reactFlowWrapper.current?.getBoundingClientRect();
    if (!rect) return;
    const flowPos = screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top  + rect.height / 2,
    });
    spawnAtFlowPos(type, flowPos);
  }, [screenToFlowPosition, spawnAtFlowPos]);

  const onDrop = useCallback((event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow");
      if (typeof type === "undefined" || !type) return;
      spawnAtFlowPos(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }, [screenToFlowPosition, spawnAtFlowPos]);

  // Shift+A opens the quick-add menu at the cursor — Blender convention.
  useEffect(() => {
    let lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const trackMouse = (e: MouseEvent) => { lastMouse = { x: e.clientX, y: e.clientY }; };
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.key === "A" || e.key === "a")) {
        const target = e.target as HTMLElement | null;
        // Avoid hijacking while the user types in an input.
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
                       target.isContentEditable)) return;
        const rect = reactFlowWrapper.current?.getBoundingClientRect();
        if (!rect) return;
        if (lastMouse.x < rect.left || lastMouse.x > rect.right ||
            lastMouse.y < rect.top  || lastMouse.y > rect.bottom) return;
        e.preventDefault();
        setAddMenu({ x: lastMouse.x - rect.left, y: lastMouse.y - rect.top });
      } else if (e.key === "Escape") {
        setAddMenu(null);
      }
    };
    window.addEventListener("keydown",   onKey);
    window.addEventListener("mousemove", trackMouse);
    return () => {
      window.removeEventListener("keydown",   onKey);
      window.removeEventListener("mousemove", trackMouse);
    };
  }, []);

  const pickFromMenu = useCallback((type: string) => {
    if (!addMenu) return;
    const rect = reactFlowWrapper.current?.getBoundingClientRect();
    if (!rect) return;
    spawnAtFlowPos(type, screenToFlowPosition({
      x: rect.left + addMenu.x,
      y: rect.top  + addMenu.y,
    }));
  }, [addMenu, screenToFlowPosition, spawnAtFlowPos]);

  return (
    <div className="w-full h-full flex">
      <Sidebar onSpawn={spawnAtCentre} />
      <div
        className="flex-1 relative"
        ref={reactFlowWrapper}
        onMouseDown={() => setAddMenu(null)}
      >
        <QuickAddMenu pos={addMenu} onClose={() => setAddMenu(null)} onPick={pickFromMenu} />
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          colorMode={theme.mode}
          fitView fitViewOptions={{ padding: 0.12 }}
          minZoom={0.15} maxZoom={4}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ deletable: true }}
        >
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={minimapNodeColor}
            maskColor={theme.mode === "dark" ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.7)"}
            style={{ background: theme.bgPanel, border: `1px solid ${theme.border}` }}
          />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={theme.border} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function NodeEditor() {
  return (
    <ReactFlowProvider>
      <DnDFlow />
    </ReactFlowProvider>
  );
}
