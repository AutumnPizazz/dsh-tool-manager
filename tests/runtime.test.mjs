import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolPolicyRuntime } from "../dist/runtime.js";
import { TOOL_MANAGER_PROBE_SESSION_ID } from "../dist/types.js";

function sessionStub() {
  return {
    seq: 0,
    inheritedEventCount: 0,
    eventAt() {
      return undefined;
    },
    surface: { nodes: [] },
  };
}

describe("ToolPolicyRuntime restart recovery", () => {
  it("records tools that only exist in a live Agent scope", async () => {
    const scopedSchemas = ["read", "subagent"].map((name) => ({ name, description: name, parameters: {} }));
    const standingSchemas = [{ name: "read", description: "read", parameters: {} }];
    const scopedTools = {
      schemas() { return scopedSchemas; },
      register() { throw new Error("scope register should not be used"); },
      restrict() { return () => {}; },
    };
    const agent = {
      ctx: { get(name) { return name === "tools" ? scopedTools : undefined; }, on() {} },
      session: sessionStub(),
    };
    const context = {
      get(name) {
        if (name === "tools") return {
          schemas() { return standingSchemas; },
          register() { return () => {}; },
          restrict() { throw new Error("host restrict should not be used"); },
        };
        if (name === "agents") return { list: () => [agent] };
        return undefined;
      },
      on() {},
    };
    const presets = { composedPreset: () => "standard" };

    const runtime = new ToolPolicyRuntime(context, presets, { presets: {} });
    runtime.start();

    assert.deepEqual(runtime.observedSchemasFor("standard").map((item) => item.name), ["read", "subagent"]);
    await runtime.dispose();
  });

  it("does not cache transient schemas observed on the shared probe Agent", async () => {
    const scopedSchemas = ["pwsh", "subagent", "list_subagent_models"].map((name) => ({
      name,
      description: name,
      parameters: {},
    }));
    const probeAgent = {
      id: TOOL_MANAGER_PROBE_SESSION_ID,
      ctx: {
        get(name) {
          return name === "tools" ? {
            schemas() { return scopedSchemas; },
            register() { throw new Error("scope register should not be used"); },
            restrict() { return () => {}; },
          } : undefined;
        },
        on() {},
      },
      session: sessionStub(),
    };
    const context = {
      get(name) {
        if (name === "tools") return { schemas() { return []; }, register() { return () => {}; } };
        if (name === "agents") return { list: () => [probeAgent] };
        return undefined;
      },
      on() {},
    };
    const presets = { composedPreset: () => "minimal" };
    const runtime = new ToolPolicyRuntime(context, presets, { presets: {} });

    runtime.start();

    assert.deepEqual(runtime.observedSchemasFor("minimal"), []);
    await runtime.dispose();
  });

  it("filters and guards tools registered in the Agent's own scope", async () => {
    const schemas = ["read", "subagent"].map((name) => ({ name, description: name, parameters: {} }));
    let guard;
    let assemble;
    const scopedTools = {
      schemas() { return schemas; },
      register() { throw new Error("scope register should not be used"); },
      restrict() { throw new Error('tool "subagent" is scoped, not globally restrictable; known global tools: read'); },
      guard(callback) { guard = callback; return () => {}; },
    };
    const agent = {
      ctx: {
        get(name) { return name === "tools" ? scopedTools : undefined; },
        on(name, handler) { if (name === "system-prompt/assemble") assemble = handler; return () => {}; },
      },
      session: sessionStub(),
    };
    const context = {
      get(name) {
        if (name === "tools") return { schemas() { return schemas; }, register() { return () => {}; } };
        if (name === "agents") return { list: () => [agent] };
        return undefined;
      },
      on() {},
    };
    const presets = { composedPreset: () => "standard" };
    const runtime = new ToolPolicyRuntime(context, presets, {
      presets: { standard: { disabled: ["subagent"], groups: [] } },
    });
    runtime.start();

    const filtered = await assemble({}, {}, async () => ({
      tools: schemas,
      sections: [{ name: "tool:read" }, { name: "tool:subagent" }, { name: "identity" }],
      contexts: [],
      variables: {},
    }));
    assert.deepEqual(filtered.tools.map((item) => item.name), ["read"]);
    assert.deepEqual(filtered.sections.map((item) => item.name), ["tool:read", "identity"]);
    assert.match(guard({ name: "subagent" }), /disabled by the tool-manager policy/);
    assert.equal(guard({ name: "read" }), undefined);
    await runtime.dispose();
  });

  it("guards only explicitly disabled tools and registers no discovery tool", async () => {
    const schemas = ["plugin_manager", "subagent"].map((name) => ({
      name,
      description: name,
      parameters: {},
    }));
    let guard;
    let registered;
    const scopedTools = {
      schemas() { return schemas; },
      register() { throw new Error("scope register should not be used"); },
      restrict() { return () => {}; },
      guard(callback) { guard = callback; return () => {}; },
    };
    const agent = {
      ctx: {
        get(name) { return name === "tools" ? scopedTools : undefined; },
        on() { return () => {}; },
      },
      session: sessionStub(),
    };
    const context = {
      get(name) {
        if (name === "tools") return {
          schemas() { return schemas; },
          register(definition) { registered = definition; return () => {}; },
        };
        if (name === "agents") return { list: () => [agent] };
        return undefined;
      },
      on() {},
    };
    const presets = { composedPreset: () => "cordis" };
    const runtime = new ToolPolicyRuntime(context, presets, {
      presets: {
        cordis: {
          disabled: ["subagent"],
          groups: [{
            name: "Cordis插件管理",
            patterns: ["plugin_manager", "subagent"],
          }],
        },
      },
    });
    runtime.start();

    // 插件不再注册任何模型工具（曾经是 tool_list）。
    assert.equal(registered, undefined);
    // 分组不再是屏蔽手段：组内未弃用的工具与模型可见面无差别。
    assert.equal(guard({ name: "plugin_manager" }), undefined);
    assert.match(guard({ name: "subagent" }), /disabled by the tool-manager policy/);
    await runtime.dispose();
  });

  it("keeps standard delegation policy isolated from creator sessions and restores it", async () => {
    const schemas = ["read", "list_subagent_models", "subagent"].map((name) => ({
      name,
      description: name,
      parameters: {},
    }));
    const handlers = new Map();
    const agents = [];
    function makeAgent(id, presetId) {
      let guard;
      let assemble;
      let restricted = new Set();
      const scopedTools = {
        schemas() { return schemas.filter((item) => !restricted.has(item.name)); },
        register() { throw new Error("scope register should not be used"); },
        restrict({ deny }) {
          const local = deny.filter((name) => name === "list_subagent_models" || name === "subagent");
          if (local.length) {
            throw new Error(`tool ${JSON.stringify(local[0])} is scoped, not globally restrictable; known global tools: read`);
          }
          restricted = new Set(deny);
          handlers.get("tools/change")?.();
          return () => {
            restricted = new Set();
            handlers.get("tools/change")?.();
          };
        },
        guard(callback) { guard = callback; return () => {}; },
      };
      const agent = {
        id,
        presetId,
        ctx: {
          get(name) { return name === "tools" ? scopedTools : undefined; },
          on(name, handler) {
            if (name === "system-prompt/assemble") assemble = handler;
            return () => {};
          },
        },
        session: sessionStub(),
        get guard() { return guard; },
        get assemble() { return assemble; },
      };
      agents.push(agent);
      return agent;
    }
    const standard = makeAgent("standard-agent", "standard");
    const creator = makeAgent("creator-agent", "cordis");
    const hostTools = {
      schemas() { return schemas; },
      register() { return () => {}; },
      restrict() { throw new Error("host restrict should not be used"); },
    };
    const context = {
      get(name) {
        if (name === "tools") return hostTools;
        if (name === "agents") return { list: () => agents };
        return undefined;
      },
      on(name, handler) { handlers.set(name, handler); },
    };
    const presets = { composedPreset: (ctx) => agents.find((agent) => agent.ctx === ctx)?.presetId };
    const disabledStandard = {
      presets: {
        standard: { disabled: ["list_subagent_models", "subagent"], groups: [] },
        cordis: { disabled: [], groups: [] },
      },
    };
    const enabledAgain = {
      presets: {
        standard: { disabled: [], groups: [] },
        cordis: { disabled: [], groups: [] },
      },
    };
    const assembly = () => ({
      tools: schemas,
      sections: schemas.map((item) => ({ name: `tool:${item.name}` })),
      contexts: [],
      variables: {},
    });

    const runtime = new ToolPolicyRuntime(context, presets, disabledStandard);
    runtime.start();

    const standardDisabled = await standard.assemble({}, {}, async () => assembly());
    const creatorUnaffected = await creator.assemble({}, {}, async () => assembly());
    const allNames = schemas.map((item) => item.name);
    assert.deepEqual(standardDisabled.tools.map((item) => item.name), ["read"]);
    assert.deepEqual(creatorUnaffected.tools.map((item) => item.name), allNames);
    assert.match(standard.guard({ name: "subagent" }), /disabled by the tool-manager policy/);
    assert.equal(creator.guard({ name: "subagent" }), undefined);

    runtime.update(enabledAgain);

    const standardRestored = await standard.assemble({}, {}, async () => assembly());
    const creatorStillUnaffected = await creator.assemble({}, {}, async () => assembly());
    assert.deepEqual(standardRestored.tools.map((item) => item.name), allNames);
    assert.deepEqual(creatorStillUnaffected.tools.map((item) => item.name), allNames);
    assert.equal(standard.guard({ name: "subagent" }), undefined);
    assert.equal(creator.guard({ name: "subagent" }), undefined);
    await runtime.dispose();
  });

  it("does not snapshot a transient missing scoped tool during a Preset switch", async () => {
    const schema = (name) => ({ name, description: name, parameters: {} });
    let presetId = "standard";
    let dynamicSubagent = true;
    let guard;
    const handlers = new Map([["tools/change", []]]);
    const emit = (name) => {
      for (const handler of handlers.get(name) || []) handler();
    };
    // Registered before ToolPolicyRuntime, like a standing Preset listener.
    // Recomposition can temporarily remove one Agent-scoped registration while
    // its replacement settles asynchronously without another registry edge.
    handlers.get("tools/change").push(() => {
      dynamicSubagent = false;
      setImmediate(() => { dynamicSubagent = true; });
    });
    const scopedTools = {
      schemas() {
        return [schema("read"), ...(dynamicSubagent ? [schema("subagent")] : [])];
      },
      register() { throw new Error("scope register should not be used"); },
      restrict({ deny }) {
        if (deny.includes("subagent")) {
          throw new Error('tool "subagent" is scoped, not globally restrictable; known global tools: read');
        }
        return () => {};
      },
      guard(callback) { guard = callback; return () => {}; },
    };
    const agent = {
      id: "switching-agent",
      ctx: { get(name) { return name === "tools" ? scopedTools : undefined; }, on() { return () => {}; } },
      session: sessionStub(),
    };
    const context = {
      get(name) {
        if (name === "tools") return { schemas() { return []; }, register() { return () => {}; } };
        if (name === "agents") return { list: () => [agent] };
        return undefined;
      },
      on(name, handler) {
        const list = handlers.get(name) || [];
        list.push(handler);
        handlers.set(name, list);
      },
    };
    const presets = { composedPreset: () => presetId };
    const runtime = new ToolPolicyRuntime(context, presets, { presets: {} });
    runtime.start();

    presetId = "cordis";
    emit("tools/change");
    await new Promise((resolve) => setImmediate(resolve));
    runtime.update({ presets: { cordis: { disabled: ["subagent"], groups: [] } } });

    assert.equal(dynamicSubagent, true);
    assert.match(guard({ name: "subagent" }), /disabled by the tool-manager policy/);
    await runtime.dispose();
  });

  it("applies a group-wide disable exactly like other disables", async () => {
    const applied = [];
    const schemas = ["mcp__github__issue", "web_search", "write"].map((name) => ({
      name,
      description: name,
      parameters: {},
    }));
    const scopedTools = {
      schemas() { return schemas; },
      register() { throw new Error("scope register should not be used"); },
      restrict({ deny }) {
        applied.push([...deny]);
        return () => {};
      },
    };
    const agent = {
      ctx: { get(name) { return name === "tools" ? scopedTools : undefined; }, on() {} },
      session: sessionStub(),
    };
    const handlers = new Map();
    const hostTools = {
      schemas() { return schemas; },
      register() { return () => {}; },
      restrict() { throw new Error("host restrict should not be used"); },
    };
    const context = {
      get(name) {
        if (name === "tools") return hostTools;
        if (name === "agents") return { list: () => [agent] };
        return undefined;
      },
      on(name, handler) { handlers.set(name, handler); },
    };
    const presets = { composedPreset: () => "standard" };
    const settings = {
      presets: {
        standard: {
          disabled: ["write"],
          groups: [
            { name: "GitHub", patterns: ["mcp__github__issue"] },
            { name: "Web", patterns: ["web_search"] },
          ],
        },
      },
    };

    const runtime = new ToolPolicyRuntime(context, presets, settings);
    runtime.start();

    // 分组不再对模型隐藏任何工具：只有显式弃用的 write 进入 deny。
    assert.deepEqual(applied.at(-1), ["write"]);

    // 「整组弃用」＝把该组成员逐个写进 disabled，和逐个弃用完全等价。
    runtime.update({
      presets: {
        standard: {
          disabled: ["write", "web_search", "mcp__github__issue"],
          groups: settings.presets.standard.groups,
        },
      },
    });

    assert.deepEqual(applied.at(-1), ["mcp__github__issue", "web_search", "write"]);
    await runtime.dispose();
  });
});
