// Module Boundary: remote/
// pccx-remote: secure backend daemon for remote pccx-lab access.
//
// Provides an HTTP server (axum) that exposes trace analysis, session
// management, and health endpoints.  Run the companion `pccx-server`
// binary to start a standalone daemon, or call `serve()` / `create_router()`
// from the Tauri host to embed the server in-process.

use axum::{
    extract::State as AxumState,
    http::StatusCode,
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

// ─── preserved scaffold constants ──────────────────────────────────

/// Placeholder until the Phase 3 auth layer lands.  Currently returns
/// a static string identifying the crate for feature-gate discovery.
pub const SCAFFOLD_TAG: &str = "pccx-remote: Phase 3 scaffold";

/// OpenAPI 3.0 specification of the planned REST surface.  No
/// endpoints are implemented yet — the schema is authored ahead of
/// time so the pccx-ide + web client can generate typed clients
/// against a stable contract from day one.
///
/// See `openapi.yaml` alongside this file for the full document.
pub const OPENAPI_SPEC: &str = include_str!("../openapi.yaml");

/// Endpoint families the Phase 3 implementation will expose.  Lives
/// here as an `enum` so the pccx-ide can feature-gate UI affordances
/// on the subset that is live on a given server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointFamily {
    Auth,
    Sessions,
    Traces,
    Reports,
    Events,
}

impl EndpointFamily {
    pub const ALL: &'static [EndpointFamily] = &[
        Self::Auth,
        Self::Sessions,
        Self::Traces,
        Self::Reports,
        Self::Events,
    ];

    pub const fn path_prefix(self) -> &'static str {
        match self {
            Self::Auth => "/v1/auth",
            Self::Sessions => "/v1/sessions",
            Self::Traces => "/v1/traces",
            Self::Reports => "/v1/reports",
            Self::Events => "/v1/events",
        }
    }
}

// ─── server types ──────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub created_at: u64,
    pub client_ip: String,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime_secs: u64,
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub session_id: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct TraceUploadRequest {
    pub name: String,
    pub format: String,
}

// ─── connection config ────────────────────────────────────────────

/// Configuration for connecting to a remote pccx-lab daemon.
/// Used by the Tauri client to establish a session over the
/// WireGuard / QUIC tunnel (Phase 3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    /// Bearer token from the OIDC + WebAuthn auth flow.
    /// `None` for local / dev connections that bypass auth.
    pub auth_token: Option<String>,
    /// Connection timeout in milliseconds.
    pub timeout_ms: u32,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            host: "localhost".to_string(),
            port: 9400,
            auth_token: None,
            timeout_ms: 30_000,
        }
    }
}

// ─── remote session ───────────────────────────────────────────────

/// Lifecycle state of a `RemoteSession`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionState {
    Connected,
    Disconnected,
}

/// Client-side handle to a remote daemon session.
/// Currently a stub — real I/O lands with M3.1 (WireGuard control plane).
#[derive(Debug, Clone)]
pub struct RemoteSession {
    pub id: String,
    pub config: ConnectionConfig,
    pub state: SessionState,
}

impl RemoteSession {
    /// Create a new session in `Disconnected` state.
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            config,
            state: SessionState::Disconnected,
        }
    }

    /// Attempt to connect to the remote daemon.
    /// Stub: flips state to `Connected` without real I/O.
    pub fn connect(&mut self) -> Result<(), String> {
        if self.state == SessionState::Connected {
            return Err("already connected".to_string());
        }
        // TODO(M3.1): WireGuard handshake + TLS upgrade
        self.state = SessionState::Connected;
        Ok(())
    }

    /// Disconnect from the remote daemon.
    /// Stub: flips state to `Disconnected`.
    pub fn disconnect(&mut self) -> Result<(), String> {
        if self.state == SessionState::Disconnected {
            return Err("not connected".to_string());
        }
        self.state = SessionState::Disconnected;
        Ok(())
    }

    /// Returns `true` when the session is in `Connected` state.
    pub fn is_alive(&self) -> bool {
        self.state == SessionState::Connected
    }
}

// ─── trace stream protocol ────────────────────────────────────────

/// Wire-level message types for the trace tile streaming protocol.
/// Travels inside the authenticated tunnel; the outer transport
/// (WireGuard / QUIC) handles encryption.
///
/// Frame layout (big-endian, network byte order):
///   byte 0      : msg_type (u8)
///   bytes 1..5  : payload_len (u32)
///   bytes 5..   : payload (payload_len bytes)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MessageType {
    /// Client requests a range of trace tiles.
    TileRequest = 0x01,
    /// Server responds with tile data.
    TileResponse = 0x02,
    /// Keep-alive ping / pong (25s interval per Phase 3 spec).
    Heartbeat = 0x03,
    /// Error report from either side.
    Error = 0x04,
}

impl MessageType {
    pub fn as_u8(self) -> u8 {
        self as u8
    }

    pub fn try_from_u8(val: u8) -> Result<Self, ProtocolError> {
        match val {
            0x01 => Ok(Self::TileRequest),
            0x02 => Ok(Self::TileResponse),
            0x03 => Ok(Self::Heartbeat),
            0x04 => Ok(Self::Error),
            other => Err(ProtocolError::UnknownMessageType(other)),
        }
    }
}

/// Protocol-level errors during frame encode / decode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// Input buffer shorter than the 5-byte header.
    BufferTooShort,
    /// Header declares a message type we don't recognise.
    UnknownMessageType(u8),
    /// Header says N payload bytes, but the buffer has fewer.
    PayloadLengthMismatch { expected: u32, actual: u32 },
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BufferTooShort => write!(f, "buffer shorter than 5-byte frame header"),
            Self::UnknownMessageType(t) => write!(f, "unknown message type: 0x{:02x}", t),
            Self::PayloadLengthMismatch { expected, actual } => {
                write!(f, "payload length mismatch: header says {} bytes, buffer has {}", expected, actual)
            }
        }
    }
}

/// Header size in bytes: 1 (msg_type) + 4 (payload_len).
pub const FRAME_HEADER_SIZE: usize = 5;

/// A single decoded protocol frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub msg_type: MessageType,
    pub payload: Vec<u8>,
}

impl Frame {
    /// Encode this frame into a byte vector (big-endian wire format).
    pub fn encode(&self) -> Vec<u8> {
        let payload_len = self.payload.len() as u32;
        let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + self.payload.len());
        buf.push(self.msg_type.as_u8());
        buf.extend_from_slice(&payload_len.to_be_bytes());
        buf.extend_from_slice(&self.payload);
        buf
    }

    /// Decode a frame from a byte buffer.  The buffer must contain
    /// exactly one complete frame (header + payload).
    pub fn decode(buf: &[u8]) -> Result<Self, ProtocolError> {
        if buf.len() < FRAME_HEADER_SIZE {
            return Err(ProtocolError::BufferTooShort);
        }
        let msg_type = MessageType::try_from_u8(buf[0])?;
        let payload_len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
        let payload_start = FRAME_HEADER_SIZE;
        let available = (buf.len() - payload_start) as u32;
        if available < payload_len {
            return Err(ProtocolError::PayloadLengthMismatch {
                expected: payload_len,
                actual: available,
            });
        }
        let payload = buf[payload_start..payload_start + payload_len as usize].to_vec();
        Ok(Self { msg_type, payload })
    }
}

// ─── health check ─────────────────────────────────────────────────

/// Domain-level health snapshot for the daemon.  Distinct from
/// `HealthResponse` (which is the HTTP handler's JSON shape) — this
/// struct carries richer state for internal consumers and the
/// planned `/v1/events` WebSocket subscription.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthCheck {
    /// Seconds since the daemon process started.
    pub uptime_secs: u64,
    /// Crate version (`CARGO_PKG_VERSION`).
    pub version: String,
    /// Names of .pccx traces currently loaded in memory.
    pub loaded_traces: Vec<String>,
}

impl HealthCheck {
    /// Snapshot from the current process.  `loaded_traces` is supplied
    /// by the caller (the session manager knows what's loaded).
    pub fn now(start_time: std::time::Instant, loaded_traces: Vec<String>) -> Self {
        Self {
            uptime_secs: start_time.elapsed().as_secs(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            loaded_traces,
        }
    }
}

// ─── handlers ──────────────────────────────────────────────────────

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_secs: 0, // TODO: track actual uptime
    })
}

async fn create_session(
    AxumState(state): AxumState<AppState>,
) -> (StatusCode, Json<SessionResponse>) {
    let id = Uuid::new_v4().to_string();
    let session = Session {
        id: id.clone(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        client_ip: "unknown".to_string(),
    };
    state.sessions.lock().unwrap().insert(id.clone(), session);
    (
        StatusCode::CREATED,
        Json(SessionResponse {
            session_id: id,
            message: "Session created".to_string(),
        }),
    )
}

async fn list_sessions(AxumState(state): AxumState<AppState>) -> Json<Vec<Session>> {
    let sessions = state.sessions.lock().unwrap();
    Json(sessions.values().cloned().collect())
}

async fn api_spec() -> &'static str {
    OPENAPI_SPEC
}

// ─── router / server ───────────────────────────────────────────────

pub fn create_router() -> Router {
    let state = AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };

    Router::new()
        .route("/health", get(health))
        .route("/api/spec", get(api_spec))
        .route("/api/v1/sessions", get(list_sessions).post(create_session))
        .with_state(state)
}

/// Start the remote server on the given address.
/// Call this from a binary or from the Tauri app.
pub async fn serve(addr: &str) -> Result<(), Box<dyn std::error::Error>> {
    let app = create_router();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("pccx-lab remote server listening on {}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

// ─── tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_tag_is_non_empty() {
        assert!(!SCAFFOLD_TAG.is_empty());
    }

    #[test]
    fn openapi_spec_is_valid_yaml_header() {
        assert!(OPENAPI_SPEC.starts_with("openapi: "));
        assert!(OPENAPI_SPEC.contains("pccx-remote"));
    }

    #[test]
    fn all_endpoint_families_have_distinct_prefixes() {
        let mut seen = std::collections::HashSet::new();
        for fam in EndpointFamily::ALL {
            assert!(seen.insert(fam.path_prefix()), "duplicate prefix");
        }
    }

    // ─── connection config tests ──────────────────────────────────

    #[test]
    fn connection_config_default_values() {
        let cfg = ConnectionConfig::default();
        assert_eq!(cfg.host, "localhost");
        assert_eq!(cfg.port, 9400);
        assert!(cfg.auth_token.is_none());
        assert_eq!(cfg.timeout_ms, 30_000);
    }

    #[test]
    fn connection_config_with_auth_token() {
        let cfg = ConnectionConfig {
            host: "remote.example.com".to_string(),
            port: 8443,
            auth_token: Some("ey.jwt.token".to_string()),
            timeout_ms: 5_000,
        };
        assert_eq!(cfg.auth_token.as_deref(), Some("ey.jwt.token"));
    }

    #[test]
    fn connection_config_json_round_trip() {
        let cfg = ConnectionConfig {
            host: "10.0.0.1".to_string(),
            port: 9400,
            auth_token: Some("tok".to_string()),
            timeout_ms: 15_000,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let restored: ConnectionConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(cfg, restored);
    }

    // ─── remote session tests ─────────────────────────────────────

    #[test]
    fn remote_session_connect_disconnect_lifecycle() {
        let mut sess = RemoteSession::new(ConnectionConfig::default());
        assert!(!sess.is_alive());
        assert_eq!(sess.state, SessionState::Disconnected);

        sess.connect().unwrap();
        assert!(sess.is_alive());
        assert_eq!(sess.state, SessionState::Connected);

        sess.disconnect().unwrap();
        assert!(!sess.is_alive());
    }

    #[test]
    fn remote_session_double_connect_errors() {
        let mut sess = RemoteSession::new(ConnectionConfig::default());
        sess.connect().unwrap();
        assert!(sess.connect().is_err());
    }

    #[test]
    fn remote_session_disconnect_when_not_connected_errors() {
        let mut sess = RemoteSession::new(ConnectionConfig::default());
        assert!(sess.disconnect().is_err());
    }

    #[test]
    fn remote_session_has_uuid_id() {
        let sess = RemoteSession::new(ConnectionConfig::default());
        // UUID v4 is 36 chars with hyphens (8-4-4-4-12).
        assert_eq!(sess.id.len(), 36);
        assert_eq!(sess.id.chars().filter(|c| *c == '-').count(), 4);
    }

    // ─── protocol frame tests ─────────────────────────────────────

    #[test]
    fn frame_encode_decode_round_trip_with_payload() {
        let original = Frame {
            msg_type: MessageType::TileResponse,
            payload: vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02],
        };
        let wire = original.encode();
        // Header: 1 byte type + 4 bytes length = 5, plus 6 payload bytes.
        assert_eq!(wire.len(), FRAME_HEADER_SIZE + 6);
        let decoded = Frame::decode(&wire).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn frame_encode_decode_round_trip_empty_payload() {
        let original = Frame {
            msg_type: MessageType::Heartbeat,
            payload: vec![],
        };
        let wire = original.encode();
        assert_eq!(wire.len(), FRAME_HEADER_SIZE);
        let decoded = Frame::decode(&wire).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn frame_decode_rejects_truncated_header() {
        // Only 3 bytes — less than the 5-byte header.
        let buf = [0x01, 0x00, 0x00];
        assert_eq!(Frame::decode(&buf), Err(ProtocolError::BufferTooShort));
    }

    #[test]
    fn frame_decode_rejects_truncated_payload() {
        // Valid header claiming 10 payload bytes, but only 2 present.
        let mut buf = vec![MessageType::TileRequest.as_u8()];
        buf.extend_from_slice(&10u32.to_be_bytes());
        buf.extend_from_slice(&[0xAA, 0xBB]);
        match Frame::decode(&buf) {
            Err(ProtocolError::PayloadLengthMismatch { expected: 10, actual: 2 }) => {}
            other => panic!("expected PayloadLengthMismatch, got {:?}", other),
        }
    }

    #[test]
    fn frame_decode_rejects_unknown_message_type() {
        let mut buf = vec![0xFF]; // invalid type
        buf.extend_from_slice(&0u32.to_be_bytes());
        assert_eq!(
            Frame::decode(&buf),
            Err(ProtocolError::UnknownMessageType(0xFF))
        );
    }

    #[test]
    fn message_type_round_trip_all_variants() {
        for &mt in &[
            MessageType::TileRequest,
            MessageType::TileResponse,
            MessageType::Heartbeat,
            MessageType::Error,
        ] {
            let byte = mt.as_u8();
            let restored = MessageType::try_from_u8(byte).unwrap();
            assert_eq!(restored, mt);
        }
    }

    #[test]
    fn frame_big_endian_wire_order() {
        let frame = Frame {
            msg_type: MessageType::TileRequest,
            payload: vec![0x00; 256],
        };
        let wire = frame.encode();
        // payload_len = 256 = 0x00000100 in big-endian.
        assert_eq!(&wire[1..5], &[0x00, 0x00, 0x01, 0x00]);
    }

    // ─── health check tests ──────────────────────────────────────

    #[test]
    fn health_check_json_round_trip() {
        let hc = HealthCheck {
            uptime_secs: 3600,
            version: "0.1.0".to_string(),
            loaded_traces: vec!["matmul.pccx".to_string(), "conv2d.pccx".to_string()],
        };
        let json = serde_json::to_string(&hc).unwrap();
        let restored: HealthCheck = serde_json::from_str(&json).unwrap();
        assert_eq!(hc, restored);
    }

    #[test]
    fn health_check_now_captures_uptime() {
        let start = std::time::Instant::now();
        let hc = HealthCheck::now(start, vec!["test.pccx".to_string()]);
        // Just started, so uptime should be 0 or 1.
        assert!(hc.uptime_secs <= 1);
        assert_eq!(hc.loaded_traces, vec!["test.pccx"]);
        assert!(!hc.version.is_empty());
    }

    #[test]
    fn health_check_empty_traces() {
        let hc = HealthCheck {
            uptime_secs: 0,
            version: "0.1.0".to_string(),
            loaded_traces: vec![],
        };
        let json = serde_json::to_string(&hc).unwrap();
        assert!(json.contains("\"loaded_traces\":[]"));
    }
}
