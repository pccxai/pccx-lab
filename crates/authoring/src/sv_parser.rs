// Module: sv_parser
// Regex-based SystemVerilog module extractor for the Phase 6 M6.1
// SV-docstring-to-ISA-PDF pipeline.
//
// Parses module declarations, port lists, parameter blocks, and
// preceding doc-comments from `.sv` source files without requiring
// a full grammar (tree-sitter-verilog is not reliably available on
// crates.io). Good enough for the pccx RTL codebase where modules
// follow the `npu_interfaces.svh` port-prefix conventions.

#[derive(Debug, Clone, serde::Serialize)]
pub struct SvModule {
    pub name: String,
    pub ports: Vec<SvPort>,
    pub parameters: Vec<SvParam>,
    pub doc_comment: Option<String>,
    pub line_number: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SvPort {
    pub name: String,
    pub direction: PortDirection,
    pub width: String,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum PortDirection {
    Input,
    Output,
    Inout,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SvParam {
    pub name: String,
    pub default_value: Option<String>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SvParseResult {
    pub modules: Vec<SvModule>,
    pub file_path: String,
    pub total_lines: usize,
}

/// Parse a SystemVerilog source file and extract module declarations,
/// ports, parameters, and doc comments.
pub fn parse_sv(source: &str, file_path: &str) -> SvParseResult {
    let mut modules = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let total_lines = lines.len();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        // Look for module declarations
        if line.starts_with("module ") || line.starts_with("module\t") {
            let doc = extract_preceding_doc_comment(&lines, i);
            let module = parse_module_header(&lines, &mut i);
            if let Some(mut m) = module {
                m.doc_comment = doc;
                modules.push(m);
            }
        }
        i += 1;
    }

    SvParseResult {
        modules,
        file_path: file_path.to_string(),
        total_lines,
    }
}

fn extract_preceding_doc_comment(lines: &[&str], module_line: usize) -> Option<String> {
    let mut doc_lines = Vec::new();
    let mut j = module_line.saturating_sub(1);

    loop {
        let line = lines[j].trim();
        if line.starts_with("//") {
            doc_lines.push(line.trim_start_matches('/').trim().to_string());
        } else if line.starts_with("/*") || line.ends_with("*/") || line.starts_with("*") {
            let cleaned = line
                .trim_start_matches("/*!")
                .trim_start_matches("/*")
                .trim_start_matches("*")
                .trim_end_matches("*/")
                .trim();
            if !cleaned.is_empty() {
                doc_lines.push(cleaned.to_string());
            }
        } else {
            break;
        }
        if j == 0 { break; }
        j -= 1;
    }

    doc_lines.reverse();
    if doc_lines.is_empty() {
        None
    } else {
        Some(doc_lines.join("\n"))
    }
}

fn parse_module_header(lines: &[&str], i: &mut usize) -> Option<SvModule> {
    // Collect the full module header (may span multiple lines until ';' or ')')
    let mut header = String::new();
    let start_line = *i;
    while *i < lines.len() {
        header.push_str(lines[*i]);
        header.push(' ');
        if lines[*i].contains(';') {
            break;
        }
        *i += 1;
    }

    // Extract module name
    let name = header.split_whitespace()
        .nth(1)?  // word after "module"
        .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_')
        .to_string();

    // Extract ports from the parenthesized section
    let ports = extract_ports(&header);
    let parameters = extract_parameters(&header);

    Some(SvModule {
        name,
        ports,
        parameters,
        doc_comment: None,
        line_number: start_line + 1,
    })
}

fn extract_ports(header: &str) -> Vec<SvPort> {
    let mut ports = Vec::new();

    let port_start = if header.contains('#') {
        let mut depth = 0i32;
        let mut found = None;
        for (i, ch) in header.char_indices() {
            match ch {
                '(' => { depth += 1; }
                ')' => {
                    depth -= 1;
                    if depth == 0 && found.is_none() {
                        found = Some(i);
                    }
                }
                _ => {}
            }
        }
        found.and_then(|close_param| header[close_param + 1..].find('(').map(|off| close_param + 1 + off))
    } else {
        header.find('(')
    };

    if let Some(start) = port_start {
        if let Some(end) = header.rfind(')') {
            let port_str = &header[start + 1..end];
            for part in port_str.split(',') {
                let part = part.trim();
                if part.is_empty() { continue; }

                let tokens: Vec<&str> = part.split_whitespace().collect();
                if tokens.is_empty() { continue; }

                let mut direction = PortDirection::Input;
                let mut width = String::new();

                for (_idx, &tok) in tokens.iter().enumerate() {
                    match tok {
                        "input" => { direction = PortDirection::Input; }
                        "output" => { direction = PortDirection::Output; }
                        "inout" => { direction = PortDirection::Inout; }
                        _ if tok.starts_with('[') => {
                            width = tok.to_string();
                        }
                        _ => {}
                    }
                }

                if let Some(&name) = tokens.last() {
                    let name = name.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if !name.is_empty() && name != "input" && name != "output" && name != "inout" {
                        ports.push(SvPort {
                            name: name.to_string(),
                            direction,
                            width: if width.is_empty() { "1".to_string() } else { width },
                            doc: None,
                        });
                    }
                }
            }
        }
    }

    ports
}

fn extract_parameters(header: &str) -> Vec<SvParam> {
    let mut params = Vec::new();

    // Look for #(...) parameter section
    if let Some(hash_pos) = header.find('#') {
        if let Some(start) = header[hash_pos..].find('(') {
            let after_hash = &header[hash_pos + start + 1..];
            if let Some(end) = after_hash.find(')') {
                let param_str = &after_hash[..end];
                for part in param_str.split(',') {
                    let part = part.trim();
                    let tokens: Vec<&str> = part.split_whitespace().collect();

                    // Look for "parameter TYPE NAME = VALUE" pattern.
                    // After the type keyword, skip any width specifiers
                    // like [3:0] before grabbing the parameter name.
                    for (idx, &tok) in tokens.iter().enumerate() {
                        if tok == "parameter" || tok == "localparam" {
                            let mut name_idx = idx + 1;
                            // Skip type keyword if present
                            if tokens.get(name_idx).map_or(false, |t| {
                                matches!(*t, "int" | "integer" | "logic" | "bit" | "byte" | "shortint" | "longint" | "string" | "real" | "time" | "type" | "signed" | "unsigned")
                            }) {
                                name_idx += 1;
                            }
                            // Skip width specifiers like [3:0], [W-1:0]
                            while tokens.get(name_idx).map_or(false, |t| t.starts_with('[')) {
                                name_idx += 1;
                            }
                            if let Some(&name_tok) = tokens.get(name_idx) {
                                let (name, default) = if let Some(eq_pos) = part.find('=') {
                                    let name = name_tok.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
                                    let val = part[eq_pos + 1..].trim().to_string();
                                    (name.to_string(), Some(val))
                                } else {
                                    (name_tok.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_').to_string(), None)
                                };

                                params.push(SvParam { name, default_value: default, doc: None });
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    params
}

/// Generate a Markdown documentation page for a parsed SV file.
pub fn generate_module_docs(result: &SvParseResult) -> String {
    let mut out = String::new();

    out.push_str(&format!("# {}\n\n", result.file_path));
    out.push_str(&format!("Source: `{}` ({} lines)\n\n", result.file_path, result.total_lines));

    for module in &result.modules {
        out.push_str(&format!("## Module: `{}`\n\n", module.name));

        if let Some(doc) = &module.doc_comment {
            out.push_str(&format!("{}\n\n", doc));
        }

        out.push_str(&format!("**Defined at:** line {}\n\n", module.line_number));

        if !module.parameters.is_empty() {
            out.push_str("### Parameters\n\n");
            out.push_str("| Name | Default |\n|---|---|\n");
            for p in &module.parameters {
                out.push_str(&format!("| `{}` | {} |\n",
                    p.name,
                    p.default_value.as_deref().unwrap_or("-")));
            }
            out.push_str("\n");
        }

        if !module.ports.is_empty() {
            out.push_str("### Ports\n\n");
            out.push_str("| Direction | Width | Name |\n|---|---|---|\n");
            for port in &module.ports {
                let dir = match port.direction {
                    PortDirection::Input => "input",
                    PortDirection::Output => "output",
                    PortDirection::Inout => "inout",
                };
                out.push_str(&format!("| {} | {} | `{}` |\n", dir, port.width, port.name));
            }
            out.push_str("\n");
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── (a) Basic module with ports ──────────────────────────────────

    #[test]
    fn basic_module_ports() {
        let sv = "\
module simple_adder (
    input  logic [7:0] i_a,
    input  logic [7:0] i_b,
    output logic [8:0] o_sum
);
endmodule
";
        let result = parse_sv(sv, "simple_adder.sv");
        assert_eq!(result.modules.len(), 1);
        assert_eq!(result.file_path, "simple_adder.sv");
        assert_eq!(result.total_lines, 6);

        let m = &result.modules[0];
        assert_eq!(m.name, "simple_adder");
        assert_eq!(m.line_number, 1);
        assert!(m.doc_comment.is_none());
        assert!(m.parameters.is_empty());
        assert_eq!(m.ports.len(), 3);

        // i_a
        assert_eq!(m.ports[0].name, "i_a");
        assert!(matches!(m.ports[0].direction, PortDirection::Input));
        assert_eq!(m.ports[0].width, "[7:0]");

        // i_b
        assert_eq!(m.ports[1].name, "i_b");
        assert!(matches!(m.ports[1].direction, PortDirection::Input));
        assert_eq!(m.ports[1].width, "[7:0]");

        // o_sum
        assert_eq!(m.ports[2].name, "o_sum");
        assert!(matches!(m.ports[2].direction, PortDirection::Output));
        assert_eq!(m.ports[2].width, "[8:0]");
    }

    // ── (b) Module with parameters ───────────────────────────────────

    #[test]
    fn module_with_parameters() {
        let sv = "\
module mac_unit #(
    parameter int DATA_WIDTH = 8,
    parameter int ACC_WIDTH  = 32
) (
    input  logic                    i_clk,
    input  logic [DATA_WIDTH-1:0]   i_weight,
    output logic [ACC_WIDTH-1:0]    o_acc
);
endmodule
";
        let result = parse_sv(sv, "mac_unit.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        assert_eq!(m.name, "mac_unit");

        // Parameters
        assert_eq!(m.parameters.len(), 2);
        assert_eq!(m.parameters[0].name, "DATA_WIDTH");
        assert_eq!(m.parameters[0].default_value.as_deref(), Some("8"));
        assert_eq!(m.parameters[1].name, "ACC_WIDTH");
        assert_eq!(m.parameters[1].default_value.as_deref(), Some("32"));

        // Ports
        assert_eq!(m.ports.len(), 3);
        assert_eq!(m.ports[0].name, "i_clk");
        assert_eq!(m.ports[0].width, "1");
        assert_eq!(m.ports[1].name, "i_weight");
        assert!(matches!(m.ports[1].direction, PortDirection::Input));
        assert_eq!(m.ports[2].name, "o_acc");
        assert!(matches!(m.ports[2].direction, PortDirection::Output));
    }

    // ── (c) Module with doc comments ─────────────────────────────────

    #[test]
    fn module_with_doc_comments() {
        let sv = "\
/// Top-level NPU compute engine
/// Implements the MAC array with configurable dimensions
module ctrl_npu_frontend #(
    parameter int ROWS = 32,
    parameter int COLS = 32
) (
    input  logic i_clk,
    input  logic i_rst_n,
    output logic o_busy
);
endmodule
";
        let result = parse_sv(sv, "ctrl_npu_frontend.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        assert_eq!(m.name, "ctrl_npu_frontend");

        // Doc comment should combine both lines
        let doc = m.doc_comment.as_ref().expect("doc_comment should be Some");
        assert!(doc.contains("Top-level NPU compute engine"));
        assert!(doc.contains("Implements the MAC array"));

        // Parameters
        assert_eq!(m.parameters.len(), 2);
        assert_eq!(m.parameters[0].name, "ROWS");
        assert_eq!(m.parameters[0].default_value.as_deref(), Some("32"));
        assert_eq!(m.parameters[1].name, "COLS");
        assert_eq!(m.parameters[1].default_value.as_deref(), Some("32"));

        // Ports
        assert_eq!(m.ports.len(), 3);
        assert_eq!(m.ports[0].name, "i_clk");
        assert_eq!(m.ports[1].name, "i_rst_n");
        assert_eq!(m.ports[2].name, "o_busy");
    }

    // ── (d) Multiple modules in one file ─────────────────────────────

    #[test]
    fn multiple_modules_in_one_file() {
        let sv = "\
/// Clock domain crossing synchronizer
module cdc_sync (
    input  logic i_clk_dst,
    input  logic i_async_in,
    output logic o_sync_out
);
endmodule

/// Simple register stage
module pipe_reg #(
    parameter int WIDTH = 8
) (
    input  logic             i_clk,
    input  logic [WIDTH-1:0] i_d,
    output logic [WIDTH-1:0] o_q
);
endmodule

module output_mux (
    input  logic       i_sel,
    input  logic [7:0] i_a,
    input  logic [7:0] i_b,
    output logic [7:0] o_y
);
endmodule
";
        let result = parse_sv(sv, "multi.sv");
        assert_eq!(result.modules.len(), 3);

        assert_eq!(result.modules[0].name, "cdc_sync");
        assert!(result.modules[0].doc_comment.as_ref()
            .unwrap().contains("Clock domain crossing"));
        assert_eq!(result.modules[0].ports.len(), 3);

        assert_eq!(result.modules[1].name, "pipe_reg");
        assert!(result.modules[1].doc_comment.as_ref()
            .unwrap().contains("register stage"));
        assert_eq!(result.modules[1].parameters.len(), 1);
        assert_eq!(result.modules[1].ports.len(), 3);

        assert_eq!(result.modules[2].name, "output_mux");
        assert!(result.modules[2].doc_comment.is_none());
        assert_eq!(result.modules[2].ports.len(), 4);
    }

    // ── (e) Empty module ─────────────────────────────────────────────

    #[test]
    fn empty_module() {
        let sv = "module empty;\nendmodule\n";
        let result = parse_sv(sv, "empty.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        assert_eq!(m.name, "empty");
        assert!(m.ports.is_empty());
        assert!(m.parameters.is_empty());
        assert!(m.doc_comment.is_none());
    }

    // ── (f) pccx-style port prefix convention ────────────────────────

    #[test]
    fn pccx_port_prefix_convention() {
        let sv = "\
module cu_npu_dispatcher (
    input  logic        i_clk,
    input  logic        i_rst_n,
    input  logic [31:0] i_cmd_data,
    input  logic        i_cmd_valid,
    output logic        o_cmd_ready,
    output logic [63:0] o_result,
    output logic        o_result_valid,
    inout  wire  [15:0] io_debug_bus
);
endmodule
";
        let result = parse_sv(sv, "cu_npu_dispatcher.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        assert_eq!(m.name, "cu_npu_dispatcher");
        assert_eq!(m.ports.len(), 8);

        // Verify i_ prefix -> Input
        for port in &m.ports[..4] {
            assert!(port.name.starts_with("i_"),
                "expected i_ prefix, got {}", port.name);
            assert!(matches!(port.direction, PortDirection::Input),
                "port {} should be Input", port.name);
        }

        // Verify o_ prefix -> Output
        for port in &m.ports[4..7] {
            assert!(port.name.starts_with("o_"),
                "expected o_ prefix, got {}", port.name);
            assert!(matches!(port.direction, PortDirection::Output),
                "port {} should be Output", port.name);
        }

        // Verify inout
        let io_port = &m.ports[7];
        assert_eq!(io_port.name, "io_debug_bus");
        assert!(matches!(io_port.direction, PortDirection::Inout));
        assert_eq!(io_port.width, "[15:0]");
    }

    // ── (g) Parameter with type + width specifier ────────────────────

    #[test]
    fn parameter_with_typed_width() {
        let sv = "\
module typed_params #(
    parameter logic [3:0] DEPTH = 4,
    parameter int         WIDTH = 16
) (
    input  logic i_clk,
    output logic o_valid
);
endmodule
";
        let result = parse_sv(sv, "typed_params.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        assert_eq!(m.parameters.len(), 2);
        assert_eq!(m.parameters[0].name, "DEPTH");
        assert_eq!(m.parameters[0].default_value.as_deref(), Some("4"));
        assert_eq!(m.parameters[1].name, "WIDTH");
        assert_eq!(m.parameters[1].default_value.as_deref(), Some("16"));
    }

    // ── Block-comment doc extraction ─────────────────────────────────

    #[test]
    fn block_comment_doc() {
        let sv = "\
/* AXI-Lite command interface
 * Decodes register writes into internal operations
 */
module axil_decoder (
    input  logic        i_clk,
    input  logic [11:0] i_awaddr,
    output logic        o_ack
);
endmodule
";
        let result = parse_sv(sv, "axil_decoder.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        let doc = m.doc_comment.as_ref().expect("block comment should be extracted");
        assert!(doc.contains("AXI-Lite command interface"));
        assert!(doc.contains("Decodes register writes"));
    }

    // ── Parameter without default value ──────────────────────────────

    #[test]
    fn parameter_no_default() {
        let sv = "\
module no_default #(
    parameter int SIZE
) (
    input logic i_clk
);
endmodule
";
        let result = parse_sv(sv, "no_default.sv");
        assert_eq!(result.modules.len(), 1);

        let m = &result.modules[0];
        assert_eq!(m.parameters.len(), 1);
        assert_eq!(m.parameters[0].name, "SIZE");
        assert!(m.parameters[0].default_value.is_none());
    }

    // ── Markdown doc generation ──────────────────────────────────────

    #[test]
    fn generate_docs_content() {
        let sv = "\
/// DMA engine for weight transfers
module dma_engine #(
    parameter int BURST_LEN = 16
) (
    input  logic        i_clk,
    input  logic [31:0] i_src_addr,
    output logic        o_done
);
endmodule
";
        let result = parse_sv(sv, "dma_engine.sv");
        let doc = generate_module_docs(&result);

        // File header
        assert!(doc.contains("# dma_engine.sv"));
        assert!(doc.contains("Source: `dma_engine.sv`"));

        // Module section
        assert!(doc.contains("## Module: `dma_engine`"));
        assert!(doc.contains("DMA engine for weight transfers"));

        // Parameter table
        assert!(doc.contains("### Parameters"));
        assert!(doc.contains("`BURST_LEN`"));
        assert!(doc.contains("16"));

        // Port table
        assert!(doc.contains("### Ports"));
        assert!(doc.contains("| input |"));
        assert!(doc.contains("| output |"));
        assert!(doc.contains("`i_clk`"));
        assert!(doc.contains("`o_done`"));
    }

    // ── Preserve original tests ──────────────────────────────────────

    #[test]
    fn original_parametrized_module() {
        let sv = r#"
// NPU top-level wrapper
// Connects AXI-Lite frontend to compute cores
module npu_top #(
    parameter NUM_CORES = 8,
    parameter DATA_WIDTH = 128
)(
    input  logic        i_clk,
    input  logic        i_rst_n,
    output logic [31:0] o_status
);
endmodule
"#;
        let result = parse_sv(sv, "npu_top.sv");
        assert_eq!(result.modules.len(), 1);
        let m = &result.modules[0];
        assert_eq!(m.name, "npu_top");
        assert!(m.doc_comment.is_some());
        assert!(!m.ports.is_empty());
    }

    #[test]
    fn original_simple_docs() {
        let sv = "module simple(input logic clk, output logic data);\nendmodule\n";
        let result = parse_sv(sv, "simple.sv");
        let doc = generate_module_docs(&result);
        assert!(doc.contains("simple"));
        assert!(doc.contains("clk"));
        assert!(doc.contains("data"));
    }
}
