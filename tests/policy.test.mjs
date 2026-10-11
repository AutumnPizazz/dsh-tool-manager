import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  denyNames,
  groupPolicyIssues,
  hiddenTools,
  matchesPattern,
  normalizeGroupName,
  normalizeSettings,
  parseKnownRestrictable,
  policyOrphans,
  resolveGroups,
} from "../dist/policy.js";

describe("tool-manager policy", () => {
  it("normalizes malformed settings conservatively", () => {
    assert.deepEqual(normalizeSettings({
      defaultTtlSteps: 3,
      presets: {
        standard: {
          disabled: ["web_fetch", "web_fetch", 42],
          groups: [
            { id: "MCP", label: "GitHub tools", patterns: ["mcp__*"], ttlSteps: 4 },
            { id: "mcp", patterns: ["ignored"] },
            { name: "empty", patterns: [] },
          ],
        },
      },
    }), {
      presets: {
        standard: {
          disabled: ["web_fetch"],
          groups: [
            { name: "MCP", description: "GitHub tools", patterns: ["mcp__*"] },
            { name: "empty", patterns: [] },
          ],
        },
      },
    });
  });

  it("matches exact names and wildcard groups", () => {
    assert.equal(matchesPattern("mcp__github__issue", "mcp__*"), true);
    assert.equal(matchesPattern("read", "read"), true);
    assert.equal(matchesPattern("grep", "read"), false);
    assert.equal(matchesPattern("web_fetch", "web_*"), true);
    assert.equal(matchesPattern("web-fetch", "web_*"), false);
  });

  it("resolves group membership without hiding grouped tools", () => {
    const policy = {
      disabled: ["web_fetch"],
      groups: [{ name: "mcp", patterns: ["mcp__*"] }],
    };
    const names = ["read", "web_fetch", "mcp__git__status", "mcp__db__query"];
    assert.deepEqual(resolveGroups(policy, names)[0]?.tools, [
      "mcp__git__status",
      "mcp__db__query",
    ]);
    // 分组只是人类的批量开关：只有显式弃用的工具才会对模型隐藏。
    assert.deepEqual([...hiddenTools(policy, names)], ["web_fetch"]);
  });

  it("denies only the explicitly disabled names, whatever the groups say", () => {
    const policy = {
      disabled: ["mcp__git__status"],
      groups: [{ name: "mcp", patterns: ["mcp__*"] }],
    };
    const names = ["read", "web_fetch", "mcp__git__status", "mcp__db__query"];
    assert.deepEqual(denyNames(policy, names), ["mcp__git__status"]);
    assert.deepEqual(denyNames({ disabled: [], groups: [{ name: "mcp", patterns: ["mcp__*"] }] }, names), []);
  });

  it("never denies the PTC transport even if a policy names it", () => {
    const policy = {
      disabled: ["run_code", "read"],
      groups: [{ name: "all", patterns: ["*"] }],
    };
    assert.deepEqual(denyNames(policy, ["read", "run_code", "write"]), ["read"]);
  });

  it("keeps empty groups visible as invalid configuration", () => {
    const policy = {
      disabled: ["gone", "read"],
      groups: [{ name: "mcp", patterns: [] }],
    };
    assert.deepEqual(policyOrphans(policy, ["read", "write"]), {
      disabled: ["gone"],
      emptyGroups: ["mcp"],
    });
  });

  it("resolves every non-empty group and reports policy conflicts", () => {
    const policy = {
      disabled: ["web_fetch"],
      groups: [
        { name: "Web", patterns: ["web_*"] },
        { name: "Search", patterns: ["web_search"] },
        { name: "Fetch", patterns: ["web_fetch"] },
      ],
    };
    assert.deepEqual(resolveGroups(policy, ["web_search", "web_fetch"])
      .map((group) => ({ name: group.name, tools: group.tools })), [
      { name: "Web", tools: ["web_search", "web_fetch"] },
      { name: "Search", tools: ["web_search"] },
      { name: "Fetch", tools: ["web_fetch"] },
    ]);
    assert.deepEqual(groupPolicyIssues(policy, ["web_search", "web_fetch"]), {
      emptyGroups: [],
      disabledMembers: [{ tool: "web_fetch", groups: ["Web"] }],
      duplicateMembers: [
        { tool: "web_search", groups: ["Web", "Search"] },
        { tool: "web_fetch", groups: ["Web", "Fetch"] },
      ],
    });
  });

  it("treats a fully disabled group as a legal whole-group off switch", () => {
    const offPolicy = {
      disabled: ["web_search", "web_fetch"],
      groups: [{ name: "Web", patterns: ["web_*"] }],
    };
    assert.deepEqual(groupPolicyIssues(offPolicy, ["web_search", "web_fetch"]), {
      emptyGroups: [],
      disabledMembers: [],
      duplicateMembers: [],
    });
    assert.deepEqual(policyOrphans(offPolicy, ["web_search", "web_fetch"]).emptyGroups, []);
    // 组内只剩一个工具被关闭时仍然是非法配置（整体启用或整体关闭）
    const partialPolicy = {
      disabled: ["web_fetch"],
      groups: [{ name: "Web", patterns: ["web_*"] }],
    };
    assert.deepEqual(groupPolicyIssues(partialPolicy, ["web_search", "web_fetch"]).disabledMembers, [
      { tool: "web_fetch", groups: ["Web"] },
    ]);
  });

  it("normalizes group names without truncating or ascii-slugifying", () => {
    const longName = `搜索工具${"长".repeat(200)}`;
    assert.equal(normalizeGroupName(" GitHub MCP "), "GitHub MCP");
    assert.equal(normalizeGroupName("搜索工具"), "搜索工具");
    assert.equal(normalizeGroupName(`  ${longName}  `), longName);
  });

  it("parses restrict() unknown-name diagnostics", () => {
    const error = new Error('tools.restrict() names unknown global tool "gone"; known global tools: read, write');
    assert.deepEqual([...(parseKnownRestrictable(error) ?? [])], ["read", "write"]);
    assert.equal(parseKnownRestrictable(new Error("boom")), undefined);
  });
});
