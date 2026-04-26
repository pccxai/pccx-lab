// Module Boundary: schema/
// pccx-schema: centralised IPC DTO definitions shared between the Rust
// backend and the TypeScript frontend.  All types derive ts-rs so that
// TypeScript interfaces are generated automatically during `cargo test`.
//
// Dependency rules (enforced by this module boundary comment):
//   No dependency on ui/, uvm_bridge/, or ai_copilot/.
//   Types here are wire DTOs -- thin data carriers with no domain logic.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/*--------------------------------------------------------------------*/
/*  Viewport query / response                                         */
/*--------------------------------------------------------------------*/

/// Frontend -> backend: request a window of trace data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ViewportRequest {
    pub start_cycle: u64,
    pub end_cycle: u64,
    pub generation_id: u32,
}

/// A single event inside a viewport tile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TileEvent {
    pub core_id: u32,
    pub start_cycle: u64,
    pub duration: u64,
    pub type_id: u32,
}

/// Backend -> frontend: a batch of events for one viewport generation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ViewportTile {
    pub events: Vec<TileEvent>,
    pub generation_id: u32,
    pub total_events: u64,
}

/*--------------------------------------------------------------------*/
/*  Trace metadata                                                    */
/*--------------------------------------------------------------------*/

/// Summary of a loaded trace file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TraceInfo {
    pub total_cycles: u64,
    pub total_events: u64,
    pub num_cores: u32,
    pub encoding: String,
}

/*--------------------------------------------------------------------*/
/*  Health / status                                                    */
/*--------------------------------------------------------------------*/

/// Backend liveness check returned by the health command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HealthStatus {
    pub version: String,
    pub uptime_secs: u64,
    pub loaded_traces: Vec<String>,
}

/*--------------------------------------------------------------------*/
/*  Tests                                                             */
/*--------------------------------------------------------------------*/

#[cfg(test)]
mod tests {
    use super::*;

    // ── Serde round-trip ────────────────────────────────────────────

    fn round_trip<T>(val: &T)
    where
        T: Serialize + for<'de> Deserialize<'de> + std::fmt::Debug + Clone + PartialEq,
    {
        let json = serde_json::to_string(val).expect("serialize");
        let back: T = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(*val, back);
    }

    #[test]
    fn viewport_request_round_trip() {
        round_trip(&ViewportRequest {
            start_cycle: 0,
            end_cycle: 10_000,
            generation_id: 1,
        });
    }

    #[test]
    fn tile_event_round_trip() {
        round_trip(&TileEvent {
            core_id: 3,
            start_cycle: 500,
            duration: 120,
            type_id: 7,
        });
    }

    #[test]
    fn viewport_tile_round_trip() {
        round_trip(&ViewportTile {
            events: vec![
                TileEvent { core_id: 0, start_cycle: 100, duration: 10, type_id: 1 },
                TileEvent { core_id: 1, start_cycle: 200, duration: 20, type_id: 2 },
            ],
            generation_id: 42,
            total_events: 2,
        });
    }

    #[test]
    fn trace_info_round_trip() {
        round_trip(&TraceInfo {
            total_cycles: 1_000_000,
            total_events: 50_000,
            num_cores: 4,
            encoding: "fnv1a".to_string(),
        });
    }

    #[test]
    fn health_status_round_trip() {
        round_trip(&HealthStatus {
            version: "0.1.0".to_string(),
            uptime_secs: 3600,
            loaded_traces: vec!["conv2d.pccx".to_string(), "gemm.pccx".to_string()],
        });
    }

    // ── ts-rs declaration sanity ────────────────────────────────────

    #[test]
    fn ts_viewport_request_decl() {
        let decl = ViewportRequest::decl();
        assert!(decl.contains("ViewportRequest"), "type name missing");
        assert!(decl.contains("start_cycle"), "field missing");
        assert!(decl.contains("generation_id"), "field missing");
    }

    #[test]
    fn ts_tile_event_decl() {
        let decl = TileEvent::decl();
        assert!(decl.contains("TileEvent"), "type name missing");
        assert!(decl.contains("core_id"), "field missing");
        assert!(decl.contains("duration"), "field missing");
    }

    #[test]
    fn ts_viewport_tile_decl() {
        let decl = ViewportTile::decl();
        assert!(decl.contains("ViewportTile"), "type name missing");
        assert!(decl.contains("events"), "field missing");
        assert!(decl.contains("total_events"), "field missing");
    }

    #[test]
    fn ts_trace_info_decl() {
        let decl = TraceInfo::decl();
        assert!(decl.contains("TraceInfo"), "type name missing");
        assert!(decl.contains("num_cores"), "field missing");
        assert!(decl.contains("encoding"), "field missing");
    }

    #[test]
    fn ts_health_status_decl() {
        let decl = HealthStatus::decl();
        assert!(decl.contains("HealthStatus"), "type name missing");
        assert!(decl.contains("uptime_secs"), "field missing");
        assert!(decl.contains("loaded_traces"), "field missing");
    }
}
