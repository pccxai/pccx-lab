import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";

let inflight: Promise<void> | null = null;

/**
 * Initialise Monaco editor and web-worker once.
 * Safe to call from multiple components; only the first invocation
 * performs the async bootstrap — subsequent calls return the same promise.
 */
export function ensureMonacoReady(): Promise<void> {
  if (!inflight) {
    inflight = (async () => {
      const [{ loader }, monaco, { default: EditorWorker }] = await Promise.all([
        import("@monaco-editor/react"),
        import("monaco-editor"),
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      ]);

      // Only set MonacoEnvironment once to avoid worker churn
      if (!(globalThis as any).MonacoEnvironment) {
        (globalThis as any).MonacoEnvironment = {
          getWorker(_workerId: string, _label: string) {
            return new EditorWorker();
          },
        };
      }

      loader.config({ monaco });
    })();
  }
  return inflight;
}

// ─── LSP IPC response shapes ─────────────────────────────────────────────────

interface LspHoverResult {
  contents: string;
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
}

interface LspCompletionItem {
  label: string;
  kind: number;
  detail: string | null;
  insertText: string;
  documentation: string | null;
}

interface LspDiagnosticItem {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: number;
  message: string;
  source: string | null;
}

// ─── LSP provider registration ───────────────────────────────────────────────

let lspProvidersRegistered = false;

/**
 * Registers Monaco HoverProvider and CompletionItemProvider for the
 * "systemverilog" language.  Calls are forwarded to the Rust backend
 * via Tauri IPC (`lsp_hover`, `lsp_complete`).  Idempotent — safe to
 * call on every editor mount.
 */
export function registerLspProviders(monaco: typeof Monaco): void {
  if (lspProvidersRegistered) return;
  lspProvidersRegistered = true;

  // Hover provider
  monaco.languages.registerHoverProvider("systemverilog", {
    async provideHover(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
    ): Promise<Monaco.languages.Hover | null | undefined> {
      try {
        const result = await invoke<LspHoverResult | null>("lsp_hover", {
          uri: model.uri.toString(),
          line: position.lineNumber - 1,
          character: position.column - 1,
          source: model.getValue(),
        });
        if (!result) return undefined;
        return {
          contents: [{ value: result.contents }],
          range: result.range
            ? new monaco.Range(
                result.range.startLineNumber,
                result.range.startColumn,
                result.range.endLineNumber,
                result.range.endColumn,
              )
            : undefined,
        };
      } catch {
        return undefined;
      }
    },
  });

  // Completion provider
  monaco.languages.registerCompletionItemProvider("systemverilog", {
    triggerCharacters: [".", "_"],
    async provideCompletionItems(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
    ): Promise<Monaco.languages.CompletionList> {
      try {
        const items = await invoke<LspCompletionItem[]>("lsp_complete", {
          uri: model.uri.toString(),
          line: position.lineNumber - 1,
          character: position.column - 1,
          source: model.getValue(),
        });
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: item.kind as Monaco.languages.CompletionItemKind,
            detail: item.detail ?? undefined,
            documentation: item.documentation ?? undefined,
            insertText: item.insertText,
            range,
          })),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });
}

// ─── LSP diagnostics updater ─────────────────────────────────────────────────

/**
 * Fetches diagnostics for the given model from the Rust backend and
 * pushes them into Monaco's marker system.  Designed to be called
 * after file load and on a 500 ms debounce after edits.
 */
export async function updateDiagnostics(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
): Promise<void> {
  try {
    const items = await invoke<LspDiagnosticItem[]>("lsp_diagnostics", {
      uri: model.uri.toString(),
      source: model.getValue(),
    });
    const markers: Monaco.editor.IMarkerData[] = items.map((d) => ({
      startLineNumber: d.startLineNumber,
      startColumn: d.startColumn,
      endLineNumber: d.endLineNumber,
      endColumn: d.endColumn,
      severity: d.severity as Monaco.MarkerSeverity,
      message: d.message,
      source: d.source ?? "pccx-lsp",
    }));
    monaco.editor.setModelMarkers(model, "pccx-lsp", markers);
  } catch {
    // Backend unavailable — clear stale markers rather than leave ghosts.
    monaco.editor.setModelMarkers(model, "pccx-lsp", []);
  }
}

