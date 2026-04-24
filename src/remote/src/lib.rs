// Module Boundary: remote/
// pccx-remote: secure backend daemon for Phase 3.
//
// Scaffold only.  The real implementation stack — WireGuard / QUIC
// tunnel, OIDC SSO + hardware 2FA, per-user RBAC, audit log, session
// sandbox — lands during Phase 3 after the core workspace has
// stabilised.  Landing the crate now keeps the dependency graph
// coherent and gives downstream Cargo resolution a stable member list.
//
// Exposed surface today: nothing.  Internal consumers should treat
// this crate as not-yet-functional.

/// Placeholder until the Phase 3 auth layer lands.  Currently returns
/// a static string identifying the crate for feature-gate discovery.
pub const SCAFFOLD_TAG: &str = "pccx-remote: Phase 3 scaffold";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_tag_is_non_empty() {
        assert!(!SCAFFOLD_TAG.is_empty());
    }
}
