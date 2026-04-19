// Module Boundary: core/
use crate::pccx_format::{PccxHeader, PccxFile, ArchConfig, TraceConfig, PayloadConfig};
use crate::trace::{NpuTrace, NpuEvent};

pub fn generate_dummy_trace(cycles: u64, cores: u32) -> NpuTrace {
    let mut events = Vec::new();
    
    // Generate some dummy events for testing
    for c in 0..cores {
        let mut cycle = 0;
        while cycle < cycles {
            // Dummy active period
            events.push(NpuEvent {
                core_id: c,
                start_cycle: cycle,
                duration: 50,
                event_type: "MAC_COMPUTE".to_string(),
            });
            cycle += 100;
            
            // Dummy memory fetch period
            events.push(NpuEvent {
                core_id: c,
                start_cycle: cycle,
                duration: 20,
                event_type: "DMA_READ".to_string(),
            });
            cycle += 50;
        }
    }
    
    NpuTrace {
        total_cycles: cycles,
        events,
    }
}

pub fn save_dummy_pccx(file_path: &str) -> anyhow::Result<()> {
    let trace = generate_dummy_trace(1000, 4); // 1000 cycles, 4 cores (dummy)
    let payload = trace.to_payload();
    
    let header = PccxHeader {
        pccx_lab_version: "v0.1.0".to_string(),
        arch: ArchConfig {
            mac_dims: (32, 32),
            isa_version: "1.0".to_string(),
        },
        trace: TraceConfig {
            cycles: trace.total_cycles,
            cores: 4,
        },
        payload: PayloadConfig {
            encoding: "json".to_string(),
            byte_length: payload.len() as u64,
        }
    };
    
    let pccx = PccxFile {
        header,
        payload,
    };
    
    let mut file = std::fs::File::create(file_path)?;
    pccx.write(&mut file)?;
    
    Ok(())
}
