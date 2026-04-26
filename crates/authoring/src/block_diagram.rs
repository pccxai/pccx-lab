// Module: block_diagram
// Mermaid flowchart generation from parsed SV module data (Phase 6 M6.2).
//
// Takes SvModule slices from sv_parser and produces Mermaid TD
// diagrams suitable for embedding in docs or the pccx-ide preview pane.
//
// Connection inference: strips i_/o_ prefixes and draws edges between
// modules whose port stems match (e.g. o_data -> i_data).

use crate::sv_parser::{PortDirection, SvModule};
use std::collections::HashMap;

/// Generate a Mermaid flowchart TD showing all modules and inferred
/// connections based on port-name matching (strip i_/o_ prefix).
pub fn generate_mermaid(modules: &[SvModule]) -> String {
    let mut out = String::from("flowchart TD\n");
    if modules.is_empty() {
        return out;
    }

    // Emit node declarations
    for m in modules {
        let param_count = m.parameters.len();
        let port_count = m.ports.len();

        let mut label = format!("{}<br/>ports: {}", m.name, port_count);
        if param_count > 0 {
            label = format!("{}<br/>params: {}, ports: {}", m.name, param_count, port_count);
            // Append actual parameter values
            let param_strs: Vec<String> = m.parameters.iter().map(|p| {
                match &p.default_value {
                    Some(v) => format!("{}={}", p.name, v),
                    None => p.name.clone(),
                }
            }).collect();
            label.push_str(&format!("<br/>{}", param_strs.join(", ")));
        }
        out.push_str(&format!("    {}[\"{}\"]\n", m.name, label));
    }

    // Build port maps for connection inference.
    // outputs: stem -> Vec<module_name>
    // inputs:  stem -> Vec<module_name>
    let mut outputs: HashMap<String, Vec<&str>> = HashMap::new();
    let mut inputs: HashMap<String, Vec<&str>> = HashMap::new();

    for m in modules {
        for port in &m.ports {
            match port.direction {
                PortDirection::Output => {
                    if let Some(stem) = port.name.strip_prefix("o_") {
                        outputs.entry(stem.to_string())
                            .or_default()
                            .push(&m.name);
                    }
                }
                PortDirection::Input => {
                    if let Some(stem) = port.name.strip_prefix("i_") {
                        inputs.entry(stem.to_string())
                            .or_default()
                            .push(&m.name);
                    }
                }
                PortDirection::Inout => {
                    // Skip inout ports for connection inference
                }
            }
        }
    }

    // Draw edges where output stem matches input stem
    for (stem, src_modules) in &outputs {
        if let Some(dst_modules) = inputs.get(stem) {
            for &src in src_modules {
                for &dst in dst_modules {
                    // No self-loops
                    if src == dst {
                        continue;
                    }
                    out.push_str(&format!("    {} -->|{}| {}\n", src, stem, dst));
                }
            }
        }
    }

    out
}

/// Generate a detailed Mermaid diagram for a single module, showing
/// all ports grouped in a subgraph with directional arrows.
pub fn generate_module_detail(module: &SvModule) -> String {
    let mut out = String::from("flowchart TD\n");

    out.push_str(&format!("    subgraph {}[\"{}\"]\n", module.name, module.name));

    // Internal body node for port arrows to point at
    let body_id = format!("{}_body", module.name);
    let mut body_label = module.name.clone();
    if !module.parameters.is_empty() {
        let param_strs: Vec<String> = module.parameters.iter().map(|p| {
            match &p.default_value {
                Some(v) => format!("{}={}", p.name, v),
                None => p.name.clone(),
            }
        }).collect();
        body_label.push_str(&format!("<br/>{}", param_strs.join(", ")));
    }
    out.push_str(&format!("        {}[\"{}\"]\n", body_id, body_label));

    for port in &module.ports {
        let dir_tag = match port.direction {
            PortDirection::Input => "in",
            PortDirection::Output => "out",
            PortDirection::Inout => "inout",
        };
        let port_id = format!("{}_{}", module.name, port.name);
        let width_str = if port.width == "1" {
            String::new()
        } else {
            format!(" {}", port.width)
        };
        out.push_str(&format!(
            "        {}[\"{} ({}{})\"]\n",
            port_id, port.name, dir_tag, width_str
        ));
    }
    out.push_str("    end\n");

    // Draw directional arrows: inputs -> body, body -> outputs
    for port in &module.ports {
        let port_id = format!("{}_{}", module.name, port.name);
        match port.direction {
            PortDirection::Input => {
                out.push_str(&format!("    {} --> {}\n", port_id, body_id));
            }
            PortDirection::Output => {
                out.push_str(&format!("    {} --> {}\n", body_id, port_id));
            }
            PortDirection::Inout => {
                out.push_str(&format!("    {} <--> {}\n", port_id, body_id));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sv_parser::{SvModule, SvParam, SvPort, PortDirection};

    fn make_port(name: &str, dir: PortDirection, width: &str) -> SvPort {
        SvPort {
            name: name.to_string(),
            direction: dir,
            width: width.to_string(),
            doc: None,
        }
    }

    fn make_param(name: &str, default: Option<&str>) -> SvParam {
        SvParam {
            name: name.to_string(),
            default_value: default.map(|s| s.to_string()),
            doc: None,
        }
    }

    // ── (a) Single module diagram ───────────────────────────────────

    #[test]
    fn single_module_diagram() {
        let modules = vec![SvModule {
            name: "adder".to_string(),
            ports: vec![
                make_port("i_a", PortDirection::Input, "[7:0]"),
                make_port("i_b", PortDirection::Input, "[7:0]"),
                make_port("o_sum", PortDirection::Output, "[8:0]"),
            ],
            parameters: vec![],
            doc_comment: None,
            line_number: 1,
        }];

        let mermaid = generate_mermaid(&modules);
        assert!(mermaid.starts_with("flowchart TD\n"));
        assert!(mermaid.contains("adder[\"adder<br/>ports: 3\"]"));
        // No params line for parameterless module
        assert!(!mermaid.contains("params:"));
    }

    // ── (b) Multi-module with inferred connections ──────────────────

    #[test]
    fn multi_module_connections() {
        let modules = vec![
            SvModule {
                name: "producer".to_string(),
                ports: vec![
                    make_port("i_clk", PortDirection::Input, "1"),
                    make_port("o_data", PortDirection::Output, "[31:0]"),
                    make_port("o_valid", PortDirection::Output, "1"),
                ],
                parameters: vec![],
                doc_comment: None,
                line_number: 1,
            },
            SvModule {
                name: "consumer".to_string(),
                ports: vec![
                    make_port("i_clk", PortDirection::Input, "1"),
                    make_port("i_data", PortDirection::Input, "[31:0]"),
                    make_port("i_valid", PortDirection::Input, "1"),
                    make_port("o_ack", PortDirection::Output, "1"),
                ],
                parameters: vec![],
                doc_comment: None,
                line_number: 10,
            },
        ];

        let mermaid = generate_mermaid(&modules);
        // Both modules declared
        assert!(mermaid.contains("producer[\""));
        assert!(mermaid.contains("consumer[\""));
        // data connection inferred: producer.o_data -> consumer.i_data
        assert!(mermaid.contains("producer -->|data| consumer"));
        // valid connection inferred
        assert!(mermaid.contains("producer -->|valid| consumer"));
    }

    // ── (c) Module with parameters ──────────────────────────────────

    #[test]
    fn module_with_parameters() {
        let modules = vec![SvModule {
            name: "mac_unit".to_string(),
            ports: vec![
                make_port("i_clk", PortDirection::Input, "1"),
                make_port("o_acc", PortDirection::Output, "[31:0]"),
            ],
            parameters: vec![
                make_param("DATA_WIDTH", Some("8")),
                make_param("ACC_WIDTH", Some("32")),
            ],
            doc_comment: None,
            line_number: 1,
        }];

        let mermaid = generate_mermaid(&modules);
        assert!(mermaid.contains("params: 2, ports: 2"));
        assert!(mermaid.contains("DATA_WIDTH=8"));
        assert!(mermaid.contains("ACC_WIDTH=32"));
    }

    // ── (d) Port matching: o_data -> i_data ─────────────────────────

    #[test]
    fn port_matching_data_connection() {
        let modules = vec![
            SvModule {
                name: "source".to_string(),
                ports: vec![
                    make_port("o_data", PortDirection::Output, "[15:0]"),
                ],
                parameters: vec![],
                doc_comment: None,
                line_number: 1,
            },
            SvModule {
                name: "sink".to_string(),
                ports: vec![
                    make_port("i_data", PortDirection::Input, "[15:0]"),
                ],
                parameters: vec![],
                doc_comment: None,
                line_number: 5,
            },
        ];

        let mermaid = generate_mermaid(&modules);
        assert!(mermaid.contains("source -->|data| sink"));
        // No reverse connection
        assert!(!mermaid.contains("sink -->"));
    }

    // ── (e) Empty module list ───────────────────────────────────────

    #[test]
    fn empty_module_list() {
        let mermaid = generate_mermaid(&[]);
        assert_eq!(mermaid, "flowchart TD\n");
    }

    // ── (f) No self-loops ───────────────────────────────────────────

    #[test]
    fn no_self_loops() {
        let modules = vec![SvModule {
            name: "loopback".to_string(),
            ports: vec![
                make_port("i_data", PortDirection::Input, "[7:0]"),
                make_port("o_data", PortDirection::Output, "[7:0]"),
            ],
            parameters: vec![],
            doc_comment: None,
            line_number: 1,
        }];

        let mermaid = generate_mermaid(&modules);
        // Should not contain any connection arrow (only one module)
        assert!(!mermaid.contains("-->|"));
    }

    // ── (g) Inout ports skipped for connection inference ────────────

    #[test]
    fn inout_ports_not_matched() {
        let modules = vec![
            SvModule {
                name: "mod_a".to_string(),
                ports: vec![
                    make_port("io_bus", PortDirection::Inout, "[7:0]"),
                ],
                parameters: vec![],
                doc_comment: None,
                line_number: 1,
            },
            SvModule {
                name: "mod_b".to_string(),
                ports: vec![
                    make_port("io_bus", PortDirection::Inout, "[7:0]"),
                ],
                parameters: vec![],
                doc_comment: None,
                line_number: 5,
            },
        ];

        let mermaid = generate_mermaid(&modules);
        // No connection edges from inout
        assert!(!mermaid.contains("-->|"));
    }

    // ── (h) Module detail diagram ───────────────────────────────────

    #[test]
    fn module_detail_subgraph() {
        let module = SvModule {
            name: "mac_unit".to_string(),
            ports: vec![
                make_port("i_clk", PortDirection::Input, "1"),
                make_port("i_weight", PortDirection::Input, "[7:0]"),
                make_port("o_acc", PortDirection::Output, "[31:0]"),
            ],
            parameters: vec![
                make_param("WIDTH", Some("8")),
            ],
            doc_comment: None,
            line_number: 1,
        };

        let detail = generate_module_detail(&module);
        assert!(detail.starts_with("flowchart TD\n"));
        assert!(detail.contains("subgraph mac_unit[\"mac_unit\"]"));
        assert!(detail.contains("mac_unit_body[\"mac_unit<br/>WIDTH=8\"]"));
        // Ports listed with direction tags
        assert!(detail.contains("mac_unit_i_clk[\"i_clk (in)\"]"));
        assert!(detail.contains("mac_unit_i_weight[\"i_weight (in [7:0])\"]"));
        assert!(detail.contains("mac_unit_o_acc[\"o_acc (out [31:0])\"]"));
        // Input arrows into body
        assert!(detail.contains("mac_unit_i_clk --> mac_unit_body"));
        // Body arrow to output
        assert!(detail.contains("mac_unit_body --> mac_unit_o_acc"));
    }
}
