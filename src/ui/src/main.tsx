import React from "react";
import ReactDOM from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
// Vite bundles this worker as a separate chunk; the `?worker` query tells
// Vite to emit a Worker constructor that resolves to the built file at
// runtime. Ships the editor worker under the same origin as the rest of
// the UI (no CDN fetch, no CSP violation under Tauri's asset:// scheme).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import App from "./App";
import "./App.css";

// ─── Self-host Monaco ─────────────────────────────────────────────────────────
// Point @monaco-editor/react's loader at the bundled npm package instead of
// the default jsdelivr CDN. This keeps pccx-lab fully offline / CSP-safe
// inside the Tauri asset:// origin — no cross-origin worker downloads.
//
// SystemVerilog has no dedicated language worker (it's a Monarch DFA), so
// the generic editor worker is the only one we need to wire up. Monaco's
// main-thread tokenizer still runs for our Monarch grammar — the worker is
// used for JSON/HTML/CSS/TS language services, which pccx-lab doesn't
// exercise but Monaco loads on demand.
(globalThis as any).MonacoEnvironment = {
    getWorker(_workerId: string, _label: string) {
        return new EditorWorker();
    },
};

loader.config({ monaco });

// Radix Theme wrapper is inside App.tsx via ThemeProvider + RadixTheme bridge
// We keep appearance as "inherit" and let the ThemeContext control it
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <Theme appearance="dark" accentColor="blue" radius="medium">
            <App />
        </Theme>
    </React.StrictMode>,
);
