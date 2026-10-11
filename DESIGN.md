# DSH Tool Manager 可行性研究与架构设计

> **状态（当前分支）：按需（on-demand）曝光链路已整体移除。** 第 2.3 / 2.4 / 3.2 / 3.3 节与路线图中所有 `tool_list`、按需组曝光、会话曝光恢复的内容记录的是 1.x 的设计与实测结论，仅作历史与 DSH 事实参考。当前语义：**分组只是人类的一键批量启停开关，永不改变模型可见面**；只有「弃用」（写进该 Preset 的 `disabled`）才会让工具从 schema、lookup 与 dispatch 同时消失。插件现在注册 0 个模型工具，只在 Agent scope 应用 `restrict({ deny })` 与 `system-prompt/assemble` 过滤，不再有 `tool_list`、目录消息、会话曝光历史与 `agent/pre-step` 钩子。

## 1. 结论

**可以实现，而且 DSH 现有工具 registry 已提供关键基础能力。**

需求应拆为两个层次：

1. **能力治理 / 上下文治理（本插件可完成）**
   - 某工具是否出现在模型请求的 tool schemas 中；
   - 某工具是否能被该 Agent dispatch；
   - 一组工具能否被一键批量启用或弃用（只影响 schema、lookup 与 dispatch，不引入任何 AI 侧发现机制）。
2. **资源生命周期治理（不能仅靠 registry filter 完成）**
   - MCP server 子进程/HTTP connection 是否启动；
   - 某个 Cordis 插件 row 是否装载；
   - 插件提供的非 Tool service 是否常驻。

`tools.restrict()` 解决第一层，且会统一作用于 schema、lookup 和 execution。第二层若也需要，需要新增可写 Preset composition authoring API，或把 MCP 客户端升级为 lazy connection/provider；不应通过绕过 Loader 的方式硬停插件。

## 2. 已验证的 DSH 事实

### 2.1 工具统一汇入 `ctx.tools`

原生插件、第三方插件和 MCP bridge 都调用 `ctx.tools.register()`。MCP 的公开名稳定为：

```text
mcp__<serverName>__<rawToolName>
```

因此策略层无需关心来源类型，只需按工具名与 schema 工作。

### 2.2 Agent scope 支持可逆限制

`ToolRuntime.restrict({ allow?, deny? })`：

- 只能在 scoped context（如 `agent.ctx`）调用；
- 限制 inherited tools；
- 多个 restriction 求交；
- 被隐藏工具从 `schemas()`、`get()` 和 dispatch 同时消失；
- disposer 被调用后完整恢复；
- restriction 改变会发出 `tools/change`。

本次研究用动态 Cordis probe 实测：选择一个当前可见工具，施加 `deny` 后 `schemas(agent)` 中立刻消失，dispose 后立刻恢复。

### 2.3（历史）每个模型 step 都重新组装工具目录

> 已移除：本节关于 `tool_list` 与按需曝光的结论不再适用；以下描述的是 DSH 的 assemble 时机事实，仍然成立。

Agent loop 在 `preStep()` 中**先** `systemPrompt.assemble()`，**再**跑 `agent/pre-step` waterfall。因此：

- （已移除）`tool_list` 在 step N 执行并修改 restriction 后，step N+1 的 assemble 可以看到新 schema；
- （已移除）组一旦打开就保持到当前 Agent 结束或策略把该组删掉，不再按模型步数收回。

### 2.4 Preset 是 standing scope，不是每 Session 一套插件实例

一个 Preset composition 被 standing mount 一次，多个 Agent 通过 scope parent 加入。因此：

- **静态 preset 规则**可以放在 standing scope；
- **按 Agent 的策略**必须应用在 Agent 自己的 scope；
- （已移除）`tool_list` 曾注册在 host 全局层（否则 PTC 生成 SDK 看不到），每个 live Agent 只维护该会话的打开状态；
- （已移除）Agent 安装时曾从该 Session 的持久事件日志恢复成功的 `tool_list` 调用（原生走 `tool/call` + `tool/result`，PTC 走 `tool/ptc-dispatch`；fork 跳过 `inheritedEventCount` 前缀）。

### 2.5 Preset inventory 已有只读基础，但没有写 API

`agentPresets.compositionInventory()` 可给出每个 Preset 的插件 rows；内置 WebUI 的插件清单也明确只读。`agentPresets.copy()` 是唯一官方 authoring write，当前没有任意写回 composition 的公开 API。

工具开关保存在 `$DSH_HOME/tool-manager.json`（可由 `DSH_TOOL_MANAGER_CONFIG` 覆盖）的独立配置文件中，而不是修改 shipped preset、DSH Settings 或直接操作 Loader entry。

设置页为了列出每个 Preset 的实际 schema，会对未 broken 的 Preset 调用 `acquireScope()`。这会租用 standing mount（与开一个该 Preset 的会话相同）并在读完 schema 后释放租约，但不会改写 composition 文件。

## 3. 推荐架构

```text
                        ┌──────────────────────────┐
Web Settings page ─────▶│ tool-manager.json        │
                        │ presets[presetId] policy │
                        └────────────┬─────────────┘
                                     │ save/update
                                     ▼
┌──────────────────┐       ┌────────────────────────┐
│ Agent Preset      │──────▶│ Host Policy Runtime    │
│ standing scope    │       │ one state per Agent    │
└────────┬─────────┘       └───────┬───────────────┘
         │ inherited tools          │ agent.ctx.tools.restrict()
         ▼                          │ (插件不再注册模型工具)
┌──────────────────┐                ▼
│ ToolRuntime       │◀──────── per-step visibility
│ native/plugin/MCP │
└──────────────────┘
```

### 3.1 数据模型

```ts
interface ToolManagerSettings {
  presets: Record<string, {
    disabled: string[]
    groups: Array<{
      name: string
      description?: string
      patterns: string[] // exact names from the settings UI; older `*` wildcards still match
    }>
  }>
}
```

### 3.2 优先级

从高到低：

1. DSH 其他安全 restriction / guard；
2. 本插件 `disabled`（分组只是对这一项的批量写入）；
3. 原始 Preset 工具目录。

显式 `disabled` 是唯一的隐藏手段。PTC 的 `run_code` 永远不会进入 deny 集合（传输层保留名）。插件不再注册任何模型工具，因此也没有需要 deny 掉的发现工具。

### 3.3（已移除）1.x 的 `tool_list` 语义

（以下为 1.x 的历史实现，已随按需链路整体删除）`tool_list({ group })` 按名称打开该组并保持到 Agent 结束；每个 Agent 独立、不跨会话共享；注册在 host 全局层以便 PTC 生成 SDK 绑定；目录通过 `agent/pre-step` 写入一条持久 user 角色的 `<system-reminder>`；空组或仅含关闭成员的组不进入目录；旧 wildcard 配置在编辑时投影为当前实际成员的精确工具名，运行时对遗留重叠配置按组顺序 first-match。

仍然成立的约定：

- 工具状态互斥：一个工具要么独立启用/弃用，要么属于一个分组。WebUI 不提供属于其他分组的工具；Host 保存接口拒绝跨组重复；
- 整组成员全部弃用是合法的整体关闭状态，不再被报成“已关闭工具入组”；匹配不到任何工具的组仍是空组错误；
- 保存校验与设置页必须读**同一份**工具目录：standing composition 与 Agent 作用域注册（探针 + 运行中 Agent 观测）的并集。只读 standing 会把 `@deepseek-ai/dsh-schedule` 注入每个 root Agent 的 `schedule_*`、以及 `modelSelectionSettings` 注入的 `subagent` 判成不存在，从而拒绝一个页面能列出、运行时也能正常打开的组。只有真正读不到 standing composition 时才跳过该校验。

## 4. 关键实现陷阱

### 4.1 不要只过滤 prompt schema

只在 `system-prompt/assemble` 删除 `assembly.tools` 并不等于权限控制：历史/恶意模型仍可能猜工具名直接调用。必须使用 `tools.restrict()` 或 guard，让 lookup 和 dispatch 同步拒绝。

### 4.2 不要用一个代理工具执行所有隐藏工具

可以设计 `tool_call({name,args})` 代理，但它会：

- 绕过原工具 schema 的模型侧参数约束；
- 让权限、审批、调用卡片和 telemetry 都聚合到代理名；
- 使历史中的工具身份不稳定；
- 增加手工 dispatch 复杂度。

“先发现，再让原工具 schema 在下一 step 出现”更符合 DSH 的原生 registry 设计。

### 4.3 `restrict()` 只接受已知 inherited tool 名

它会拒绝 unknown、scope-local 和 reserved transport 名。实现必须：

- 在 Agent 安装时 snapshot inherited baseline（排除传输层保留名 `run_code`），再构造 deny；
- 只对 baseline 中真实存在的名字构造 deny；
- 监听 `tools/change`：先暂时卸下 restriction 再重读 baseline，避免把已隐藏的工具当成“已消失”；刷新期间抑制重入，防止自己的 restrict/register 再次触发刷新；
- 若仍撞上 unknown-name 错误，从诊断文本解析 `known global tools` 后重试交集。

### 4.4 PTC 模式需单独定义产品语义

PTC 模式模型表面只见 `run_code`，但生成 SDK 仍包含所有可见 end-capability tools。restriction 仍有效，也会缩小 SDK。（已移除）1.x 曾把 `tool_list` 注册在 host/global 层，以便进入 PTC 的继承面并成为 SDK binding；当前插件不注册任何模型工具，PTC 会话看到的 SDK 就是继承面里未被 `disabled` 的那些工具。

### 4.5 Prompt guidance 可能残留

DSH 内置文件/Web 等工具 guidance 会通过 `ctx.tools.get(name, scope)` 判断可见性，所以 restriction 后说明会消失。第三方插件若无条件注册 guidance，schema 虽隐藏但文字可能仍占上下文；平台层可未来引入“tool-owned guidance metadata”，或要求第三方遵循条件渲染约定。

（已移除，仅作历史记录）极简模式 persona 配了 `complete: true`：`assemble()` 的 waterfall 仍会跑，但随后把 complete 段恢复成唯一系统提示，其它 `systemPrompt.section` 全部丢掉。本插件因此不往系统提示里写组名单，而是对齐 `dsh-tool-skill`：在 `agent/pre-step` 追加一条 `source.kind = tool-manager-catalog` 的持久 user 消息。每条 entry 保存组名、描述和实际工具名；digest 也覆盖这三项，因此成员变化会触发替换目录。可见目录未变则不重发；有效组被删光或变空且曾经发过则追加清空目录。`tool_list` 是全局一份 schema，description 不带组名；当前会话可用的组名和成员只出现在这条 catalog 里。旧消息缺少工具名字段时按空列表读取，以兼容升级前会话历史。

## 5. WebUI 与持久化选择

当前实现：

- `settings.section` 新增「工具管理」页面；
- Host 使用独立的 `$DSH_HOME/tool-manager.json`，也可由 `DSH_TOOL_MANAGER_CONFIG` 指定路径；
- 同源 HTTP endpoint 提供 snapshot/save；
- 保存携带文件存储 revision，拒绝 stale write，并以临时文件原子替换；
- WebUI 不直接编辑 `agent.cordis.yml`，因此绝不会损坏 shipped preset；
- 设置页支持搜索、启用/弃用筛选、整组开关、拖拽排序（分组 + 组内）、记住上次 Preset，以及 orphan disable 清理。

生产版仍可：

- 给包生成 Typert Host/Remote artifacts，并让 client contribution 通过 `ctx.remote.toolManager` 调用；
- 增加 settings change / tools change 的事件订阅，替代手动刷新；
- 显示来源（插件 row、MCP server）需要 registry 增加 registration metadata，因为当前 `ToolDefinition` 没有标准 owner/source 字段。

## 6. “关闭插件/MCP 进程”扩展路线

若用户真正目标还包括减少资源常驻，建议分阶段：

### A. Preset row authoring（静态，推荐）

新增受保护的 Host API：

1. 只允许修改 `trust: user` 的 Preset；
2. shipped preset 必须先 `agentPresets.copy()`；
3. 用 Loader YAML AST/官方 authoring helper 修改 row 的 `disabled`；
4. 原子写入、mount validate；
5. 修改只影响之后建立/加入新 standing generation 的 Session；已有会话不热切换 composition。

这适合永久关闭某类 tool plugin 或整个 MCP client row。

### B. Lazy MCP（资源级按需）

让 MCP bridge 分成：

- 轻量目录：缓存/声明服务器与工具元数据；
- 第一次曝光或调用时建立 transport；
- idle timeout 后断开；
- schema identity 保持稳定。

这需要修改 MCP client 本身；仅在上层过滤 schema 无法停止其连接 supervisor。

## 7. MVP 验收标准

- WebUI 能列出所有 Preset 及各自实际工具 schema；
- 关闭工具后，live Agent 下一 step 不再看到也不能调用它；
- （已移除）1.x 的按需组曝光与 `tool_list` 目录；
- 打开仅影响当前 Agent，该会话内一直可用；
- MCP 工具可用 `mcp__server__*` 分组；
- settings 在重启后保留；
- shipped preset 文件从不被修改。

## 8. 当前实现已补强 / 仍待生产化

已补强：

1. 监听 `tools/change`，MCP 动态 tools/list 或插件 HMR 后刷新每个 Agent baseline；
2. 设置页提示并一键清除 orphan disable；旧配置中的空组在草稿中标记为无效，必须补选工具或删除后才能保存；
3. （已移除）`tool_list` 的 `query` 与 preview 截断列表；
4. 打开后的组在当前会话一直可用，重启恢复同一 Session 时从成功的原生/PTC 工具事件重建；fork 不继承父 Session 的开放状态；策略更新不取消正在执行的工具；
5. 自动命名和自动分组在执行前显示确认框，并允许配置 5–600 秒请求超时（默认 60/120 秒）；Host 校验范围，超时及供应商中止会返回明确错误。

仍待：

1. Typert Remote 替换 HTTP API，并订阅 settings/tools 变化；
2. E2E：真实 Agent 两个连续 step、两个并行 Session、PTC preset、MCP 重连；
3. WebUI 国际化、可访问性和大目录虚拟列表；
4. 工具来源（插件 row / MCP server）元数据，需 registry 先提供 owner 字段。
