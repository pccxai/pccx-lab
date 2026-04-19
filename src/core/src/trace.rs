// Module Boundary: core/
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpuEvent {
    pub core_id: u32,
    pub start_cycle: u64,
    pub duration: u64,
    pub event_type: String, // e.g., "MAC_COMPUTE", "DMA_READ"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpuTrace {
    pub total_cycles: u64,
    pub events: Vec<NpuEvent>,
}

impl NpuTrace {
    // Converts the trace into a binary payload that can be stored in a .pccx file.
    // In Phase 1, we might use bincode or simply JSON for the payload,
    // but the .pccx spec dictates a binary blob payload.
    // Zero-copy IPC / Shared Memory is planned for future phases (TODO).
    pub fn to_payload(&self) -> Vec<u8> {
        // For now, serialize to JSON. Later, replace with Bincode for performance.
        serde_json::to_vec(self).unwrap_or_default()
    }
}
