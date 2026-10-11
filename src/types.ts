export const PTC_TRANSPORT_NAME = "run_code";
/** One durable internal Session shared by every cold-Preset schema probe. */
export const TOOL_MANAGER_PROBE_SESSION_ID = "tool-manager-probe-internal-v1";

export type PresetPolicyMap = Record<string, PresetToolPolicy>;

export interface ToolGroupPolicy {
  /** Display name shown in the settings page. */
  name: string;
  /** Optional description of what the group is for. */
  description?: string;
  /** Exact tool names and optional `*` wildcard patterns from older configs. */
  patterns: string[];
}

export interface PresetToolPolicy {
  /** Exact tool names hidden for every session on this preset. */
  disabled: string[];
  /** Related tools bundled as one bulk enable/disable switch in the settings page. */
  groups: ToolGroupPolicy[];
}

export interface ToolManagerSettings {
  presets: PresetPolicyMap;
}

export interface ToolSchemaView {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ResolvedGroupView {
  name: string;
  description?: string;
  patterns: string[];
  tools: string[];
}

export interface PresetOrphans {
  disabled: string[];
  emptyGroups: string[];
}

export interface PresetCatalogView {
  id: string;
  name?: string;
  trust?: "system" | "user";
  isDefault: boolean;
  broken?: string;
  tools: ToolSchemaView[];
  policy: PresetToolPolicy;
  groups: ResolvedGroupView[];
  orphans: PresetOrphans;
}

export interface ToolManagerSnapshot {
  writable: boolean;
  revision: number;
  configPath: string;
  presets: PresetCatalogView[];
}
