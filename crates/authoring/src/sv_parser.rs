// Module: sv_parser
// Regex-based SystemVerilog module extractor for the Phase 6 M6.1
// SV-docstring-to-ISA-PDF pipeline.
//
// Parses module declarations, port lists, parameter blocks, and
// preceding doc-comments from `.sv` source files without requiring
// a full grammar (tree-sitter-verilog is not reliably available on
// crates.io). Good enough for the pccx RTL codebase where modules
// follow the `npu_interfaces.svh` port-prefix conventions.
//
// Phase 6 M6.3 adds FSM extraction: walks always_ff @(posedge ...)
// bodies looking for case(state_var) patterns to extract states and
// next-state assignments.  No full grammar — line-level walking only.

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

/// A single FSM state.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FsmState {
    pub name: String,
    /// True when this is the state assigned during synchronous reset.
    /// Falls back to the first case label if no reset arm is found.
    pub is_initial: bool,
    /// True when the state appears as a case label but has no outgoing
    /// next-state assignment inside its case arm.
    pub is_dead: bool,
}

/// A state transition edge extracted from a next_state assignment.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FsmTransition {
    pub from: String,
    pub to: String,
    /// The most recent enclosing `if (...)` condition in the case arm,
    /// if any.  None when the assignment is unconditional.
    pub condition: Option<String>,
}

/// One extracted FSM found in an always_ff block.
/// `name` is the case-variable identifier (e.g. "state" from
/// `case (state)`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SvFsm {
    pub name: String,
    pub states: Vec<FsmState>,
    pub transitions: Vec<FsmTransition>,
    /// States that appear as case labels but have no outgoing transitions.
    pub dead_states: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SvParseResult {
    pub modules: Vec<SvModule>,
    pub fsms: Vec<SvFsm>,
    pub file_path: String,
    pub total_lines: usize,
}

/// Parse a SystemVerilog source file and extract module declarations,
/// ports, parameters, doc comments, and FSM state machines.
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

    let fsms = extract_fsms(&lines);

    SvParseResult {
        modules,
        fsms,
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

// ─── FSM extraction (Phase 6 M6.3) ──────────────────────────────────────

/// Walk all lines, find every `always_ff @(posedge ...)` block, and
/// extract FSMs from `case (var)` patterns inside them.
fn extract_fsms(lines: &[&str]) -> Vec<SvFsm> {
    let mut fsms = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let trimmed = lines[i].trim();

        if is_always_ff_line(trimmed) {
            // The always_ff header line itself may end with 'begin'.
            // Collect all lines up to and including the matching end.
            let body_end = find_begin_end_close(lines, i);
            // Body is the lines between the always_ff header and its end.
            let body: &[&str] = if i + 1 < body_end {
                &lines[i + 1..body_end]
            } else {
                &[]
            };

            let reset_state = find_reset_state(body);

            let mut j = 0;
            while j < body.len() {
                let bline = body[j].trim();
                if let Some(var) = extract_case_var(bline) {
                    // Find the endcase for this case block
                    let case_end = find_endcase(body, j + 1);
                    let case_body: &[&str] = if j + 1 < case_end {
                        &body[j + 1..case_end]
                    } else {
                        &[]
                    };
                    if let Some(fsm) = parse_case_block(var, case_body, reset_state.as_deref()) {
                        fsms.push(fsm);
                    }
                    j = case_end + 1;
                } else {
                    j += 1;
                }
            }

            i = body_end + 1;
        } else {
            i += 1;
        }
    }

    fsms
}

fn is_always_ff_line(line: &str) -> bool {
    line.contains("always_ff") && line.contains("posedge")
}

/// Return the identifier inside `case (...)` or `case(...)`, or None.
fn extract_case_var(line: &str) -> Option<String> {
    let stripped = line.trim();
    // Match "case (var)" or "case(var)".
    if !stripped.starts_with("case") {
        return None;
    }
    let rest = stripped[4..].trim_start();
    if !rest.starts_with('(') {
        return None;
    }
    let inner = rest[1..].trim_start();
    let end = inner.find(')')?;
    let var = inner[..end].trim();
    if var.is_empty() {
        None
    } else {
        Some(var.to_string())
    }
}

/// Count `begin`/`end` tokens to find the line index of the `end` that
/// closes the outermost `begin` started at or after `start`.
///
/// The line at `start` is expected to contain a `begin` (e.g. the
/// `always_ff ... begin` header).  Returns the index of the matching
/// `end` line, or `lines.len()` if not found.
fn find_begin_end_close(lines: &[&str], start: usize) -> usize {
    let mut depth: i32 = 0;
    for (offset, line) in lines[start..].iter().enumerate() {
        let t = line.trim();
        for word in t.split_whitespace() {
            // Strip trailing punctuation so "begin;" -> "begin"
            let w = word.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
            match w {
                "begin" => { depth += 1; }
                "end" => {
                    depth -= 1;
                    if depth == 0 {
                        return start + offset;
                    }
                }
                _ => {}
            }
        }
        if t.starts_with("endmodule") {
            return start + offset;
        }
    }
    lines.len()
}

/// Find the index of the `endcase` line that closes the `case` block
/// starting at `start` (exclusive — search from `start` onwards).
///
/// Tracks nested `begin`/`end` to skip over arms that contain their
/// own `begin...end` blocks.  Returns `lines.len()` if not found.
fn find_endcase(lines: &[&str], start: usize) -> usize {
    let mut depth: i32 = 0;
    for (offset, line) in lines[start..].iter().enumerate() {
        let t = line.trim();
        if t == "endcase" && depth == 0 {
            return start + offset;
        }
        for word in t.split_whitespace() {
            let w = word.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_');
            match w {
                "begin" => { depth += 1; }
                "end" => { depth -= 1; }
                _ => {}
            }
        }
        if t.starts_with("endmodule") {
            return start + offset;
        }
    }
    lines.len()
}

/// Scan always_ff block body for a reset arm: `if (!rst_n) state <= IDLE;`
/// or `if (i_rst_n == 0)` patterns.  Returns the RHS state name.
fn find_reset_state(body: &[&str]) -> Option<String> {
    let mut in_reset_arm = false;
    for line in body {
        let t = line.trim();
        // Heuristic: an if-condition containing rst_n negated
        if t.starts_with("if") && t.contains('(') {
            let cond = extract_paren_content(t);
            if looks_like_reset(&cond) {
                in_reset_arm = true;
                continue;
            } else {
                in_reset_arm = false;
            }
        }
        if t.starts_with("end") || t.starts_with("else") {
            in_reset_arm = false;
        }
        if in_reset_arm {
            if let Some(rhs) = extract_nba_rhs(t) {
                return Some(rhs);
            }
        }
    }
    None
}

fn looks_like_reset(cond: &str) -> bool {
    // Covers: !rst_n, ~rst_n, !i_rst_n, rst_n == 1'b0, srst etc.
    let c = cond.trim();
    c.contains("!rst") || c.contains("~rst") || c.contains("!i_rst") || c.contains("~i_rst")
        || c.contains("srst") || c.contains("== 1'b0") || c.contains("==1'b0")
}

/// Extract content inside the first pair of parentheses.
fn extract_paren_content(s: &str) -> String {
    if let Some(start) = s.find('(') {
        if let Some(end) = s[start + 1..].find(')') {
            return s[start + 1..start + 1 + end].to_string();
        }
    }
    String::new()
}

/// Parse the case body to build an SvFsm.
///
/// Strategy:
///   - Case labels end with `:` and are not `default:`
///   - Inside each arm, collect next-state assignments (`next_state <= X`
///     or `state <= X`, where the LHS matches the case variable)
///   - Track `if (cond)` lines for condition annotation
fn parse_case_block(
    var: String,
    case_body: &[&str],
    reset_state: Option<&str>,
) -> Option<SvFsm> {
    let mut states: Vec<String> = Vec::new();
    let mut transitions: Vec<FsmTransition> = Vec::new();

    let mut current_state: Option<String> = None;
    let mut current_condition: Option<String> = None;

    for line in case_body {
        let t = line.trim();

        // Skip blank lines and pure comments
        if t.is_empty() || t.starts_with("//") {
            continue;
        }

        if t == "endcase" {
            break;
        }

        // Case label: "STATE_X:" or "STATE_X: begin" or "STATE_X: stmt"
        if let Some((label, inline_stmt)) = extract_case_label_with_tail(t) {
            current_state = Some(label.clone());
            current_condition = None;
            if label != "default" && !states.contains(&label) {
                states.push(label.clone());
            }
            // Process any inline statement on the same line as the label
            // e.g. `IDLE: state <= ACTIVE;`
            if let Some(stmt) = inline_stmt {
                if let Some(rhs) = extract_nba_rhs(stmt) {
                    let lhs = nba_lhs(stmt);
                    if lhs_is_state_var(&lhs, &var) && label != "default" {
                        transitions.push(FsmTransition {
                            from: label,
                            to: rhs,
                            condition: None,
                        });
                    }
                }
            }
            continue;
        }

        // if (...) inside a case arm — capture for condition annotation
        if t.starts_with("if") && t.contains('(') {
            current_condition = Some(extract_paren_content(t));
            continue;
        }

        // else resets condition (transition without condition on else branch)
        if t.starts_with("else") {
            current_condition = None;
            continue;
        }

        // Non-blocking assignment to the case variable or next_state
        if let Some(rhs) = extract_nba_rhs(t) {
            let lhs = nba_lhs(t);
            if lhs_is_state_var(&lhs, &var) {
                if let Some(ref from) = current_state {
                    if from != "default" {
                        transitions.push(FsmTransition {
                            from: from.clone(),
                            to: rhs,
                            condition: current_condition.clone(),
                        });
                    }
                }
            }
        }
    }

    if states.is_empty() {
        return None;
    }

    // Determine initial state
    let initial = reset_state
        .map(|s| s.to_string())
        .or_else(|| states.first().cloned())
        .unwrap_or_default();

    // Compute dead states: states with no outgoing transitions
    let states_with_transitions: std::collections::HashSet<&str> =
        transitions.iter().map(|t| t.from.as_str()).collect();

    let dead_states: Vec<String> = states.iter()
        .filter(|s| !states_with_transitions.contains(s.as_str()))
        .cloned()
        .collect();

    let fsm_states: Vec<FsmState> = states.iter().map(|s| FsmState {
        is_initial: *s == initial,
        is_dead: dead_states.contains(s),
        name: s.clone(),
    }).collect();

    Some(SvFsm {
        name: var,
        states: fsm_states,
        transitions,
        dead_states,
    })
}

/// Return `(label, inline_stmt)` if `line` is a case label.
///
/// Handles:
///   - `IDLE:`            → `("IDLE", None)`
///   - `IDLE: begin`      → `("IDLE", None)`
///   - `IDLE: state <= X;`→ `("IDLE", Some("state <= X;"))`
///
/// Returns `None` for `default:`, numeric literals, and lines that are
/// not case labels.
fn extract_case_label_with_tail(line: &str) -> Option<(String, Option<&str>)> {
    let t = line.trim();
    let colon_pos = t.find(':')?;
    let label = t[..colon_pos].trim();

    // Reject empty, multi-token, keyword, or literal labels
    if label.is_empty()
        || label.contains(' ')
        || label.contains('(')
        || label.contains(')')
        || label.contains('=')
        || label.contains('[')
        || label.contains('"')
        || label.contains('\'')     // numeric literals e.g. 2'b00
        || label.contains('?')
        || matches!(label, "begin" | "end" | "endcase" | "endmodule"
                         | "default" | "assign" | "if" | "else")
    {
        return None;
    }

    let after = t[colon_pos + 1..].trim();
    let inline = if after.is_empty() || after == "begin" || after.starts_with("//") {
        None
    } else {
        Some(after)
    };

    Some((label.to_string(), inline))
}

/// Extract the RHS of a non-blocking assignment `lhs <= rhs;`.
fn extract_nba_rhs(line: &str) -> Option<String> {
    if !line.contains("<=") {
        return None;
    }
    // Avoid confusing "<=" comparison with NBA: require that lhs is a
    // simple identifier (no relational expression context).
    let parts: Vec<&str> = line.splitn(2, "<=").collect();
    if parts.len() != 2 {
        return None;
    }
    let rhs = parts[1].trim().trim_end_matches(';').trim().to_string();
    // Reject multi-token RHS that look like expressions (e.g., "a + b")
    // or numeric literals — we only want state names (UPPER_SNAKE or
    // short identifiers).
    if rhs.is_empty() || rhs.contains(' ') || rhs.contains('+') || rhs.contains('-') {
        return None;
    }
    Some(rhs)
}

/// Extract the LHS of `lhs <= rhs;`.
fn nba_lhs(line: &str) -> String {
    if let Some(pos) = line.find("<=") {
        line[..pos].trim().to_string()
    } else {
        String::new()
    }
}

/// True when `lhs` is the FSM state variable or the conventional
/// `next_state` / `nxt_state` alias.
fn lhs_is_state_var(lhs: &str, var: &str) -> bool {
    let l = lhs.trim();
    l == var || l == "next_state" || l == "nxt_state"
        || l == format!("next_{}", var) || l == format!("nxt_{}", var)
}

// ─── Markdown docs ───────────────────────────────────────────────────────────

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

    // ── FSM extraction tests (Phase 6 M6.3) ─────────────────────────

    // (h) Basic 3-state FSM with reset arm
    #[test]
    fn fsm_basic_three_states() {
        let sv = "\
module ctrl_fsm (
    input  logic i_clk,
    input  logic i_rst_n,
    input  logic i_start,
    output logic o_done
);
    typedef enum logic [1:0] {
        IDLE   = 2'b00,
        ACTIVE = 2'b01,
        DONE   = 2'b10
    } state_t;

    state_t state;

    always_ff @(posedge i_clk) begin
        if (!i_rst_n) begin
            state <= IDLE;
        end else begin
            case (state)
                IDLE: begin
                    if (i_start)
                        state <= ACTIVE;
                end
                ACTIVE: begin
                    state <= DONE;
                end
                DONE: begin
                    state <= IDLE;
                end
            endcase
        end
    end
endmodule
";
        let result = parse_sv(sv, "ctrl_fsm.sv");
        assert_eq!(result.fsms.len(), 1);

        let fsm = &result.fsms[0];
        assert_eq!(fsm.name, "state");
        assert_eq!(fsm.states.len(), 3);

        // State names present
        let names: Vec<&str> = fsm.states.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"IDLE"));
        assert!(names.contains(&"ACTIVE"));
        assert!(names.contains(&"DONE"));

        // IDLE is initial (reset arm)
        let idle = fsm.states.iter().find(|s| s.name == "IDLE").unwrap();
        assert!(idle.is_initial);

        // 3 transitions: IDLE->ACTIVE, ACTIVE->DONE, DONE->IDLE
        assert_eq!(fsm.transitions.len(), 3);

        let t_ia = fsm.transitions.iter().find(|t| t.from == "IDLE" && t.to == "ACTIVE").unwrap();
        assert_eq!(t_ia.condition.as_deref(), Some("i_start"));

        let t_ad = fsm.transitions.iter().find(|t| t.from == "ACTIVE" && t.to == "DONE").unwrap();
        assert!(t_ad.condition.is_none());

        // No dead states — all three have transitions
        assert!(fsm.dead_states.is_empty());
    }

    // (i) Dead state detection
    #[test]
    fn fsm_dead_state_detected() {
        let sv = "\
module dead_state_fsm (
    input  logic i_clk,
    input  logic i_rst_n
);
    typedef enum logic [1:0] { S0, S1, S2_DEAD } fsm_t;
    fsm_t state;

    always_ff @(posedge i_clk) begin
        if (!i_rst_n) begin
            state <= S0;
        end else begin
            case (state)
                S0: begin
                    state <= S1;
                end
                S1: begin
                    state <= S0;
                end
                S2_DEAD: begin
                    // No transition out — dead state
                end
            endcase
        end
    end
endmodule
";
        let result = parse_sv(sv, "dead_state_fsm.sv");
        assert_eq!(result.fsms.len(), 1);

        let fsm = &result.fsms[0];
        assert_eq!(fsm.states.len(), 3);

        // S2_DEAD has no outgoing transition
        assert!(fsm.dead_states.contains(&"S2_DEAD".to_string()));
        let s2 = fsm.states.iter().find(|s| s.name == "S2_DEAD").unwrap();
        assert!(s2.is_dead);

        // S0 and S1 are live
        let s0 = fsm.states.iter().find(|s| s.name == "S0").unwrap();
        assert!(!s0.is_dead);
        let s1 = fsm.states.iter().find(|s| s.name == "S1").unwrap();
        assert!(!s1.is_dead);
    }

    // (j) Initial state falls back to first case label when no reset arm
    #[test]
    fn fsm_initial_state_fallback_to_first_label() {
        let sv = "\
module no_reset_fsm (
    input logic i_clk,
    input logic i_go
);
    typedef enum { FIRST, SECOND, THIRD } st_t;
    st_t state;

    always_ff @(posedge i_clk) begin
        case (state)
            FIRST: begin
                if (i_go)
                    state <= SECOND;
            end
            SECOND: begin
                state <= THIRD;
            end
            THIRD: begin
                state <= FIRST;
            end
        endcase
    end
endmodule
";
        let result = parse_sv(sv, "no_reset_fsm.sv");
        assert_eq!(result.fsms.len(), 1);

        let fsm = &result.fsms[0];
        assert_eq!(fsm.states.len(), 3);

        // FIRST is initial because it is the first case label (no reset arm)
        let first = fsm.states.iter().find(|s| s.name == "FIRST").unwrap();
        assert!(first.is_initial, "FIRST should be initial (fallback to first label)");

        // Others are not initial
        for s in fsm.states.iter().filter(|s| s.name != "FIRST") {
            assert!(!s.is_initial, "{} should not be initial", s.name);
        }
    }

    // (k) next_state alias for state variable
    #[test]
    fn fsm_next_state_alias() {
        let sv = "\
module alias_fsm (
    input  logic i_clk,
    input  logic i_rst_n,
    input  logic i_go
);
    typedef enum { WAIT, RUN, HALT } st_t;
    st_t state, next_state;

    always_ff @(posedge i_clk) begin
        if (!i_rst_n)
            state <= WAIT;
        else
            state <= next_state;
    end

    always_ff @(posedge i_clk) begin
        case (state)
            WAIT: begin
                if (i_go)
                    next_state <= RUN;
            end
            RUN: begin
                next_state <= HALT;
            end
            HALT: begin
                next_state <= WAIT;
            end
        endcase
    end
endmodule
";
        let result = parse_sv(sv, "alias_fsm.sv");
        // Two always_ff blocks: the first (state <= ...) is trivial,
        // the second should yield a case-based FSM on 'state'
        // with next_state assignments captured.
        let fsm_opt = result.fsms.iter().find(|f| !f.states.is_empty() && f.states.len() >= 3);
        assert!(fsm_opt.is_some(), "expected at least one FSM with 3 states");

        let fsm = fsm_opt.unwrap();
        let names: Vec<&str> = fsm.states.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"WAIT"), "WAIT not found in {:?}", names);
        assert!(names.contains(&"RUN"),  "RUN not found in {:?}", names);
        assert!(names.contains(&"HALT"), "HALT not found in {:?}", names);
    }

    // (l) parse_sv on source without always_ff produces empty fsm list
    #[test]
    fn fsm_no_always_ff_yields_empty() {
        let sv = "\
module combinational (
    input  logic [7:0] i_a,
    output logic [7:0] o_b
);
    assign o_b = ~i_a;
endmodule
";
        let result = parse_sv(sv, "comb.sv");
        assert!(result.fsms.is_empty());
    }
}
