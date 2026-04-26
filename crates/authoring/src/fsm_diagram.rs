// Module: fsm_diagram
// Mermaid stateDiagram-v2 renderer for SvFsm values (Phase 6 M6.3).
//
// Dead states are annotated with a `classDef dead` style so the IDE
// preview pane can highlight them visually.

use crate::sv_parser::SvFsm;

/// Render one FSM as a Mermaid stateDiagram-v2 block.
///
/// Layout:
///   - `[*] --> InitialState` marks the entry point
///   - Transitions: `S0 --> S1 : condition`  (condition omitted when None)
///   - Dead states: collected in a `classDef dead` + `class S dead` stanza
pub fn generate_mermaid_fsm(fsm: &SvFsm) -> String {
    let mut out = String::new();

    out.push_str("stateDiagram-v2\n");

    // Initial state arrow
    if let Some(initial) = fsm.states.iter().find(|s| s.is_initial) {
        out.push_str(&format!("    [*] --> {}\n", initial.name));
    } else if let Some(first) = fsm.states.first() {
        out.push_str(&format!("    [*] --> {}\n", first.name));
    }

    // State declarations (only needed for states with no transitions, but
    // emitting them explicitly makes the diagram self-documenting)
    for state in &fsm.states {
        out.push_str(&format!("    state {} {{}}\n", state.name));
    }

    // Transitions
    for t in &fsm.transitions {
        match &t.condition {
            Some(cond) => {
                out.push_str(&format!("    {} --> {} : {}\n", t.from, t.to, cond));
            }
            None => {
                out.push_str(&format!("    {} --> {}\n", t.from, t.to));
            }
        }
    }

    // Dead state annotation
    if !fsm.dead_states.is_empty() {
        out.push_str("    classDef dead fill:#6b6b6b,color:#fff\n");
        for ds in &fsm.dead_states {
            out.push_str(&format!("    class {} dead\n", ds));
        }
    }

    out
}

/// Render all FSMs in a slice, separated by blank lines.
pub fn generate_mermaid_fsm_all(fsms: &[SvFsm]) -> String {
    fsms.iter()
        .map(generate_mermaid_fsm)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sv_parser::{FsmState, FsmTransition, SvFsm};

    fn make_fsm(
        name: &str,
        state_names: &[(&str, bool, bool)],  // (name, is_initial, is_dead)
        transitions: &[(&str, &str, Option<&str>)],
    ) -> SvFsm {
        let states = state_names.iter().map(|(n, init, dead)| FsmState {
            name: n.to_string(),
            is_initial: *init,
            is_dead: *dead,
        }).collect();

        let trans = transitions.iter().map(|(from, to, cond)| FsmTransition {
            from: from.to_string(),
            to: to.to_string(),
            condition: cond.map(|s| s.to_string()),
        }).collect();

        let dead_states = state_names.iter()
            .filter(|(_, _, dead)| *dead)
            .map(|(n, _, _)| n.to_string())
            .collect();

        SvFsm {
            name: name.to_string(),
            states,
            transitions: trans,
            dead_states,
        }
    }

    // ── (a) Mermaid header ───────────────────────────────────────────

    #[test]
    fn header_is_statediagram_v2() {
        let fsm = make_fsm(
            "state",
            &[("IDLE", true, false)],
            &[],
        );
        let out = generate_mermaid_fsm(&fsm);
        assert!(out.starts_with("stateDiagram-v2\n"));
    }

    // ── (b) Initial state arrow ──────────────────────────────────────

    #[test]
    fn initial_state_arrow_present() {
        let fsm = make_fsm(
            "state",
            &[("IDLE", true, false), ("RUN", false, false)],
            &[("IDLE", "RUN", None)],
        );
        let out = generate_mermaid_fsm(&fsm);
        assert!(out.contains("[*] --> IDLE"), "missing initial arrow in:\n{}", out);
    }

    // ── (c) Transition without condition ────────────────────────────

    #[test]
    fn unconditional_transition() {
        let fsm = make_fsm(
            "state",
            &[("A", true, false), ("B", false, false)],
            &[("A", "B", None)],
        );
        let out = generate_mermaid_fsm(&fsm);
        assert!(out.contains("A --> B\n"), "expected unconditional edge in:\n{}", out);
        assert!(!out.contains("A --> B :"), "should not have colon for unconditional");
    }

    // ── (d) Transition with condition ────────────────────────────────

    #[test]
    fn conditional_transition() {
        let fsm = make_fsm(
            "state",
            &[("IDLE", true, false), ("ACTIVE", false, false)],
            &[("IDLE", "ACTIVE", Some("i_start"))],
        );
        let out = generate_mermaid_fsm(&fsm);
        assert!(
            out.contains("IDLE --> ACTIVE : i_start"),
            "expected conditional edge in:\n{}", out
        );
    }

    // ── (e) Dead state classDef ──────────────────────────────────────

    #[test]
    fn dead_state_classdef() {
        let fsm = make_fsm(
            "state",
            &[
                ("S0", true, false),
                ("S1", false, false),
                ("S_DEAD", false, true),
            ],
            &[
                ("S0", "S1", None),
                ("S1", "S0", None),
            ],
        );
        let out = generate_mermaid_fsm(&fsm);
        assert!(out.contains("classDef dead"), "missing classDef in:\n{}", out);
        assert!(out.contains("class S_DEAD dead"), "missing class assignment in:\n{}", out);
    }

    // ── (f) No dead state — no classDef emitted ──────────────────────

    #[test]
    fn no_dead_state_no_classdef() {
        let fsm = make_fsm(
            "state",
            &[("A", true, false), ("B", false, false)],
            &[("A", "B", None), ("B", "A", None)],
        );
        let out = generate_mermaid_fsm(&fsm);
        assert!(!out.contains("classDef"), "unexpected classDef in:\n{}", out);
    }

    // ── (g) End-to-end: parse_sv -> generate_mermaid_fsm ────────────

    #[test]
    fn end_to_end_parse_and_render() {
        use crate::sv_parser::parse_sv;

        let sv = "\
module e2e_fsm (
    input  logic i_clk,
    input  logic i_rst_n,
    input  logic i_req
);
    typedef enum logic [1:0] {
        IDLE  = 2'b00,
        BUSY  = 2'b01,
        ERROR = 2'b10
    } state_t;
    state_t state;

    always_ff @(posedge i_clk) begin
        if (!i_rst_n) begin
            state <= IDLE;
        end else begin
            case (state)
                IDLE: begin
                    if (i_req)
                        state <= BUSY;
                end
                BUSY: begin
                    state <= IDLE;
                end
                ERROR: begin
                    // terminal state — no outgoing transition
                end
            endcase
        end
    end
endmodule
";
        let result = parse_sv(sv, "e2e_fsm.sv");
        assert_eq!(result.fsms.len(), 1, "expected 1 FSM");

        let fsm = &result.fsms[0];
        assert_eq!(fsm.states.len(), 3);
        assert!(fsm.dead_states.contains(&"ERROR".to_string()));

        let mermaid = generate_mermaid_fsm(fsm);
        assert!(mermaid.starts_with("stateDiagram-v2\n"));
        assert!(mermaid.contains("[*] --> IDLE"));
        assert!(mermaid.contains("IDLE --> BUSY : i_req"));
        assert!(mermaid.contains("BUSY --> IDLE"));
        assert!(mermaid.contains("class ERROR dead"));
    }

    // ── (h) generate_mermaid_fsm_all joins with blank lines ─────────

    #[test]
    fn all_fsms_joined() {
        let fsm1 = make_fsm(
            "s1",
            &[("A", true, false), ("B", false, false)],
            &[("A", "B", None)],
        );
        let fsm2 = make_fsm(
            "s2",
            &[("X", true, false), ("Y", false, false)],
            &[("X", "Y", Some("en"))],
        );
        let out = generate_mermaid_fsm_all(&[fsm1, fsm2]);
        assert!(out.contains("stateDiagram-v2"));
        assert!(out.contains("[*] --> A"));
        assert!(out.contains("[*] --> X"));
        assert!(out.contains("X --> Y : en"));
    }
}
