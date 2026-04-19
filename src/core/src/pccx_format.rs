// Module Boundary: core/
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use thiserror::Error;

const MAGIC_NUMBER: &[u8; 4] = b"PCCX";
const SPEC_VERSION: u8 = 0x01;

#[derive(Error, Debug)]
pub enum PccxError {
    #[error("Invalid magic number. Expected 'PCCX'")]
    InvalidMagicNumber,
    #[error("Unsupported specification version. Expected {0}, got {1}")]
    UnsupportedVersion(u8, u8),
    #[error("IO Error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("JSON Deserialization Error: {0}")]
    JsonError(#[from] serde_json::Error),
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct ArchConfig {
    pub mac_dims: (u32, u32),
    pub isa_version: String,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct TraceConfig {
    pub cycles: u64,
    pub cores: u32,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct PayloadConfig {
    pub encoding: String,
    pub byte_length: u64,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct PccxHeader {
    pub pccx_lab_version: String,
    
    #[serde(default)]
    pub arch: ArchConfig,
    
    #[serde(default)]
    pub trace: TraceConfig,
    
    #[serde(default)]
    pub payload: PayloadConfig,
}

pub struct PccxFile {
    pub header: PccxHeader,
    pub payload: Vec<u8>, // Binary payload
}

impl PccxFile {
    pub fn write<W: Write>(&self, w: &mut W) -> Result<(), PccxError> {
        // Write Magic Number (4 bytes)
        w.write_all(MAGIC_NUMBER)?;
        
        // Write Spec Version (1 byte)
        w.write_all(&[SPEC_VERSION])?;
        
        // Write Reserved (3 bytes)
        w.write_all(&[0x00, 0x00, 0x00])?;
        
        // Serialize JSON Header
        let json_header = serde_json::to_vec(&self.header)?;
        let header_length = json_header.len() as u64;
        
        // Write Header Length (8 bytes, Little Endian)
        w.write_all(&header_length.to_le_bytes())?;
        
        // Write JSON Header (N bytes)
        w.write_all(&json_header)?;
        
        // Write Binary Payload (M bytes)
        w.write_all(&self.payload)?;
        
        Ok(())
    }

    pub fn read<R: Read>(r: &mut R) -> Result<Self, PccxError> {
        // Read Magic Number
        let mut magic = [0u8; 4];
        r.read_exact(&mut magic)?;
        if &magic != MAGIC_NUMBER {
            return Err(PccxError::InvalidMagicNumber);
        }
        
        // Read Spec Version
        let mut version = [0u8; 1];
        r.read_exact(&mut version)?;
        if version[0] != SPEC_VERSION {
            return Err(PccxError::UnsupportedVersion(SPEC_VERSION, version[0]));
        }
        
        // Read Reserved
        let mut reserved = [0u8; 3];
        r.read_exact(&mut reserved)?;
        
        // Read Header Length
        let mut header_len_buf = [0u8; 8];
        r.read_exact(&mut header_len_buf)?;
        let header_length = u64::from_le_bytes(header_len_buf);
        
        // Read JSON Header
        let mut json_header = vec![0u8; header_length as usize];
        r.read_exact(&mut json_header)?;
        let header: PccxHeader = serde_json::from_slice(&json_header)?;
        
        // Read Binary Payload
        let mut payload = vec![0u8; header.payload.byte_length as usize];
        r.read_exact(&mut payload)?;
        
        Ok(Self { header, payload })
    }
}
