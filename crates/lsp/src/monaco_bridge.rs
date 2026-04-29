// monaco_bridge — Monaco LSP JSON-RPC adapter (Phase 2 M2.3)
//
// Translates between Monaco's LSP JSON-RPC expectations and the
// internal pccx-lsp provider traits.  This is a Tauri-IPC bridge,
// not a real LSP server: callers invoke methods with a JSON-RPC
// request string and receive a JSON-RPC response string.  No stdio,
// no Content-Length framing — the Tauri command layer handles
// transport.
//
// Wire format follows LSP 3.17:
//   - Hover: MarkupContent { kind: "markdown", value: ... }
//   - Completion: CompletionList { isIncomplete, items }
//   - Diagnostics: publishDiagnostics notification (no id)
//   - Errors: JSON-RPC error with code + message

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sv_diagnostics::SvDiagnosticsProvider;
use crate::sv_hover::SvHoverProvider;
use crate::sv_provider::SvKeywordProvider;
use crate::{
    CompletionProvider, DiagnosticsProvider, HoverProvider, Language, SourcePos,
};

// ─── JSON-RPC wire-format DTOs ─────────────────────────────────────

/// Inbound JSON-RPC request envelope.
#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: String,
    id: Value,
    #[allow(dead_code)]
    method: String,
    params: Value,
}

/// Outbound JSON-RPC success response.
#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    result: Value,
}

/// Outbound JSON-RPC error response.
#[derive(Debug, Serialize)]
struct JsonRpcErrorResponse {
    jsonrpc: &'static str,
    id: Value,
    error: JsonRpcError,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// Outbound JSON-RPC notification (no id).
#[derive(Debug, Serialize)]
struct JsonRpcNotification {
    jsonrpc: &'static str,
    method: &'static str,
    params: Value,
}

// ─── LSP wire-format types ─────────────────────────────────────────

#[derive(Debug, Serialize)]
struct LspMarkupContent {
    kind: &'static str,
    value: String,
}

#[derive(Debug, Serialize)]
struct LspHover {
    contents: LspMarkupContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<LspRange>,
}

#[derive(Debug, Serialize, Deserialize)]
struct LspPosition {
    line: u32,
    character: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct LspRange {
    start: LspPosition,
    end: LspPosition,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspCompletionList {
    is_incomplete: bool,
    items: Vec<LspCompletionItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspCompletionItem {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    documentation: Option<LspMarkupContent>,
    insert_text: String,
    kind: u32,
}

#[derive(Debug, Serialize)]
struct LspDiagnostic {
    range: LspRange,
    severity: u32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

// ─── Request params (subset of LSP spec) ───────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDocumentPositionParams {
    text_document: TextDocumentIdentifier,
    position: LspPosition,
}

#[derive(Debug, Deserialize)]
struct TextDocumentIdentifier {
    uri: String,
}

// ─── JSON-RPC error codes ──────────────────────────────────────────

const PARSE_ERROR: i32 = -32700;
const INVALID_PARAMS: i32 = -32602;
const INTERNAL_ERROR: i32 = -32603;

// ─── CompletionItemKind constants ──────────────────────────────────

const COMPLETION_KIND_KEYWORD: u32 = 14;

// ─── Bridge ────────────────────────────────────────────────────────

/// Monaco-to-LSP bridge.  Owns SV providers and translates JSON-RPC
/// request strings into JSON-RPC response strings.  Designed for
/// Tauri IPC — each method takes a request JSON string and returns
/// a response JSON string.
pub struct MonacoBridge {
    hover: SvHoverProvider,
    completion: SvKeywordProvider,
    diagnostics: SvDiagnosticsProvider,
    /// Open file contents, keyed by URI.  The Tauri command layer
    /// populates this on didOpen / didChange.
    files: std::collections::HashMap<String, String>,
}

impl MonacoBridge {
    pub fn new() -> Self {
        Self {
            hover: SvHoverProvider::new(),
            completion: SvKeywordProvider::new(),
            diagnostics: SvDiagnosticsProvider::new(),
            files: std::collections::HashMap::new(),
        }
    }

    /// Registers (or updates) the in-memory content for a file URI.
    pub fn set_file_content(&mut self, uri: &str, content: String) {
        self.files.insert(uri.to_string(), content);
    }

    /// Removes a file from the in-memory store.
    pub fn remove_file(&mut self, uri: &str) {
        self.files.remove(uri);
    }

    /// Handles a `textDocument/hover` JSON-RPC request.
    /// Returns a JSON-RPC response string.
    pub fn handle_hover(&self, request_json: &str) -> String {
        let req = match parse_request(request_json) {
            Ok(r) => r,
            Err(json) => return json,
        };

        let params: TextDocumentPositionParams = match serde_json::from_value(req.params.clone()) {
            Ok(p) => p,
            Err(e) => return error_response(req.id, INVALID_PARAMS, &format!("bad params: {e}")),
        };

        let uri = &params.text_document.uri;
        let file_path = uri_to_path(uri);
        let lang = match language_from_uri(uri) {
            Some(l) => l,
            None => return error_response(
                req.id,
                INVALID_PARAMS,
                &format!("unsupported file extension in URI: {uri}"),
            ),
        };

        let source = match self.files.get(uri) {
            Some(s) => s.as_str(),
            None => return error_response(
                req.id,
                INVALID_PARAMS,
                &format!("file not open: {uri}"),
            ),
        };

        let pos = SourcePos {
            line: params.position.line,
            character: params.position.character,
        };

        match self.hover.hover(lang, &file_path, pos, source) {
            Ok(Some(hover)) => {
                let lsp_hover = LspHover {
                    contents: LspMarkupContent {
                        kind: "markdown",
                        value: hover.contents,
                    },
                    range: hover.range.map(|r| LspRange {
                        start: LspPosition {
                            line: r.start.line,
                            character: r.start.character,
                        },
                        end: LspPosition {
                            line: r.end.line,
                            character: r.end.character,
                        },
                    }),
                };
                success_response(req.id, &lsp_hover)
            }
            Ok(None) => null_result_response(req.id),
            Err(e) => error_response(req.id, INTERNAL_ERROR, &e.to_string()),
        }
    }

    /// Handles a `textDocument/completion` JSON-RPC request.
    /// Returns a JSON-RPC response string.
    pub fn handle_completion(&self, request_json: &str) -> String {
        let req = match parse_request(request_json) {
            Ok(r) => r,
            Err(json) => return json,
        };

        let params: TextDocumentPositionParams = match serde_json::from_value(req.params.clone()) {
            Ok(p) => p,
            Err(e) => return error_response(req.id, INVALID_PARAMS, &format!("bad params: {e}")),
        };

        let uri = &params.text_document.uri;
        let file_path = uri_to_path(uri);
        let lang = match language_from_uri(uri) {
            Some(l) => l,
            None => return error_response(
                req.id,
                INVALID_PARAMS,
                &format!("unsupported file extension in URI: {uri}"),
            ),
        };

        let source = match self.files.get(uri) {
            Some(s) => s.as_str(),
            None => return error_response(
                req.id,
                INVALID_PARAMS,
                &format!("file not open: {uri}"),
            ),
        };

        let pos = SourcePos {
            line: params.position.line,
            character: params.position.character,
        };

        match self.completion.complete(lang, &file_path, pos, source) {
            Ok(items) => {
                let lsp_items: Vec<LspCompletionItem> = items
                    .into_iter()
                    .map(|c| LspCompletionItem {
                        label: c.label,
                        detail: c.detail,
                        documentation: c.documentation.map(|d| LspMarkupContent {
                            kind: "markdown",
                            value: d,
                        }),
                        insert_text: c.insert_text,
                        kind: COMPLETION_KIND_KEYWORD,
                    })
                    .collect();
                let list = LspCompletionList {
                    is_incomplete: false,
                    items: lsp_items,
                };
                success_response(req.id, &list)
            }
            Err(e) => error_response(req.id, INTERNAL_ERROR, &e.to_string()),
        }
    }

    /// Generates a `textDocument/publishDiagnostics` notification for
    /// the given file content.  This is a server-initiated notification
    /// (no request id).
    pub fn publish_diagnostics(&self, uri: &str, source: &str) -> String {
        let file_path = uri_to_path(uri);
        let lang = language_from_uri(uri).unwrap_or(Language::SystemVerilog);

        let diags = match self.diagnostics.diagnostics(lang, &file_path, source) {
            Ok(d) => d,
            Err(_) => Vec::new(),
        };

        let lsp_diags: Vec<LspDiagnostic> = diags
            .into_iter()
            .map(|d| LspDiagnostic {
                range: LspRange {
                    start: LspPosition {
                        line: d.range.start.line,
                        character: d.range.start.character,
                    },
                    end: LspPosition {
                        line: d.range.end.line,
                        character: d.range.end.character,
                    },
                },
                severity: d.severity as u32,
                message: d.message,
                source: d.source,
            })
            .collect();

        let notification = JsonRpcNotification {
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: serde_json::json!({
                "uri": uri,
                "diagnostics": serde_json::to_value(&lsp_diags).unwrap_or_default(),
            }),
        };

        serde_json::to_string(&notification).unwrap_or_default()
    }

}

impl Default for MonacoBridge {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Helpers ───────────────────────────────────────────────────────

/// Strips the `file://` prefix from a URI to get a local path.
fn uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file://").unwrap_or(uri).to_string()
}

/// Extracts the file extension from a URI and maps it to a Language.
fn language_from_uri(uri: &str) -> Option<Language> {
    let path = uri_to_path(uri);
    let ext = path.rsplit('.').next()?;
    Language::from_extension(ext)
}

/// Parses a JSON-RPC request string.  Returns Ok(request) or
/// Err(error_json) with a parse-error response.
fn parse_request(json: &str) -> Result<JsonRpcRequest, String> {
    serde_json::from_str(json).map_err(|e| {
        let resp = JsonRpcErrorResponse {
            jsonrpc: "2.0",
            id: Value::Null,
            error: JsonRpcError {
                code: PARSE_ERROR,
                message: format!("JSON parse error: {e}"),
            },
        };
        serde_json::to_string(&resp).unwrap_or_default()
    })
}

/// Builds a JSON-RPC success response with a serializable result.
fn success_response<T: Serialize>(id: Value, result: &T) -> String {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: serde_json::to_value(result).unwrap_or(Value::Null),
    };
    serde_json::to_string(&resp).unwrap_or_default()
}

/// Builds a JSON-RPC success response with result: null.
fn null_result_response(id: Value) -> String {
    let resp = JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Value::Null,
    };
    serde_json::to_string(&resp).unwrap_or_default()
}

/// Builds a JSON-RPC error response.
fn error_response(id: Value, code: i32, message: &str) -> String {
    let resp = JsonRpcErrorResponse {
        jsonrpc: "2.0",
        id,
        error: JsonRpcError {
            code,
            message: message.to_string(),
        },
    };
    serde_json::to_string(&resp).unwrap_or_default()
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_SV: &str = "\
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

    fn make_bridge() -> MonacoBridge {
        let mut bridge = MonacoBridge::new();
        bridge.set_file_content("file:///workspace/test.sv", SAMPLE_SV.to_string());
        bridge
    }

    fn hover_request(id: impl Into<Value>, uri: &str, line: u32, character: u32) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id.into(),
            "method": "textDocument/hover",
            "params": {
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character }
            }
        })
        .to_string()
    }

    fn completion_request(id: impl Into<Value>, uri: &str, line: u32, character: u32) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id.into(),
            "method": "textDocument/completion",
            "params": {
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character }
            }
        })
        .to_string()
    }

    // ─── Hover tests ───────────────────────────────────────────────

    #[test]
    fn hover_round_trip_returns_module_info() {
        let bridge = make_bridge();
        let req = hover_request(1, "file:///workspace/test.sv", 2, 10);
        let resp_json = bridge.handle_hover(&req);
        let resp: Value = serde_json::from_str(&resp_json).expect("valid JSON");

        // Response envelope
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert!(resp.get("error").is_none(), "must not have error field");

        // Hover content
        let result = &resp["result"];
        assert_eq!(result["contents"]["kind"], "markdown");
        let value = result["contents"]["value"].as_str().unwrap();
        assert!(value.contains("ctrl_npu_frontend"), "must mention module name");
        assert!(value.contains("ROWS"), "must list parameters");

        // Range must be present
        assert!(result["range"].is_object(), "hover should include range");
    }

    #[test]
    fn hover_on_unknown_symbol_returns_null_result() {
        let bridge = make_bridge();
        // Line 10 "endmodule" — no hover data
        let req = hover_request(42, "file:///workspace/test.sv", 10, 0);
        let resp_json = bridge.handle_hover(&req);
        let resp: Value = serde_json::from_str(&resp_json).expect("valid JSON");

        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 42);
        assert!(resp["result"].is_null(), "no hover = null result");
        assert!(resp.get("error").is_none());
    }

    #[test]
    fn hover_preserves_string_id() {
        let bridge = make_bridge();
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "req-abc",
            "method": "textDocument/hover",
            "params": {
                "textDocument": { "uri": "file:///workspace/test.sv" },
                "position": { "line": 2, "character": 10 }
            }
        })
        .to_string();
        let resp: Value = serde_json::from_str(&bridge.handle_hover(&req)).unwrap();
        assert_eq!(resp["id"], "req-abc", "string ids must echo back unchanged");
    }

    // ─── Completion tests ──────────────────────────────────────────

    #[test]
    fn completion_round_trip_returns_keyword_list() {
        let bridge = make_bridge();
        let req = completion_request(2, "file:///workspace/test.sv", 0, 0);
        let resp_json = bridge.handle_completion(&req);
        let resp: Value = serde_json::from_str(&resp_json).expect("valid JSON");

        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 2);
        assert!(resp.get("error").is_none());

        let result = &resp["result"];
        assert_eq!(result["isIncomplete"], false);

        let items = result["items"].as_array().expect("items must be array");
        assert!(!items.is_empty(), "must return completion items");

        // Verify first item has the required fields
        let first = &items[0];
        assert!(first["label"].is_string());
        assert!(first["insertText"].is_string());
        assert!(first["kind"].is_number(), "kind must be a number");
        assert_eq!(first["kind"], COMPLETION_KIND_KEYWORD);
    }

    #[test]
    fn completion_items_contain_module_keyword() {
        let bridge = make_bridge();
        let req = completion_request(3, "file:///workspace/test.sv", 0, 0);
        let resp: Value = serde_json::from_str(&bridge.handle_completion(&req)).unwrap();
        let items = resp["result"]["items"].as_array().unwrap();
        let labels: Vec<&str> = items.iter().map(|i| i["label"].as_str().unwrap()).collect();
        assert!(labels.contains(&"module"));
        assert!(labels.contains(&"always_ff"));
    }

    // ─── Diagnostics notification tests ────────────────────────────

    #[test]
    fn diagnostics_notification_has_correct_shape() {
        let bridge = MonacoBridge::new();
        let sv = "\
module bad (
    input  logic clk,
    output logic data_out
);
endmodule
";
        let notif_json = bridge.publish_diagnostics("file:///workspace/bad.sv", sv);
        let notif: Value = serde_json::from_str(&notif_json).expect("valid JSON");

        assert_eq!(notif["jsonrpc"], "2.0");
        assert_eq!(notif["method"], "textDocument/publishDiagnostics");
        // Notifications must NOT have an "id" field
        assert!(notif.get("id").is_none(), "notification must not have id");

        let params = &notif["params"];
        assert_eq!(params["uri"], "file:///workspace/bad.sv");

        let diags = params["diagnostics"].as_array().expect("diagnostics array");
        assert!(!diags.is_empty(), "should report convention violations");

        // Severity must be an integer, not a string
        for d in diags {
            assert!(
                d["severity"].is_number(),
                "severity must be a number, got: {}",
                d["severity"]
            );
            let sev = d["severity"].as_u64().unwrap();
            assert!(
                (1..=4).contains(&sev),
                "severity must be 1..=4, got {sev}"
            );
        }
    }

    #[test]
    fn diagnostics_for_clean_module_returns_empty_array() {
        let bridge = MonacoBridge::new();
        let sv = "\
module good (
    input  logic i_clk,
    output logic o_data
);
endmodule
";
        let notif: Value =
            serde_json::from_str(&bridge.publish_diagnostics("file:///workspace/good.sv", sv))
                .unwrap();
        let diags = notif["params"]["diagnostics"].as_array().unwrap();
        assert!(diags.is_empty(), "clean module should have no diagnostics");
    }

    // ─── Error response tests ──────────────────────────────────────

    #[test]
    fn hover_unknown_extension_returns_error() {
        let mut bridge = MonacoBridge::new();
        bridge.set_file_content("file:///workspace/readme.txt", "hello".to_string());
        let req = hover_request(7, "file:///workspace/readme.txt", 0, 0);
        let resp: Value = serde_json::from_str(&bridge.handle_hover(&req)).unwrap();

        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 7);
        assert!(resp.get("result").is_none(), "error response must not have result");

        let err = &resp["error"];
        assert_eq!(err["code"], INVALID_PARAMS);
        assert!(err["message"].as_str().unwrap().contains("unsupported"));
    }

    #[test]
    fn completion_unknown_extension_returns_error() {
        let mut bridge = MonacoBridge::new();
        bridge.set_file_content("file:///workspace/notes.xyz", "stuff".to_string());
        let req = completion_request(8, "file:///workspace/notes.xyz", 0, 0);
        let resp: Value = serde_json::from_str(&bridge.handle_completion(&req)).unwrap();

        assert_eq!(resp["id"], 8);
        assert_eq!(resp["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn hover_unopened_file_returns_error() {
        let bridge = MonacoBridge::new();
        let req = hover_request(9, "file:///workspace/missing.sv", 0, 0);
        let resp: Value = serde_json::from_str(&bridge.handle_hover(&req)).unwrap();

        assert_eq!(resp["error"]["code"], INVALID_PARAMS);
        assert!(resp["error"]["message"].as_str().unwrap().contains("not open"));
    }

    #[test]
    fn malformed_json_returns_parse_error() {
        let bridge = MonacoBridge::new();
        let resp: Value =
            serde_json::from_str(&bridge.handle_hover("not valid json {{{")).unwrap();
        assert_eq!(resp["error"]["code"], PARSE_ERROR);
        assert_eq!(resp["id"], Value::Null);
    }

    // ─── File management tests ─────────────────────────────────────

    #[test]
    fn set_and_remove_file_content() {
        let mut bridge = MonacoBridge::new();
        bridge.set_file_content("file:///a.sv", "module a; endmodule".to_string());
        assert!(bridge.files.contains_key("file:///a.sv"));
        bridge.remove_file("file:///a.sv");
        assert!(!bridge.files.contains_key("file:///a.sv"));
    }

    // ─── URI helpers ───────────────────────────────────────────────

    #[test]
    fn uri_to_path_strips_file_prefix() {
        assert_eq!(uri_to_path("file:///home/user/test.sv"), "/home/user/test.sv");
        assert_eq!(uri_to_path("/already/a/path.sv"), "/already/a/path.sv");
    }

    #[test]
    fn language_from_uri_maps_sv_extensions() {
        assert_eq!(language_from_uri("file:///x.sv"), Some(Language::SystemVerilog));
        assert_eq!(language_from_uri("file:///x.svh"), Some(Language::SystemVerilog));
        assert_eq!(language_from_uri("file:///x.rs"), Some(Language::Rust));
        assert_eq!(language_from_uri("file:///x.unknown"), None);
    }
}
