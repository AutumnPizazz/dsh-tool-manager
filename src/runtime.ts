import type {
  AgentLike,
  AgentPresetsLike,
  ContextLike,
  ToolRuntimeLike,
  ToolSchemaLike,
} from "./dsh.js";
import {
  denyNames,
  parseKnownRestrictable,
  policyFor,
  sameNames,
} from "./policy.js";
import {
  TOOL_MANAGER_PROBE_SESSION_ID,
  type PresetToolPolicy,
  type ToolManagerSettings,
} from "./types.js";

interface AgentState {
  readonly agent: AgentLike;
  baseline: string[];
  baselineSchemas: ToolSchemaLike[];
  restriction?: () => void;
  guard?: () => void;
  assemblyFilter?: () => void;
}

/**
 * Applies the stored per-Preset policy to every live Agent.
 *
 * The policy has exactly one effect on the model: tools listed as disabled
 * disappear from the Agent's tool set (registry restriction plus a prompt
 * assembly filter). Groups are a settings-page convenience — they exist so a
 * human can enable or disable a bundle of tools in one click — and never
 * change what the model sees.
 */
export class ToolPolicyRuntime {
  private settings: ToolManagerSettings;
  private readonly states = new Map<AgentLike, AgentState>();
  private readonly observedSchemas = new Map<string, Map<string, ToolSchemaLike>>();
  private mutating = false;
  private refreshQueued = false;

  constructor(
    private readonly ctx: ContextLike,
    private readonly presets: AgentPresetsLike,
    initial: ToolManagerSettings,
  ) {
    this.settings = initial;
  }

  start(): void {
    const agents = this.ctx.get<{ list(): AgentLike[] }>("agents");
    for (const agent of agents?.list() ?? []) this.install(agent);

    this.ctx.on("agent/created", (...args: unknown[]) => {
      const payload = asCreated(args[0]);
      if (payload) this.install(payload.agent);
    });
    this.ctx.on("agent/disposed", (...args: unknown[]) => {
      const payload = asCreated(args[0]);
      if (payload) this.uninstall(payload.agent);
    });
    this.ctx.on("tools/change", () => this.queueBaselineRefresh());
  }

  update(next: ToolManagerSettings): void {
    this.settings = next;
    for (const state of this.states.values()) this.reconcile(state);
  }

  private install(agent: AgentLike): void {
    if (this.states.has(agent)) return;
    if (!agent.ctx.get("tools")) return;

    const baselineSchemas = this.inheritedSchemas(agent);
    const state: AgentState = {
      agent,
      baseline: baselineSchemas.map((schema) => schema.name),
      baselineSchemas,
    };
    this.states.set(agent, state);
    this.observe(state);
    this.installLocalPolicy(state);
    this.reconcile(state);
  }

  private uninstall(agent: AgentLike): void {
    const state = this.states.get(agent);
    if (!state) return;
    this.states.delete(agent);
    this.mutating = true;
    try {
      state.restriction?.();
      state.guard?.();
      state.assemblyFilter?.();
    } finally {
      this.mutating = false;
    }
  }

  private presetId(agent: AgentLike): string | undefined {
    return this.presets.composedPreset(agent.ctx);
  }

  private policy(agent: AgentLike): PresetToolPolicy {
    return policyFor(this.settings, this.presetId(agent));
  }

  private inheritedSchemas(agent: AgentLike): ToolSchemaLike[] {
    const scopedTools = agent.ctx.get<ToolRuntimeLike>("tools");
    if (!scopedTools) return [];
    return scopedTools.schemas(agent);
  }

  private observe(state: AgentState): void {
    const presetId = this.presetId(state.agent);
    if (!presetId || state.agent.id === TOOL_MANAGER_PROBE_SESSION_ID) return;
    this.observeSchemas(presetId, state.baselineSchemas);
  }

  observeSchemas(presetId: string, schemasToAdd: readonly ToolSchemaLike[]): void {
    let schemas = this.observedSchemas.get(presetId);
    if (!schemas) {
      schemas = new Map();
      this.observedSchemas.set(presetId, schemas);
    }
    for (const schema of schemasToAdd) schemas.set(schema.name, schema);
  }

  observedSchemasFor(presetId: string): ToolSchemaLike[] {
    return [...(this.observedSchemas.get(presetId)?.values() ?? [])];
  }

  private installLocalPolicy(state: AgentState): void {
    const scopedTools = state.agent.ctx.get<ToolRuntimeLike>("tools");
    state.guard = scopedTools?.guard?.((execution) => {
      const policy = this.policy(state.agent);
      const hidden = denyNames(policy, state.baseline);
      if (!hidden.includes(execution.name)) return undefined;
      if (policy.disabled.includes(execution.name)) {
        return `tool ${JSON.stringify(execution.name)} is disabled by the tool-manager policy for this Agent preset`;
      }
      return `tool ${JSON.stringify(execution.name)} is unavailable under the tool-manager policy for this Agent preset`;
    });
    state.assemblyFilter = state.agent.ctx.on("system-prompt/assemble", async (...args: unknown[]) => {
      const next = args.at(-1);
      if (typeof next !== "function") return args[0];
      const assembly = await (next as () => Promise<unknown>)();
      if (!isPromptAssembly(assembly)) return assembly;
      const hidden = new Set(denyNames(this.policy(state.agent), state.baseline));
      if (hidden.size === 0) return assembly;
      return {
        ...assembly,
        tools: assembly.tools.filter((schema) => !hidden.has(schema.name)),
        sections: assembly.sections.filter((section) => {
          const toolName = section.name.startsWith("tool:") ? section.name.slice("tool:".length) : undefined;
          return toolName === undefined || !hidden.has(toolName);
        }),
      };
    }) as (() => void) | undefined;
  }

  private queueBaselineRefresh(): void {
    if (this.mutating || this.refreshQueued) return;
    this.refreshQueued = true;
    // Tool registry changes can be emitted before asynchronous scoped plugin
    // disposal/installation has settled (notably model-selectable subagent
    // tools during Preset recomposition). Refresh on the next event-loop turn
    // so the baseline is never snapshotted from that transient gap.
    setImmediate(() => {
      this.refreshQueued = false;
      this.refreshAllBaselines();
    });
  }

  private refreshAllBaselines(): void {
    this.mutating = true;
    try {
      for (const state of this.states.values()) {
        state.restriction?.();
        state.restriction = undefined;
        const nextSchemas = this.inheritedSchemas(state.agent);
        const next = nextSchemas.map((schema) => schema.name);
        state.baselineSchemas = nextSchemas;
        if (!sameNames(state.baseline, next)) state.baseline = next;
        this.observe(state);
      }
    } finally {
      this.mutating = false;
    }
    for (const state of this.states.values()) this.reconcile(state);
  }

  private reconcile(state: AgentState): void {
    const deny = denyNames(this.policy(state.agent), state.baseline);
    this.mutating = true;
    try {
      state.restriction?.();
      state.restriction = undefined;
      if (deny.length === 0) return;
      state.restriction = this.applyDeny(state.agent, deny);
    } finally {
      this.mutating = false;
    }
  }

  private applyDeny(agent: AgentLike, deny: string[]): (() => void) | undefined {
    const scopedTools = agent.ctx.get<ToolRuntimeLike>("tools");
    if (!scopedTools) return undefined;
    try {
      return scopedTools.restrict({ deny });
    } catch (error) {
      const known = parseKnownRestrictable(error);
      if (!known) {
        this.warn(`tool-manager restrict failed: ${errorMessage(error)}`);
        return undefined;
      }
      const next = deny.filter((name) => known.has(name));
      if (next.length === 0) return undefined;
      try {
        return scopedTools.restrict({ deny: next });
      } catch (retryError) {
        this.warn(`tool-manager restrict retry failed: ${errorMessage(retryError)}`);
        return undefined;
      }
    }
  }

  private warn(message: string): void {
    const logger = this.ctx.get<{ warn?(format: unknown, ...rest: unknown[]): void }>("logger");
    logger?.warn?.(message);
  }

  async dispose(): Promise<void> {
    for (const agent of [...this.states.keys()]) this.uninstall(agent);
  }
}

function asCreated(value: unknown): { agent: AgentLike } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const agent = (value as { agent?: AgentLike }).agent;
  if (!agent || typeof agent !== "object" || !("ctx" in agent)) return undefined;
  return { agent };
}

function isPromptAssembly(value: unknown): value is {
  tools: ToolSchemaLike[];
  sections: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
} {
  if (value === null || typeof value !== "object") return false;
  const record = value as { tools?: unknown; sections?: unknown };
  return Array.isArray(record.tools) && Array.isArray(record.sections);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
