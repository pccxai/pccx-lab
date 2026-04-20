import { useRef, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./ThemeContext";

interface Span {
  name: string;
  start: number;
  duration: number;
  depth: number;
  color: string;
}

export function FlameGraph() {
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [totalCycles, setTotalCycles] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<{ text: string; rec: string } | null>(null);

  const vp = useRef({ offset: 0, cpp: 1, dragging: false, lastX: 0 });

  useEffect(() => {
    // Models a Gemma 3N E4B single-token decode step on the pccx v002
    // KV260 floorplan. Each transformer layer is fully broken out into
    // its attention + FFN sub-operations so the flame graph tells the
    // real story: Q/K/V projections, RoPE rotation, QK · softmax · AV,
    // FFN gate / up / SiLU / down, LAuReL parallel branch, and the
    // PLE shadow-stream update.
    const d = theme.mode === "dark";
    const PALETTE = {
      root:     d ? "#374151" : "#e5e7eb",
      layer:    d ? "#1f2937" : "#f3f4f6",
      norm:     "#64748b",
      qkv:      "#0ea5e9",   // attention projections
      rope:     "#0284c7",
      scores:   "#a855f7",   // QK · softmax · AV
      attnOut:  "#6366f1",
      ffnGate:  "#f59e0b",
      ffnUp:    "#f97316",
      ffnDown:  "#ea580c",
      silu:     "#eab308",
      laurel:   "#8b5cf6",
      ple:      "#14b8a6",
      residual: "#22c55e",
      dmaRead:  "#6a9955",
      mac:      "#4fc1ff",
      dmaWrite: "#dcdcaa",
      stall:    "#c586c0",
    };

    const demo: Span[] = [];
    const N_LAYERS = 10;  // sample — Gemma 3N has 35 total; rest aggregated.
    const layerCycles = 420;
    const embedCycles = 180;
    const sampleCycles = 140;

    let t = 0;
    const rootStart = 0;

    // --- Embedding lookup + initial RMSNorm ---
    demo.push({ name: "embed_lookup",           start: t,            duration: 80,  depth: 1, color: PALETTE.ple });
    demo.push({ name: "dma_read · 2048 × 27b",  start: t + 5,        duration: 60,  depth: 2, color: PALETTE.dmaRead });
    demo.push({ name: "rms_norm_pre",           start: t + 80,       duration: 40,  depth: 1, color: PALETTE.norm });
    demo.push({ name: "altup_broadcast[0..3]",  start: t + 120,      duration: 60,  depth: 1, color: PALETTE.ple });
    t += embedCycles;

    // --- 10 transformer layers, one breakdown per layer ---
    for (let L = 0; L < N_LAYERS; L++) {
      const layerStart = t;
      demo.push({ name: `layer_${L}`, start: layerStart, duration: layerCycles, depth: 1, color: PALETTE.layer });

      // pre-attention RMSNorm
      demo.push({ name: "rms_norm", start: t, duration: 18, depth: 2, color: PALETTE.norm });
      t += 18;

      // Q / K / V GEMV projections (shared D×D)
      const qkvDur = 80;
      demo.push({ name: "QKV_proj (GEMV)", start: t, duration: qkvDur, depth: 2, color: PALETTE.qkv });
      demo.push({ name: "dma_read · W_qkv",    start: t,          duration: 14, depth: 3, color: PALETTE.dmaRead });
      demo.push({ name: "mac · 3×D×D",         start: t + 14,     duration: qkvDur - 20, depth: 3, color: PALETTE.mac });
      demo.push({ name: "dma_write · q,k,v",   start: t + qkvDur - 6, duration: 6,  depth: 3, color: PALETTE.dmaWrite });
      t += qkvDur;

      // RoPE rotation (θ = 10 000 local / 1 000 000 global, 5-layer cycle)
      const rope = L % 5 === 4 ? "RoPE_global" : "RoPE_local";
      demo.push({ name: rope, start: t, duration: 22, depth: 2, color: PALETTE.rope });
      t += 22;

      // Cross-layer KV cache: layers 20..34 reuse 18/19 — model here by
      // skipping the K/V write on ≥20 (we don't reach 20 in N_LAYERS=10,
      // but keep the split so a future N_LAYERS=35 looks right).
      const ownsKV = L < 20;
      if (ownsKV) {
        demo.push({ name: "kv_cache_write", start: t, duration: 12, depth: 2, color: PALETTE.dmaWrite });
        t += 12;
      }

      // Attention scores: Q·Kᵀ → softmax → A·V
      const scoresStart = t;
      const scoresDur = 110;
      demo.push({ name: "attn_scores (softmax skipped-scaling)", start: scoresStart, duration: scoresDur, depth: 2, color: PALETTE.scores });
      demo.push({ name: "Q·Kᵀ (GEMM)",        start: scoresStart,        duration: 40, depth: 3, color: PALETTE.mac });
      demo.push({ name: "cvo · exp+reduce",   start: scoresStart + 40,   duration: 28, depth: 3, color: PALETTE.scores });
      demo.push({ name: "cvo · recip",        start: scoresStart + 68,   duration: 12, depth: 3, color: PALETTE.scores });
      demo.push({ name: "A·V (GEMM)",         start: scoresStart + 80,   duration: 30, depth: 3, color: PALETTE.mac });
      t += scoresDur;

      // Output projection
      const outDur = 40;
      demo.push({ name: "attn_out (GEMV)", start: t, duration: outDur, depth: 2, color: PALETTE.attnOut });
      demo.push({ name: "mac · D×D",  start: t + 4,       duration: outDur - 10, depth: 3, color: PALETTE.mac });
      t += outDur;

      // Residual add (AltUp: four streams updated)
      demo.push({ name: "altup_residual (xs[0..3])", start: t, duration: 14, depth: 2, color: PALETTE.residual });
      t += 14;

      // post-attention RMSNorm
      demo.push({ name: "rms_norm", start: t, duration: 14, depth: 2, color: PALETTE.norm });
      t += 14;

      // FFN: gate (with Gaussian Top-K sparsity), up, SiLU, down + LAuReL parallel branch
      const ffnStart = t;
      const ffnDur = 92;
      demo.push({ name: "ffn + LAuReL", start: ffnStart, duration: ffnDur, depth: 2, color: PALETTE.ffnGate });
      demo.push({ name: "gate (topK ~5%)",     start: ffnStart,          duration: 26, depth: 3, color: PALETTE.ffnGate });
      demo.push({ name: "stall · mask_apply",  start: ffnStart + 10,     duration: 6,  depth: 3, color: PALETTE.stall });
      demo.push({ name: "up",                  start: ffnStart + 26,     duration: 22, depth: 3, color: PALETTE.ffnUp });
      demo.push({ name: "silu",                start: ffnStart + 48,     duration: 8,  depth: 3, color: PALETTE.silu });
      demo.push({ name: "down",                start: ffnStart + 56,     duration: 24, depth: 3, color: PALETTE.ffnDown });
      demo.push({ name: "laurel (D×64, 64×D)", start: ffnStart + 40,     duration: 32, depth: 3, color: PALETTE.laurel });
      demo.push({ name: "scale 1/√2",          start: ffnStart + 72,     duration: 8,  depth: 3, color: PALETTE.scores });
      t = ffnStart + ffnDur;

      // PLE shadow stream update (layers 0..9 → xs[1..3] only)
      demo.push({ name: "ple_shadow (xs[1..3])", start: t, duration: 18, depth: 2, color: PALETTE.ple });
      t += 18;

      // fill remainder with a small DMA/write-back
      const slack = layerStart + layerCycles - t;
      if (slack > 0) {
        demo.push({ name: "barrier_sync", start: t, duration: slack, depth: 2, color: PALETTE.stall });
        t = layerStart + layerCycles;
      }
    }

    // --- Remaining 25 layers aggregated as one bar ---
    const restDur = (35 - N_LAYERS) * layerCycles;
    demo.push({ name: "layers 10..34 (aggregated)", start: t, duration: restDur, depth: 1, color: PALETTE.layer });
    demo.push({ name: "rms_norm + attn + ffn × 25", start: t, duration: restDur, depth: 2, color: PALETTE.norm });
    t += restDur;

    // --- LM head + sampler ---
    demo.push({ name: "lm_head (GEMV)",     start: t,                 duration: 90,            depth: 1, color: PALETTE.attnOut });
    demo.push({ name: "mac · Vocab × D",    start: t + 8,             duration: 72,            depth: 2, color: PALETTE.mac });
    demo.push({ name: "cvo · topk_sampler", start: t + 90,            duration: sampleCycles - 90, depth: 1, color: PALETTE.scores });
    t += sampleCycles;

    // Root spans the whole decode step.
    demo.unshift({ name: "decode_step_0 (Gemma 3N E4B)", start: rootStart, duration: t, depth: 0, color: PALETTE.root });

    setSpans(demo);
    setTotalCycles(t);
    vp.current.cpp = t / 1000;
    setLoading(false);
  }, [theme.mode]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    if (!canvas || !cont) return;
    
    const dpr = window.devicePixelRatio || 1;
    const cw = cont.clientWidth; 
    const ch = cont.clientHeight;
    
    canvas.width = cw * dpr; 
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`; 
    canvas.style.height = `${ch}px`;
    
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const { offset, cpp } = vp.current;
    
    // Clear
    ctx.fillStyle = theme.bgPanel;
    ctx.fillRect(0, 0, cw, ch);

    const SPAN_H = 22;
    const paddingY = 20;

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    for (const span of spans) {
      const x1 = (span.start - offset) / cpp;
      const w = span.duration / cpp;
      
      if (x1 + w < 0 || x1 > cw) continue; // Culling

      const y = paddingY + span.depth * (SPAN_H + 2);
      
      const drawX = Math.max(0, x1);
      const drawW = Math.min(cw - drawX, w - (drawX - x1));
      
      if (drawW <= 0) continue;

      // Box
      ctx.fillStyle = span.color;
      ctx.beginPath();
      ctx.roundRect(x1, y, w, SPAN_H, 2);
      ctx.fill();
      
      // Border
      ctx.strokeStyle = theme.mode === "dark" ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Text if wide enough
      if (drawW > 30) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "10px Inter, sans-serif";
        ctx.save();
        ctx.beginPath(); ctx.rect(drawX, y, drawW, SPAN_H); ctx.clip();
        ctx.fillText(span.name, Math.max(x1 + 4, 4), y + SPAN_H / 2);
        ctx.restore();
      }
    }
  }, [spans, theme]);

  useEffect(() => { 
    draw(); 
    const ro = new ResizeObserver(draw); 
    if (containerRef.current) {
        vp.current.cpp = totalCycles / (containerRef.current.clientWidth || 1000);
        ro.observe(containerRef.current); 
    }
    return () => ro.disconnect(); 
  }, [draw, totalCycles]);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const mx = e.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0);
    if (e.ctrlKey || e.metaKey) {
      const zf = e.deltaY > 0 ? 1.2 : 0.833;
      const cyc = vp.current.offset + mx * vp.current.cpp;
      vp.current.cpp = Math.max(0.001, vp.current.cpp * zf);
      vp.current.offset = cyc - mx * vp.current.cpp;
    } else {
      vp.current.offset += e.deltaX * vp.current.cpp * 0.5;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) vp.current.offset += e.deltaY * vp.current.cpp * 0.5;
    }
    draw();
  }, [draw]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);
  
  const onMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (vp.current.dragging) {
      const dx = e.clientX - vp.current.lastX;
      vp.current.offset -= dx * vp.current.cpp;
      vp.current.lastX = e.clientX;
      draw();
      setTooltip(null);
      return;
    }

    const SPAN_H = 22;
    const paddingY = 20;
    const hCyc = vp.current.offset + mx * vp.current.cpp;
    
    // Find highest depth hit
    let hit: Span | null = null;
    for (const span of spans) {
        const y = paddingY + span.depth * (SPAN_H + 2);
        if (my >= y && my <= y + SPAN_H && hCyc >= span.start && hCyc <= span.start + span.duration) {
            if (!hit || span.depth > hit.depth) hit = span;
        }
    }

    if (hit) {
      setTooltip({
        x: e.clientX - rect.left + 15, 
        y: e.clientY - rect.top + 15,
        text: `${hit.name}\nDuration: ${hit.duration.toLocaleString()} cycles\nStart: ${hit.start.toLocaleString()}`
      });
    } else {
      setTooltip(null);
    }
  };

  const handleAIHotspot = () => {
    // Find the longest bottleneck node (deepest level, usually DMA_Read_Wait or MAC_Compute)
    const bottleneck = spans.filter(s => s.depth === 2 && s.name.includes("Wait")).sort((a,b) => b.duration - a.duration)[0];
    if (!bottleneck) return;

    // Smooth scroll to bottleneck
    const targetOffset = bottleneck.start - (containerRef.current?.clientWidth || 800) * 0.1 * vp.current.cpp; // 10% from left
    const targetCpp = bottleneck.duration / ((containerRef.current?.clientWidth || 800) * 0.8); // Fit node into 80%

    // Animate
    let step = 0;
    const startOff = vp.current.offset;
    const startCpp = vp.current.cpp;
    const interval = setInterval(() => {
      step++;
      const t = step / 30; // 30 frames
      const ease = 1 - Math.pow(1 - t, 3);
      vp.current.offset = startOff + (targetOffset - startOff) * ease;
      vp.current.cpp = startCpp + (targetCpp - startCpp) * ease;
      draw();
      
      if (step >= 30) {
        clearInterval(interval);
        setAiAnalysis({
          text: `Found critical bottleneck: [${bottleneck.name}] stalled for ${bottleneck.duration.toLocaleString()} cycles.`,
          rec: "Recommend enabling L2 Hardware Prefetcher and increasing AXI Burst Length from 16 to 64 beats to hide DRAM latency."
        });
      }
    }, 16);
  };

  const btnStyle = { fontSize: 10, padding: "2px 8px", borderRadius: 3, background: theme.bgSurface, color: theme.textDim, border: `1px solid ${theme.border}`, cursor: "pointer", transition: "all 0.2s" };

  return (
    <div className="w-full h-full flex flex-col relative" style={{ background: theme.bgPanel }}>
      <div className="flex items-center px-3 gap-3 shrink-0" style={{ height: 30, borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, letterSpacing: "0.05em" }}>FLAME GRAPH</span>
        <button onClick={() => { if(containerRef.current) { vp.current.offset=0; vp.current.cpp = totalCycles / containerRef.current.clientWidth; draw(); setAiAnalysis(null); } }} style={btnStyle} className="hover:opacity-80">Fit All</button>
        <button onClick={handleAIHotspot} style={{ ...btnStyle, background: theme.accent, color: "#fff", border: `1px solid ${theme.accent}`, display: "flex", alignItems: "center", gap: 4 }} className="hover:opacity-80">
           ✨ Find Bottleneck Spot
        </button>
        {loading && <span style={{ fontSize: 10, color: theme.textMuted }} className="animate-pulse">Loading...</span>}
        <div className="flex-1" />
        <span style={{ fontSize: 9, color: theme.textFaint }}>Ctrl+Scroll: zoom · Drag: pan</span>
      </div>
      
      <div 
        ref={containerRef} 
        className="flex-1 relative overflow-hidden" 
        style={{ cursor: vp.current.dragging ? "grabbing" : "crosshair" }}
        onMouseDown={e => { vp.current.dragging = true; vp.current.lastX = e.clientX; }}
        onMouseUp={() => vp.current.dragging = false}
        onMouseLeave={() => vp.current.dragging = false}
        onMouseMove={onMouseMove}
      >
        <canvas ref={canvasRef} className="absolute inset-0" />
        {tooltip && (
          <div className="absolute z-50 pointer-events-none rounded px-2 py-1.5 shadow-xl transition-all" style={{
            left: tooltip.x, top: tooltip.y, fontSize: 10, whiteSpace: "pre",
            background: theme.bgSurface, color: theme.text, border: `1px solid ${theme.border}`, boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
          }}>
            {tooltip.text}
          </div>
        )}

        {/* AI Analysis Floating Widget */}
        {aiAnalysis && (
            <div className="absolute top-6 left-1/2 transform -translate-x-1/2 w-[400px] rounded-lg p-4 shadow-2xl animate-in zoom-in slide-in-from-top-4 duration-300" style={{ background: theme.mode === "dark" ? "#252526" : "#fff", border: `1px solid ${theme.error}`, boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
               <div className="flex items-center gap-2 mb-2">
                 <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: theme.error }}></div>
                 <h4 style={{ fontSize: 12, fontWeight: 700, color: theme.error }}>Critical Stalls Detected</h4>
               </div>
               <p style={{ fontSize: 11, color: theme.text, marginBottom: 8, lineHeight: 1.5 }}>{aiAnalysis.text}</p>
               <div style={{ background: theme.mode === "dark" ? "#1e1e1e" : "#f5f5f5", padding: "8px 12px", borderRadius: 6, borderLeft: `3px solid ${theme.accent}` }}>
                 <p style={{ fontSize: 10, color: theme.textDim }}>💡 <strong>AI Recommendation:</strong><br/>{aiAnalysis.rec}</p>
               </div>
               <button onClick={() => setAiAnalysis(null)} className="absolute top-3 right-3" style={{ color: theme.textMuted }}>✕</button>
            </div>
        )}
      </div>
    </div>
  );
}
