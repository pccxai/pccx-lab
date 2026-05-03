import { useState, useMemo, useCallback, memo } from "react";
import { useTheme } from "./ThemeContext";
import { Cpu, AlertTriangle, CheckCircle2, RotateCcw, Play } from "lucide-react";

// ─── Constants ──────────────────────────────────────────────────────────────

const FREQ_MHZ = 300; // Default local analysis clock.

// ─── Types ──────────────────────────────────────────────────────────────────

interface Params {
  macSize: number;       // N for NxN MAC array; range 4–16
  activationKB: number;  // activation SRAM buffer size
  weightKB: number;      // weight SRAM buffer size
  pipelineDepth: number; // stage count
  dmaChannels: number;   // parallel DMA channels
}

type TabId = "calculator" | "distribution" | "recommendations";

// ─── Calculations ────────────────────────────────────────────────────────────

interface Metrics {
  occupancyPct: number;    // 0–100
  topsThroughput: number;  // tera-ops/s (INT4)
  bwRequiredGBps: number;  // GB/s
  limiter: string;
  macUtilPct: number;
  bufferUtilPct: number;
  pipelineUtilPct: number;
}

function compute(p: Params): Metrics {
  // Buffer overhead: more buffer → less stall, modelled as log scale
  const bufTotal = p.activationKB + p.weightKB;
  const bufFactor = Math.min(1, Math.log2(bufTotal / 8) / Math.log2(512 / 8));

  // Pipeline efficiency: diminishing returns past 8 stages
  const pipeFactor = Math.min(1, 8 / p.pipelineDepth);

  // DMA concurrency contribution
  const dmaFactor = Math.min(1, p.dmaChannels / 4);

  // MAC utilisation scales with buffer fill rate
  const macUtilPct = Math.round(Math.min(100, bufFactor * pipeFactor * dmaFactor * 100));

  // Buffer utilisation: how filled is the combined buffer
  const bufferUtilPct = Math.round(Math.min(100, bufFactor * 100));

  // Pipeline utilisation: penalised by undersized buffers causing stalls
  const pipelineUtilPct = Math.round(Math.min(100, pipeFactor * bufFactor * 100));

  // Overall occupancy: harmonic-mean-like combination
  const occupancyPct = Math.round((macUtilPct + bufferUtilPct + pipelineUtilPct) / 3);

  // Compute throughput: mac^2 * 2 ops/cycle * freq * INT4 2x factor
  const topsThroughput = (p.macSize * p.macSize * 2 * 2 * FREQ_MHZ) / 1e6;

  // Memory bandwidth required: 2 bytes/op (INT4 pair), scaled by DMA channels
  const opsPerSec = p.macSize * p.macSize * 2 * FREQ_MHZ * 1e6;
  const bwRequiredGBps = (opsPerSec * 0.5) / 1e9 / p.dmaChannels;

  // Identify bottleneck
  let limiter = "Balanced";
  const minUtil = Math.min(macUtilPct, bufferUtilPct, pipelineUtilPct);
  if (minUtil === macUtilPct)        limiter = "MAC Array";
  else if (minUtil === bufferUtilPct) limiter = "Buffer Size";
  else if (minUtil === pipelineUtilPct) limiter = "Pipeline Depth";

  return {
    occupancyPct,
    topsThroughput,
    bwRequiredGBps,
    limiter,
    macUtilPct,
    bufferUtilPct,
    pipelineUtilPct,
  };
}

function recommendations(p: Params, m: Metrics): string[] {
  const recs: string[] = [];

  if (m.occupancyPct < 50) {
    recs.push("Occupancy is below 50%. Profile memory fill rate before increasing MAC array size.");
  }
  if (p.activationKB < 32 && m.bufferUtilPct < 70) {
    recs.push("Increase activation buffer to at least 32 KB to reduce fill-rate stalls.");
  }
  if (p.weightKB < 32 && m.bufferUtilPct < 70) {
    recs.push("Increase weight buffer to at least 32 KB for better reuse across iterations.");
  }
  if (p.pipelineDepth > 8 && m.pipelineUtilPct < 60) {
    recs.push("Pipeline depth exceeds useful limit for the current buffer size. Reduce to 8.");
  }
  if (p.dmaChannels < 4 && m.bwRequiredGBps > 10) {
    recs.push("Add DMA channels (target: 4) to sustain required memory bandwidth.");
  }
  if (p.macSize >= 12 && (p.activationKB + p.weightKB) < 64) {
    recs.push("Large MAC array requires at least 64 KB combined buffer to stay compute-bound.");
  }
  if (m.occupancyPct >= 80) {
    recs.push("Configuration is well-balanced. Consider increasing MAC array size for higher throughput.");
  }
  if (recs.length === 0) {
    recs.push("No actionable suggestions. Occupancy and balance look reasonable.");
  }
  return recs;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  theme: ReturnType<typeof useTheme>;
}

const SliderRow = memo(function SliderRow({
  label, value, min, max, step, format, onChange, theme,
}: SliderRowProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11, color: theme.textMuted }}>{label}</span>
        <span style={{
          fontSize: 11, fontFamily: theme.fontMono,
          color: theme.text, background: theme.bgSurface,
          padding: "1px 6px", borderRadius: theme.radiusSm,
          border: `0.5px solid ${theme.borderDim}`,
        }}>
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          accentColor: theme.accent,
          cursor: "pointer",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: theme.textFaint }}>
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
});

interface UtilBarProps {
  label: string;
  usedPct: number;
  theme: ReturnType<typeof useTheme>;
}

const UtilBar = memo(function UtilBar({ label, usedPct, theme }: UtilBarProps) {
  const used = Math.max(0, Math.min(100, usedPct));
  const barColor = used >= 70 ? theme.success : used >= 40 ? theme.warning : theme.error;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11, color: theme.textMuted }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: theme.fontMono, color: barColor }}>{used}%</span>
      </div>
      <div style={{
        height: 12, borderRadius: 4,
        background: theme.bgSurface,
        border: `0.5px solid ${theme.borderDim}`,
        overflow: "hidden",
        display: "flex",
      }}>
        <div style={{
          width: `${used}%`,
          background: barColor,
          transition: `width 0.25s ${theme.ease}`,
          borderRadius: used < 100 ? "4px 0 0 4px" : 4,
        }} />
        <div style={{
          flex: 1,
          background: theme.bgPanel,
        }} />
      </div>
    </div>
  );
});

// ─── Main Component ──────────────────────────────────────────────────────────

const DEFAULT_PARAMS: Params = {
  macSize: 8,
  activationKB: 64,
  weightKB: 64,
  pipelineDepth: 8,
  dmaChannels: 4,
};

export const OccupancyCalculator = memo(function OccupancyCalculator() {
  const theme = useTheme();

  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [staged, setStaged] = useState<Params>(DEFAULT_PARAMS);
  const [autoApply, setAutoApply] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("calculator");

  // Applied params drive metric display
  const applied = autoApply ? staged : params;
  const metrics = useMemo(() => compute(applied), [applied]);
  const recs = useMemo(() => recommendations(applied, metrics), [applied, metrics]);

  const handleChange = useCallback(<K extends keyof Params>(key: K, val: Params[K]) => {
    setStaged(p => ({ ...p, [key]: val }));
    if (autoApply) setParams(p => ({ ...p, [key]: val }));
  }, [autoApply]);

  const handleApply = useCallback(() => {
    setParams(staged);
  }, [staged]);

  const handleReset = useCallback(() => {
    setParams(DEFAULT_PARAMS);
    setStaged(DEFAULT_PARAMS);
  }, []);

  const occupancyColor = metrics.occupancyPct >= 70
    ? theme.success
    : metrics.occupancyPct >= 40
    ? theme.warning
    : theme.error;

  // ── Tab content ────────────────────────────────────────────────────────

  const renderCalculator = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 0 8px" }}>
      <div style={{
        background: theme.bgSurface,
        border: `0.5px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusMd,
        padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 14,
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
          Parameters
        </span>
        <SliderRow
          label="MAC Array Size (NxN)"
          value={staged.macSize} min={4} max={16} step={2}
          format={v => `${v}x${v}`}
          onChange={v => handleChange("macSize", v)}
          theme={theme}
        />
        <SliderRow
          label="Activation Buffer"
          value={staged.activationKB} min={4} max={256} step={4}
          format={v => `${v} KB`}
          onChange={v => handleChange("activationKB", v)}
          theme={theme}
        />
        <SliderRow
          label="Weight Buffer"
          value={staged.weightKB} min={4} max={256} step={4}
          format={v => `${v} KB`}
          onChange={v => handleChange("weightKB", v)}
          theme={theme}
        />
        <SliderRow
          label="Pipeline Depth"
          value={staged.pipelineDepth} min={2} max={16} step={1}
          format={v => `${v} stages`}
          onChange={v => handleChange("pipelineDepth", v)}
          theme={theme}
        />
        <SliderRow
          label="DMA Channels"
          value={staged.dmaChannels} min={1} max={8} step={1}
          format={v => `${v} ch`}
          onChange={v => handleChange("dmaChannels", v)}
          theme={theme}
        />
      </div>

      {/* Computed metrics */}
      <div style={{
        background: theme.bgSurface,
        border: `0.5px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusMd,
        padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
          Computed Metrics
        </span>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            ["Throughput (INT4)", `${metrics.topsThroughput.toFixed(2)} TOPS`],
            ["BW Required", `${metrics.bwRequiredGBps.toFixed(1)} GB/s`],
            ["Frequency", `${FREQ_MHZ} MHz`],
            ["MAC Count", `${applied.macSize * applied.macSize}`],
          ].map(([label, val]) => (
            <div key={label as string} style={{
              background: theme.bg,
              border: `0.5px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              padding: "6px 8px",
            }}>
              <div style={{ fontSize: 10, color: theme.textMuted }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: theme.fontMono, color: theme.text }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderDistribution = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 0 8px" }}>
      {/* Occupancy headline */}
      <div style={{
        background: metrics.occupancyPct < 50 ? theme.errorBg : theme.successBg,
        border: `0.5px solid ${occupancyColor}`,
        borderRadius: theme.radiusMd,
        padding: "12px 14px",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        {metrics.occupancyPct < 50
          ? <AlertTriangle size={18} style={{ color: theme.error, flexShrink: 0 }} />
          : <CheckCircle2 size={18} style={{ color: theme.success, flexShrink: 0 }} />}
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: theme.fontMono, color: occupancyColor }}>
            {metrics.occupancyPct}%
          </div>
          <div style={{ fontSize: 11, color: theme.textMuted }}>
            {metrics.occupancyPct < 50 ? "Low occupancy — review bottleneck" : "Current occupancy"}
          </div>
        </div>
        <div style={{
          marginLeft: "auto",
          background: theme.bgSurface,
          border: `0.5px solid ${theme.border}`,
          borderRadius: theme.radiusSm,
          padding: "3px 8px",
          fontSize: 10, fontWeight: 600, color: theme.text,
        }}>
          Limiter: {metrics.limiter}
        </div>
      </div>

      {/* Stacked utilisation bars */}
      <div style={{
        background: theme.bgSurface,
        border: `0.5px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusMd,
        padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
          Utilisation Breakdown
        </span>
        <UtilBar label="MAC Utilization" usedPct={metrics.macUtilPct} theme={theme} />
        <UtilBar label="Buffer Utilization" usedPct={metrics.bufferUtilPct} theme={theme} />
        <UtilBar label="Pipeline Utilization" usedPct={metrics.pipelineUtilPct} theme={theme} />
      </div>

      {/* Limiter badge detail */}
      {metrics.limiter !== "Balanced" && (
        <div style={{
          background: theme.warningBg,
          border: `0.5px solid ${theme.warning}`,
          borderRadius: theme.radiusSm,
          padding: "8px 12px",
          display: "flex", alignItems: "center", gap: 8,
          fontSize: 11,
        }}>
          <AlertTriangle size={13} style={{ color: theme.warning, flexShrink: 0 }} />
          <span style={{ color: theme.text }}>
            Bottleneck: <strong>{metrics.limiter}</strong> is constraining overall occupancy.
          </span>
        </div>
      )}
    </div>
  );

  const renderRecommendations = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "0 0 8px" }}>
      <div style={{
        background: theme.bgSurface,
        border: `0.5px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusMd,
        padding: "12px 14px",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
          Suggestions
        </span>
        {recs.map((rec, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: "6px 8px",
            background: theme.bg,
            border: `0.5px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
          }}>
            <span style={{ color: theme.accent, marginTop: 1, flexShrink: 0 }}>&bull;</span>
            <span style={{ fontSize: 11, color: theme.text, lineHeight: 1.5 }}>{rec}</span>
          </div>
        ))}
      </div>

      <div style={{
        background: theme.bgSurface,
        border: `0.5px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusMd,
        padding: "10px 14px",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textMuted }}>
          Target Configuration
        </span>
        <div style={{ fontSize: 11, color: theme.textMuted, lineHeight: 1.6 }}>
          For the configured local target: 8x8 MAC, 128 KB activation + 128 KB weight, 8 pipeline stages, 4 DMA channels.
          Tune pipelineDepth down if buffer pressure is the limiter.
        </div>
      </div>
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────

  const TABS: { id: TabId; label: string }[] = [
    { id: "calculator", label: "Calculator" },
    { id: "distribution", label: "Distribution" },
    { id: "recommendations", label: "Recommendations" },
  ];

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", overflow: "hidden",
      background: theme.bg, color: theme.text,
      fontFamily: theme.fontSans,
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px 0",
        flexShrink: 0,
      }}>
        <Cpu size={14} style={{ color: theme.accent }} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>NPU Occupancy Calculator</span>
      </div>

      {/* Tab bar */}
      <div style={{
        display: "flex", gap: 2,
        padding: "8px 14px 0",
        borderBottom: `0.5px solid ${theme.borderSubtle}`,
        flexShrink: 0,
      }}>
        {TABS.map(tab => (
          <button key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              border: "none",
              borderRadius: "4px 4px 0 0",
              cursor: "pointer",
              background: activeTab === tab.id ? theme.bgSurface : "transparent",
              color: activeTab === tab.id ? theme.text : theme.textMuted,
              borderBottom: activeTab === tab.id ? `1.5px solid ${theme.accent}` : "1.5px solid transparent",
              transition: `color 0.12s ${theme.ease}`,
            }}>
            {tab.label}
          </button>
        ))}
        {/* Auto-apply toggle */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, paddingBottom: 4 }}>
          <label style={{ fontSize: 10, color: theme.textMuted, cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={autoApply}
              onChange={e => setAutoApply(e.target.checked)}
              style={{ marginRight: 4, accentColor: theme.accent }}
            />
            Auto-apply
          </label>
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 14px" }}>
        {activeTab === "calculator" && renderCalculator()}
        {activeTab === "distribution" && renderDistribution()}
        {activeTab === "recommendations" && renderRecommendations()}
      </div>

      {/* Footer actions */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 14px",
        borderTop: `0.5px solid ${theme.borderSubtle}`,
        flexShrink: 0,
      }}>
        <button
          onClick={handleReset}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 10px", fontSize: 11, cursor: "pointer", border: "none",
            background: theme.bgSurface, color: theme.textMuted,
            borderRadius: theme.radiusSm,
            transition: `background 0.12s ${theme.ease}`,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = theme.bgHover)}
          onMouseLeave={e => (e.currentTarget.style.background = theme.bgSurface)}
        >
          <RotateCcw size={11} /> Reset
        </button>
        {!autoApply && (
          <button
            onClick={handleApply}
            style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "4px 10px", fontSize: 11, cursor: "pointer", border: "none",
              background: theme.accent, color: "#fff",
              borderRadius: theme.radiusSm,
              transition: `opacity 0.12s ${theme.ease}`,
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "0.85")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
          >
            <Play size={11} /> Apply
          </button>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10, color: theme.textFaint }}>
          Configured local target @ {FREQ_MHZ} MHz
        </span>
      </div>
    </div>
  );
});

export default OccupancyCalculator;
