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

export interface WorkflowDescriptor {
  workflowId: string;
  label: string;
  category: string;
  description: string;
  availabilityState: string;
  executionState: string;
  inputPolicy: string;
  outputPolicy: string;
  safetyFlags: string[];
  evidenceState: string;
  futureConsumers: string[];
  limitations: string[];
}

export interface WorkflowDescriptorSet {
  schemaVersion: string;
  tool: string;
  descriptors: WorkflowDescriptor[];
  limitations: string[];
}

export interface WorkflowProposal {
  proposalId: string;
  workflowId: string;
  label: string;
  proposalState: string;
  approvalRequired: boolean;
  commandKind: string;
  fixedArgsPreview: string[];
  inputSummary: string;
  outputPolicy: string;
  safetyFlags: string[];
  expectedArtifacts: string[];
  limitations: string[];
}

export interface WorkflowProposalSet {
  schemaVersion: string;
  tool: string;
  proposals: WorkflowProposal[];
  limitations: string[];
}

export interface WorkflowRunnerStatus {
  schemaVersion: string;
  enabled: boolean;
  mode: string;
  timeoutMs: number;
  maxOutputLines: number;
  allowlistedProposalIds: string[];
  limitations: string[];
}

export interface WorkflowResultSummary {
  schemaVersion: string;
  proposalId: string;
  workflowId: string;
  status: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  truncated: boolean;
  redactionApplied: boolean;
  outputPolicy: string;
  limitations: string[];
}

export interface WorkflowResultSummarySet {
  schemaVersion: string;
  tool: string;
  maxEntries: number;
  summaries: WorkflowResultSummary[];
  limitations: string[];
}
