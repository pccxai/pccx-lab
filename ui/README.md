# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Node.js version

CI builds `ui/` on Node.js 20 LTS (`.github/workflows/ci.yml`). For
local development please match that version — the repo ships
`ui/.nvmrc` so `nvm use` selects it automatically:

```bash
cd ui
nvm use      # reads .nvmrc → 20
npm ci
npm run build
```

Newer Node majors (e.g. Node 24) may surface environment-specific
issues in transitive dev dependencies; pinning Node 20 keeps local
behaviour aligned with CI.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
