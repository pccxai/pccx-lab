export interface WorkspaceState {
  state: string;
  traceLoaded: boolean;
  source: string;
  note: string;
}

export interface WorkflowState {
  id: string;
  label: string;
  status: string;
  boundary: string;
  note: string;
}

export interface PluginState {
  status: string;
  stableAbi: boolean;
  note: string;
}

export interface GuiState {
  status: string;
  style: string;
  surface: string;
  statusSource: string;
  themeSchemaVersion: string;
  themePresets: string[];
}

export interface DiagnosticsState {
  status: string;
  command: string;
  scope: string;
}

export interface EvidenceState {
  hardwareProbe: string;
  timingClosure: string;
  inference: string;
  throughput: string;
  note: string;
}

export interface LabStatus {
  schemaVersion: string;
  tool: string;
  version: string;
  labMode: string;
  workspaceState: WorkspaceState;
  availableWorkflows: WorkflowState[];
  pluginState: PluginState;
  guiState: GuiState;
  diagnosticsState: DiagnosticsState;
  evidenceState: EvidenceState;
  limitations: string[];
}

export interface ThemeTokens {
  background: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  panelBackground: string;
  accent: string;
  danger: string;
  warning: string;
  success: string;
}

export interface ThemePreset {
  name: string;
  description: string;
  tokens: ThemeTokens;
}

export interface ThemeTokenContract {
  schemaVersion: string;
  tokenSlots: string[];
  presets: ThemePreset[];
  limitations: string[];
}
