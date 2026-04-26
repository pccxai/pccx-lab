// Module Boundary: core/
// Report generator — Markdown and HTML output from a `pccx-core`
// trace + optional synth report. Consumers pick a format via
// `Report::render(ReportFormat::Html)` or keep calling the free
// `render_markdown()` for backward compatibility.

use pccx_core::bottleneck::{detect, DetectorConfig};
use pccx_core::hw_model::HardwareModel;
use pccx_core::roofline::analyze_hierarchical;
use pccx_core::synth_report::SynthReport;
use pccx_core::trace::NpuTrace;

// ─── Document-tree types (Phase 4 M4.1) ─────────────────────────────────────

/// Output format selector passed to `Report::render`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportFormat {
    Markdown,
    Html,
}

/// Metadata block attached to every report.
#[derive(Debug, Clone)]
pub struct ReportMeta {
    pub title: String,
    /// Caller-supplied timestamp string (e.g. an ISO-8601 date, a Unix
    /// epoch string, or an empty string for headless/test callers).
    pub generated_at: String,
    pub pccx_version: String,
    pub trace_hash: Option<String>,
}

impl Default for ReportMeta {
    fn default() -> Self {
        Self {
            title: "pccx verification report".into(),
            generated_at: String::new(),
            pccx_version: env!("CARGO_PKG_VERSION").into(),
            trace_hash: None,
        }
    }
}

/// One entry in the Roofline section — mirrors `RooflineBand` but
/// carries only the fields the report renderer needs.
#[derive(Debug, Clone)]
pub struct RooflineEntry {
    pub label: String,
    pub ops_per_cycle: f64,
    pub bytes_per_cycle: f64,
    /// Memory tier label, e.g. "Register", "URAM L1", "DDR4".
    pub band: String,
}

/// One detected bottleneck window.
#[derive(Debug, Clone)]
pub struct BottleneckEntry {
    pub start_cycle: u64,
    pub end_cycle: u64,
    pub kind: String,
    /// Share of the window (0.0–1.0) dominated by this event kind.
    pub severity: f64,
}

/// A single logical section inside a `Report`.
#[derive(Debug, Clone)]
pub enum Section {
    Summary { title: String, body: String },
    TraceStats {
        total_cycles: u64,
        event_count: usize,
        per_type: Vec<(String, u64)>,
    },
    Roofline {
        points: Vec<RooflineEntry>,
    },
    SynthUtil {
        lut_pct: f64,
        ff_pct: f64,
        bram_pct: f64,
        dsp_pct: f64,
        wns: f64,
    },
    Bottleneck {
        intervals: Vec<BottleneckEntry>,
    },
    Custom {
        title: String,
        /// HTML/Markdown content — HTML-escaped when rendering to HTML.
        content: String,
    },
}

/// The full document tree.
#[derive(Debug, Clone)]
pub struct Report {
    pub meta: ReportMeta,
    pub sections: Vec<Section>,
}

// KV260 ZU5EV device totals used for percentage calculations.
// RAMB36 and RAMB18 are halved/combined: effective_bram = bram36 + bram18/2.
const KV260_TOTAL_LUT: f64 = 117_120.0;
const KV260_TOTAL_FF: f64 = 234_240.0;
const KV260_TOTAL_BRAM36: f64 = 144.0; // effective BRAM36 units
const KV260_TOTAL_DSP: f64 = 1_248.0;

// ─── Builder ────────────────────────────────────────────────────────────────

/// Fluent builder for `Report`.
pub struct ReportBuilder {
    meta: ReportMeta,
    sections: Vec<Section>,
}

impl ReportBuilder {
    fn new(title: &str) -> Self {
        Self {
            meta: ReportMeta {
                title: title.into(),
                ..ReportMeta::default()
            },
            sections: Vec::new(),
        }
    }

    pub fn generated_at(mut self, ts: impl Into<String>) -> Self {
        self.meta.generated_at = ts.into();
        self
    }

    pub fn trace_hash(mut self, hash: impl Into<String>) -> Self {
        self.meta.trace_hash = Some(hash.into());
        self
    }

    pub fn section(mut self, s: Section) -> Self {
        self.sections.push(s);
        self
    }

    pub fn build(self) -> Report {
        Report { meta: self.meta, sections: self.sections }
    }
}

// ─── Report impl ────────────────────────────────────────────────────────────

impl Report {
    /// Start a fluent builder.
    pub fn builder(title: &str) -> ReportBuilder {
        ReportBuilder::new(title)
    }

    /// Construct a standard report from a trace and optional synth data.
    /// Sections that lack input data are omitted.
    pub fn from_trace(trace: &NpuTrace, synth: Option<&SynthReport>) -> Self {
        let hw = HardwareModel::pccx_reference();
        let mut sections = Vec::new();

        // Trace stats section.
        let mut per_type: std::collections::BTreeMap<String, u64> =
            std::collections::BTreeMap::new();
        for ev in &trace.events {
            *per_type.entry(ev.event_type.clone()).or_insert(0) += 1;
        }
        sections.push(Section::TraceStats {
            total_cycles: trace.total_cycles,
            event_count: trace.events.len(),
            per_type: per_type.into_iter().collect(),
        });

        // Roofline section — hierarchical (four tiers).
        let bands = analyze_hierarchical(trace, &hw);
        let points: Vec<RooflineEntry> = bands
            .iter()
            .map(|b| RooflineEntry {
                label: b.level.clone(),
                ops_per_cycle: b.peak_gops,
                bytes_per_cycle: b.peak_bw_gbps,
                band: b.level.clone(),
            })
            .collect();
        sections.push(Section::Roofline { points });

        // Bottleneck section.
        let raw = detect(trace, &DetectorConfig::default());
        if !raw.is_empty() {
            let intervals = raw
                .iter()
                .map(|iv| BottleneckEntry {
                    start_cycle: iv.start_cycle,
                    end_cycle: iv.end_cycle,
                    kind: format!("{:?}", iv.kind),
                    severity: iv.share,
                })
                .collect();
            sections.push(Section::Bottleneck { intervals });
        }

        // Synth utilisation section.
        if let Some(sr) = synth {
            let eff_bram = sr.utilisation.rams_36 as f64
                + sr.utilisation.rams_18 as f64 / 2.0;
            sections.push(Section::SynthUtil {
                lut_pct: sr.utilisation.total_luts as f64 / KV260_TOTAL_LUT * 100.0,
                ff_pct: sr.utilisation.ffs as f64 / KV260_TOTAL_FF * 100.0,
                bram_pct: eff_bram / KV260_TOTAL_BRAM36 * 100.0,
                dsp_pct: sr.utilisation.dsps as f64 / KV260_TOTAL_DSP * 100.0,
                wns: sr.timing.wns_ns,
            });
        }

        Report {
            meta: ReportMeta::default(),
            sections,
        }
    }

    /// Render the document tree into the requested format.
    pub fn render(&self, format: ReportFormat) -> String {
        match format {
            ReportFormat::Markdown => render_report_markdown(self),
            ReportFormat::Html => render_html(self),
        }
    }
}

// ─── Markdown renderer ───────────────────────────────────────────────────────

fn render_report_markdown(report: &Report) -> String {
    let mut out = String::new();
    out.push_str("# ");
    out.push_str(&report.meta.title);
    out.push_str("\n\n");

    if !report.meta.generated_at.is_empty() {
        out.push_str(&format!("_Generated: {}_\n\n", report.meta.generated_at));
    }
    if let Some(hash) = &report.meta.trace_hash {
        out.push_str(&format!("_Trace hash: `{hash}`_\n\n"));
    }

    for section in &report.sections {
        match section {
            Section::Summary { title, body } => {
                out.push_str(&format!("## {title}\n\n{body}\n\n"));
            }
            Section::TraceStats { total_cycles, event_count, per_type } => {
                out.push_str("## Trace summary\n\n");
                out.push_str(&format!("- **Total cycles:** {total_cycles}\n"));
                out.push_str(&format!("- **Events:** {event_count}\n"));
                if !per_type.is_empty() {
                    out.push_str("\n| Event type | Count |\n|---|---:|\n");
                    for (ty, n) in per_type {
                        out.push_str(&format!("| `{ty}` | {n} |\n"));
                    }
                }
                out.push('\n');
            }
            Section::Roofline { points } => {
                out.push_str("## Roofline\n\n");
                if !points.is_empty() {
                    out.push_str("| Tier | Peak compute (GOPS) | Peak BW (GB/s) |\n");
                    out.push_str("|---|---:|---:|\n");
                    for p in points {
                        out.push_str(&format!(
                            "| {} | {:.1} | {:.1} |\n",
                            p.band, p.ops_per_cycle, p.bytes_per_cycle
                        ));
                    }
                }
                out.push('\n');
            }
            Section::SynthUtil { lut_pct, ff_pct, bram_pct, dsp_pct, wns } => {
                out.push_str("## Synthesis utilisation\n\n");
                out.push_str("| Resource | Utilisation (%) |\n|---|---:|\n");
                out.push_str(&format!("| LUT  | {lut_pct:.1} |\n"));
                out.push_str(&format!("| FF   | {ff_pct:.1} |\n"));
                out.push_str(&format!("| BRAM | {bram_pct:.1} |\n"));
                out.push_str(&format!("| DSP  | {dsp_pct:.1} |\n"));
                let timing_verdict = if *wns >= 0.0 { "met" } else { "NOT met" };
                out.push_str(&format!("\n- **Timing {timing_verdict}** (WNS {wns:.3} ns)\n\n"));
            }
            Section::Bottleneck { intervals } => {
                out.push_str("## Bottleneck intervals\n\n");
                if intervals.is_empty() {
                    out.push_str("_No contended windows detected._\n\n");
                } else {
                    out.push_str("| Start | End | Kind | Severity |\n|---:|---:|---|---:|\n");
                    for iv in intervals {
                        out.push_str(&format!(
                            "| {} | {} | {} | {:.0}% |\n",
                            iv.start_cycle,
                            iv.end_cycle,
                            iv.kind,
                            iv.severity * 100.0
                        ));
                    }
                    out.push('\n');
                }
            }
            Section::Custom { title, content } => {
                out.push_str(&format!("## {title}\n\n{content}\n\n"));
            }
        }
    }

    out.push_str("---\n");
    out.push_str("_Generated by pccx-reports ");
    out.push_str(env!("CARGO_PKG_VERSION"));
    out.push_str("_\n");
    out
}

// ─── HTML renderer ──────────────────────────────────────────────────────────

/// Escapes `<`, `>`, `&`, `"` so user-controlled strings are safe in HTML.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            o => out.push(o),
        }
    }
    out
}

fn render_html(report: &Report) -> String {
    let title = html_escape(&report.meta.title);
    let mut body = String::new();

    // Header block
    body.push_str(&format!("<h1 class=\"report-title\">{title}</h1>\n"));
    if !report.meta.generated_at.is_empty() {
        body.push_str(&format!(
            "<p class=\"report-meta\">Generated: {}</p>\n",
            html_escape(&report.meta.generated_at)
        ));
    }
    if let Some(hash) = &report.meta.trace_hash {
        body.push_str(&format!(
            "<p class=\"report-meta\">Trace hash: <code>{}</code></p>\n",
            html_escape(hash)
        ));
    }

    for section in &report.sections {
        match section {
            Section::Summary { title, body: text } => {
                body.push_str(&format!(
                    "<section><h2>{}</h2><p>{}</p></section>\n",
                    html_escape(title),
                    html_escape(text)
                ));
            }
            Section::TraceStats { total_cycles, event_count, per_type } => {
                body.push_str("<section>\n<h2>Trace summary</h2>\n");
                body.push_str(&format!(
                    "<dl><dt>Total cycles</dt><dd>{total_cycles}</dd>\
                     <dt>Events</dt><dd>{event_count}</dd></dl>\n"
                ));
                if !per_type.is_empty() {
                    body.push_str(
                        "<table>\
                         <thead><tr><th>Event type</th><th>Count</th></tr></thead>\
                         <tbody>\n",
                    );
                    for (ty, n) in per_type {
                        body.push_str(&format!(
                            "<tr><td><code>{}</code></td><td>{n}</td></tr>\n",
                            html_escape(ty)
                        ));
                    }
                    body.push_str("</tbody></table>\n");
                }
                body.push_str("</section>\n");
            }
            Section::Roofline { points } => {
                body.push_str("<section>\n<h2>Roofline</h2>\n");
                if !points.is_empty() {
                    body.push_str(
                        "<table>\
                         <thead><tr>\
                         <th>Tier</th>\
                         <th>Peak compute (GOPS)</th>\
                         <th>Peak BW (GB/s)</th>\
                         </tr></thead><tbody>\n",
                    );
                    for p in points {
                        body.push_str(&format!(
                            "<tr><td>{}</td><td>{:.1}</td><td>{:.1}</td></tr>\n",
                            html_escape(&p.band),
                            p.ops_per_cycle,
                            p.bytes_per_cycle
                        ));
                    }
                    body.push_str("</tbody></table>\n");
                }
                body.push_str("</section>\n");
            }
            Section::SynthUtil { lut_pct, ff_pct, bram_pct, dsp_pct, wns } => {
                let timing_class = if *wns >= 0.0 { "badge-ok" } else { "badge-fail" };
                let timing_label = if *wns >= 0.0 { "Timing met" } else { "Timing NOT met" };
                body.push_str("<section>\n<h2>Synthesis utilisation</h2>\n");
                body.push_str(
                    "<table>\
                     <thead><tr><th>Resource</th><th>Utilisation (%)</th></tr></thead>\
                     <tbody>\n",
                );
                for (res, pct) in [("LUT", lut_pct), ("FF", ff_pct), ("BRAM", bram_pct), ("DSP", dsp_pct)] {
                    body.push_str(&format!("<tr><td>{res}</td><td>{pct:.1}</td></tr>\n"));
                }
                body.push_str("</tbody></table>\n");
                body.push_str(&format!(
                    "<p><span class=\"badge {timing_class}\">{timing_label}</span> \
                     WNS <strong>{wns:.3} ns</strong></p>\n"
                ));
                body.push_str("</section>\n");
            }
            Section::Bottleneck { intervals } => {
                body.push_str("<section>\n<h2>Bottleneck intervals</h2>\n");
                if intervals.is_empty() {
                    body.push_str("<p class=\"empty\">No contended windows detected.</p>\n");
                } else {
                    body.push_str(
                        "<table>\
                         <thead><tr>\
                         <th>Start cycle</th><th>End cycle</th>\
                         <th>Kind</th><th>Severity</th>\
                         </tr></thead><tbody>\n",
                    );
                    for iv in intervals {
                        body.push_str(&format!(
                            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{:.0}%</td></tr>\n",
                            iv.start_cycle,
                            iv.end_cycle,
                            html_escape(&iv.kind),
                            iv.severity * 100.0
                        ));
                    }
                    body.push_str("</tbody></table>\n");
                }
                body.push_str("</section>\n");
            }
            Section::Custom { title, content } => {
                body.push_str(&format!(
                    "<section><h2>{}</h2><div class=\"custom-content\">{}</div></section>\n",
                    html_escape(title),
                    html_escape(content)
                ));
            }
        }
    }

    // Footer
    body.push_str(&format!(
        "<footer><p>Generated by pccx-reports {}</p></footer>\n",
        env!("CARGO_PKG_VERSION")
    ));

    // Assemble the full page.
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
/* pccx-lab dark theme — matches ThemeContext.tsx DARK palette */
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
:root {{
  --bg:        #1c1c1e;
  --bg-panel:  #252526;
  --bg-surface:#2d2d2d;
  --border:    #3e3e3e;
  --text:      #d4d4d4;
  --text-dim:  #cccccc;
  --text-muted:#858585;
  --accent:    #0098ff;
  --success:   #4ec86b;
  --error:     #f14c4c;
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "Fira Code", monospace;
  --radius:    6px;
}}
body {{
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  padding: 32px 24px;
  max-width: 960px;
  margin: 0 auto;
}}
h1.report-title {{
  font-size: 1.6rem;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 4px;
}}
h2 {{
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--accent);
  margin: 28px 0 10px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}}
p.report-meta {{
  color: var(--text-muted);
  font-size: 0.85rem;
  margin-top: 4px;
}}
section {{
  margin-bottom: 8px;
}}
dl {{
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 16px;
  margin: 8px 0;
}}
dt {{ color: var(--text-muted); }}
dd {{ font-variant-numeric: tabular-nums; }}
table {{
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  background: var(--bg-panel);
  border-radius: var(--radius);
  overflow: hidden;
}}
thead tr {{
  background: var(--bg-surface);
}}
th {{
  text-align: left;
  padding: 8px 12px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
}}
td {{
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}}
tr:last-child td {{ border-bottom: none; }}
code {{
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--bg-surface);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text-dim);
}}
.badge {{
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.78rem;
  font-weight: 600;
  margin-right: 6px;
}}
.badge-ok   {{ background: rgba(78,200,107,0.15); color: var(--success); }}
.badge-fail {{ background: rgba(241,76,76,0.15);  color: var(--error);   }}
.empty {{ color: var(--text-muted); font-style: italic; }}
.custom-content {{ white-space: pre-wrap; font-family: var(--font-mono); font-size: 0.85em; }}
footer {{
  margin-top: 40px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.8rem;
}}
@media (max-width: 640px) {{
  body {{ padding: 20px 16px; }}
  table {{ font-size: 0.82rem; }}
}}
</style>
</head>
<body>
{body}
</body>
</html>
"#
    )
}

// ─── Backward-compatible free function ───────────────────────────────────────

/// Build a Markdown report that snapshots the state of a pccx-FPGA
/// verification run. Any section whose input is `None` is silently
/// omitted so callers can pick and choose what to render.
///
/// This is the original Phase-1 API; it is now implemented by building a
/// `Report` document tree and calling `Report::render(ReportFormat::Markdown)`.
pub fn render_markdown(
    trace: Option<&NpuTrace>,
    synth: Option<&SynthReport>,
) -> String {
    if trace.is_none() && synth.is_none() {
        return "# pccx verification report\n\n\
                _No trace and no synth report available to summarise._\n"
            .into();
    }
    let report = match trace {
        Some(tr) => Report::from_trace(tr, synth),
        None => {
            // Synth-only path: build a minimal report with just the synth section.
            let mut r = Report {
                meta: ReportMeta::default(),
                sections: Vec::new(),
            };
            if let Some(sr) = synth {
                let eff_bram = sr.utilisation.rams_36 as f64
                    + sr.utilisation.rams_18 as f64 / 2.0;
                r.sections.push(Section::SynthUtil {
                    lut_pct: sr.utilisation.total_luts as f64 / KV260_TOTAL_LUT * 100.0,
                    ff_pct: sr.utilisation.ffs as f64 / KV260_TOTAL_FF * 100.0,
                    bram_pct: eff_bram / KV260_TOTAL_BRAM36 * 100.0,
                    dsp_pct: sr.utilisation.dsps as f64 / KV260_TOTAL_DSP * 100.0,
                    wns: sr.timing.wns_ns,
                });
                // Also add a synthesis status narrative for the old raw-counts table
                // that the legacy tests check (top module + device line).
                let top = &sr.utilisation.top_module;
                let dev = &sr.device;
                r.sections.push(Section::Summary {
                    title: "Synthesis status".into(),
                    body: format!(
                        "Top module: `{top}`  Device: `{dev}`\n\n\
                         | Resource | Count |\n|---|---:|\n\
                         | LUT    | {} |\n\
                         | Logic LUT | {} |\n\
                         | FF     | {} |\n\
                         | RAMB36 | {} |\n\
                         | RAMB18 | {} |\n\
                         | URAM   | {} |\n\
                         | DSP    | {} |\n\n\
                         **WNS:** {:.3} ns on `{}`  \
                         **Endpoints:** {} failing / {} total  \
                         {}",
                        sr.utilisation.total_luts,
                        sr.utilisation.logic_luts,
                        sr.utilisation.ffs,
                        sr.utilisation.rams_36,
                        sr.utilisation.rams_18,
                        sr.utilisation.urams,
                        sr.utilisation.dsps,
                        sr.timing.wns_ns,
                        if sr.timing.worst_clock.is_empty() { "—" } else { &sr.timing.worst_clock },
                        sr.timing.failing_endpoints,
                        sr.timing.total_endpoints,
                        if sr.timing.is_timing_met { "Timing met" } else { "Timing NOT met" },
                    ),
                });
            }
            r
        }
    };
    report.render(ReportFormat::Markdown)
}

// ─── Unstable plugin API (Phase 1 M1.2) ──────────────────────────────────────
//
// The `ReportRenderer` trait lets callers pick a renderer at runtime (for
// the pccx-ide "export as..." menu, CI logs, PR bodies). Today only
// `MarkdownFormat` ships; HTML and PDF land during Phase 4.
//
// SEMVER NOTE: this trait is unstable until pccx-lab v0.3. Breaking
// changes land on minor bumps; downstream crates should pin the minor
// version until the surface stabilises.

/// A single report output format. Implementations render a `.pccx`
/// trace + optional synth report into the bytes of a specific file
/// format.
pub trait ReportRenderer {
    /// Produce the report as a byte stream. Callers write this to a
    /// file, a `<pre>` block, or the PR body as-is.
    fn render(
        &self,
        trace: Option<&NpuTrace>,
        synth: Option<&SynthReport>,
    ) -> Vec<u8>;

    /// Human-readable format name (e.g. `"Markdown"`, `"HTML"`).
    fn name(&self) -> &'static str;

    /// File extension including no leading dot (e.g. `"md"`, `"html"`).
    fn extension(&self) -> &'static str;

    /// IANA MIME type (e.g. `"text/markdown"`, `"application/pdf"`).
    fn mime_type(&self) -> &'static str;
}

/// Markdown report renderer — wraps the existing `render_markdown` free
/// function so callers can hold it behind a `Box<dyn ReportRenderer>`.
#[derive(Debug, Default, Clone, Copy)]
pub struct MarkdownFormat;

impl ReportRenderer for MarkdownFormat {
    fn render(
        &self,
        trace: Option<&NpuTrace>,
        synth: Option<&SynthReport>,
    ) -> Vec<u8> {
        render_markdown(trace, synth).into_bytes()
    }

    fn name(&self) -> &'static str { "Markdown" }
    fn extension(&self) -> &'static str { "md" }
    fn mime_type(&self) -> &'static str { "text/markdown" }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use pccx_core::synth_report::{TimingSummary, UtilSummary};
    use pccx_core::trace::NpuEvent;

    // ── Backward-compat: original three tests must still pass ──────────────

    #[test]
    fn test_render_empty_is_graceful() {
        let md = render_markdown(None, None);
        assert!(md.contains("# pccx verification report"));
        assert!(md.contains("No trace and no synth report"));
    }

    #[test]
    fn test_render_trace_only() {
        let trace = NpuTrace {
            total_cycles: 100,
            events: vec![
                NpuEvent::new(0, 0,  50, "MAC_COMPUTE"),
                NpuEvent::new(1, 50, 50, "DMA_READ"),
            ],
        };
        let md = render_markdown(Some(&trace), None);
        assert!(md.contains("## Trace summary"));
        assert!(md.contains("Total cycles"));
        assert!(md.contains("100"));
        assert!(md.contains("`MAC_COMPUTE`"));
        assert!(md.contains("## Roofline"));
        assert!(!md.contains("## Synthesis"),
            "should not emit synth when input was None");
    }

    #[test]
    fn test_render_synth_with_failure_flagged() {
        let synth = SynthReport {
            utilisation: UtilSummary {
                top_module: "NPU_top".into(),
                total_luts: 5611,
                logic_luts: 5570,
                ffs: 8458,
                rams_36: 80,
                rams_18: 8,
                urams:   56,
                dsps:     4,
            },
            timing: TimingSummary {
                wns_ns: -9.792,
                tns_ns: -3615.208,
                failing_endpoints: 4194,
                total_endpoints:   28602,
                is_timing_met:     false,
                worst_clock:       "core_clk".into(),
            },
            device: "xck26-sfvc784-2LV-c".into(),
        };
        let md = render_markdown(None, Some(&synth));
        assert!(md.contains("NPU_top"));
        assert!(md.contains("xck26-sfvc784"));
        assert!(md.contains("| DSP    | 4 |"));
        assert!(md.contains("Timing NOT met"));
        assert!(md.contains("-9.792"));
        assert!(md.contains("core_clk"));
    }

    // ── Builder pattern ────────────────────────────────────────────────────

    #[test]
    fn test_builder_assembles_report() {
        let report = Report::builder("My test report")
            .generated_at("2026-04-26")
            .trace_hash("deadbeef")
            .section(Section::Summary {
                title: "Overview".into(),
                body: "All systems nominal.".into(),
            })
            .build();

        assert_eq!(report.meta.title, "My test report");
        assert_eq!(report.meta.generated_at, "2026-04-26");
        assert_eq!(report.meta.trace_hash.as_deref(), Some("deadbeef"));
        assert_eq!(report.sections.len(), 1);
    }

    #[test]
    fn test_builder_markdown_contains_custom_section() {
        let report = Report::builder("Builder test")
            .section(Section::Custom {
                title: "Custom".into(),
                content: "hello world".into(),
            })
            .build();
        let md = report.render(ReportFormat::Markdown);
        assert!(md.contains("## Custom"));
        assert!(md.contains("hello world"));
    }

    // ── from_trace construction ────────────────────────────────────────────

    #[test]
    fn test_from_trace_builds_sections() {
        let trace = NpuTrace {
            total_cycles: 500,
            events: vec![
                NpuEvent::new(0, 0,   300, "MAC_COMPUTE"),
                NpuEvent::new(1, 300, 200, "DMA_READ"),
            ],
        };
        let report = Report::from_trace(&trace, None);
        // Must have at least TraceStats and Roofline.
        let has_trace_stats = report.sections.iter().any(|s| {
            matches!(s, Section::TraceStats { .. })
        });
        let has_roofline = report.sections.iter().any(|s| {
            matches!(s, Section::Roofline { .. })
        });
        assert!(has_trace_stats, "from_trace must emit a TraceStats section");
        assert!(has_roofline, "from_trace must emit a Roofline section");
    }

    #[test]
    fn test_from_trace_with_synth_includes_util() {
        let trace = NpuTrace { total_cycles: 100, events: vec![] };
        let synth = SynthReport {
            utilisation: UtilSummary {
                top_module: "NPU_top".into(),
                total_luts: 10000,
                logic_luts: 9500,
                ffs: 20000,
                rams_36: 10,
                rams_18: 4,
                urams: 0,
                dsps: 100,
            },
            timing: TimingSummary {
                wns_ns: 1.5,
                tns_ns: 0.0,
                failing_endpoints: 0,
                total_endpoints: 5000,
                is_timing_met: true,
                worst_clock: "clk".into(),
            },
            device: "xck26-sfvc784-2LV-c".into(),
        };
        let report = Report::from_trace(&trace, Some(&synth));
        let has_synth = report.sections.iter().any(|s| {
            matches!(s, Section::SynthUtil { .. })
        });
        assert!(has_synth, "from_trace with synth must emit SynthUtil section");
    }

    // ── HTML renderer ──────────────────────────────────────────────────────

    #[test]
    fn test_html_contains_doctype_and_style() {
        let report = Report::builder("HTML test").build();
        let html = report.render(ReportFormat::Html);
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("<style>"));
        assert!(html.contains("#1c1c1e"));
    }

    #[test]
    fn test_html_contains_table_for_trace_stats() {
        let trace = NpuTrace {
            total_cycles: 256,
            events: vec![NpuEvent::new(0, 0, 256, "MAC_COMPUTE")],
        };
        let report = Report::from_trace(&trace, None);
        let html = report.render(ReportFormat::Html);
        assert!(html.contains("<table>"));
        assert!(html.contains("MAC_COMPUTE"));
        assert!(html.contains("256"));
    }

    #[test]
    fn test_html_escapes_custom_content() {
        let report = Report::builder("Escape test")
            .section(Section::Custom {
                title: "Raw".into(),
                content: "<script>alert('xss')</script>".into(),
            })
            .build();
        let html = report.render(ReportFormat::Html);
        assert!(!html.contains("<script>"), "raw <script> must not appear");
        assert!(html.contains("&lt;script&gt;"), "must be HTML-escaped");
    }

    #[test]
    fn test_html_badge_timing_met() {
        let report = Report::builder("Timing")
            .section(Section::SynthUtil {
                lut_pct: 10.0,
                ff_pct: 5.0,
                bram_pct: 2.0,
                dsp_pct: 1.0,
                wns: 2.5,
            })
            .build();
        let html = report.render(ReportFormat::Html);
        assert!(html.contains("badge-ok"));
        assert!(html.contains("Timing met"));
    }

    #[test]
    fn test_html_badge_timing_not_met() {
        let report = Report::builder("Timing fail")
            .section(Section::SynthUtil {
                lut_pct: 80.0,
                ff_pct: 40.0,
                bram_pct: 90.0,
                dsp_pct: 70.0,
                wns: -3.1,
            })
            .build();
        let html = report.render(ReportFormat::Html);
        assert!(html.contains("badge-fail"));
        assert!(html.contains("Timing NOT met"));
    }

    // ── MarkdownFormat trait object ────────────────────────────────────────

    #[test]
    fn test_markdown_format_trait_object() {
        let fmt: Box<dyn ReportRenderer> = Box::new(MarkdownFormat);
        assert_eq!(fmt.name(), "Markdown");
        assert_eq!(fmt.extension(), "md");
        assert_eq!(fmt.mime_type(), "text/markdown");
        let bytes = fmt.render(None, None);
        assert!(!bytes.is_empty());
    }
}
