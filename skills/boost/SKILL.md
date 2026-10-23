---
name: boost
description: >-
  Boost 深度推理：用多智能体工作流攻克硬问题（复杂 bug、竞态条件、算法难题、跨文件疑难重构、
  根因不明的问题）。当用户输入 /boost，或对某个确有难度的任务要求深度推理/多智能体攻克时使用。
  流程：方案规划与独立评审 → 并行工作流执行 → 验证关卡+修复循环 → 换人复核 → 汇总报告。
  一眼可解的小改动不要用本技能，直接做即可。
  Boost multi-agent deep reasoning engine. Solves hard bugs, race conditions, algorithm challenges,
  cross-file refactorings, and recurring issues. Workflow: solution planning & independent critique →
  parallel execution → deterministic verification & root-cause diagnosis → fresh reviewer → synthesized report.
---

# Boost — 深度多智能体推理 (Multi-Agent Deep Reasoning)

概念受公开文档化的 agent 编排工作流启发（如 Google Antigravity 的 `/boost`；机制实现主要参考开源项目 Magentic-One 与 claude-flow）。独立实现，与 Google 无关联、未获其背书；Antigravity 是 Google LLC 的商标，此处仅作概念说明。由动态工作流 `boost` 驱动。

## 启动交互协议 (Interactive Launch Protocol)

### 第 1 步：档位选择 (Profile Selection)

先调用 **ListModels** 记下当前可用模型（`[current]` 标记的是会话模型），然后弹出档位选择：

- 问题：「这个任务用哪个编队档位？」（header：`编队档位`）
- 选项：
  1. **hybrid 混流（推荐）** — 强模型规划者拆任务时给每条工作流打难度分层：机械/文档/样板类分给轻量模型，核心逻辑用强模型；把关角色全程强模型。
  2. **quality 全强** — 所有角色都用强模型。质量上限最高，适合核心算法与安全敏感任务。
  3. **economy 省钱** — 全部执行工作流下沉轻量模型，验收/复核仍用强模型兜底。

同时确认 `task`、`verifyCommand`（如 `npm test`）、`context`。

### 第 2 步：模型搭配选择 (Model Tier Selection)

- **quality** 档：使用会话模型或用户指定的强模型。
- **hybrid / economy** 档：
  - **强模型**：把关与核心逻辑角色使用。默认继承当前会话模型。
  - **轻量模型**：执行机械工作流与报告撰写。可通过 `models.local.json` 配置本地轻量模型别名，或在参数中指定。

### 第 3 步：启动工作流 (Workflow Execution)

调用 `CreateWorkflow`：
```json
{
  "saved": {
    "name": "boost",
    "args": {
      "task": "...",
      "teamProfile": "hybrid",
      "lightModel": "",
      "verifyCommand": "npm test"
    }
  }
}
```

## 工作流内部机制 (Architecture & Gate Mechanics)

- **顶尖专家四问规划**：规划者在拆解每条工作流前，自问四个关键问题（未要求的防御措施、原始证据材料、具体工具、独立判定标准），并在理解中提议激进验收线。
- **方案独立评审**：苛刻评审员亲自阅读工作区源码，质疑任务前提中未经验证的因果判断。
- **并行执行与容错**：`Promise.allSettled` 并行推进；执行异常自动升级强模型重试一次。
- **确定性验证关卡**：优先运行 `verifyCommand`；最多 3 次验证、2 轮定向修复。输出自动截取尾部 2000 字符。
- **停滞检测与根因诊断**：连续两次失败特征相同时（命令哈希相同或 LLM 缺口第 2 轮起），自动调用根因诊断员，给出最小修复路径后再修复。
- **换人独立复核**：由未参与实现的独立复核员阅读代码与 diff，真实严重问题标注 high 级并直接体现于最终结论。

## Credits

- Architecture influenced by Microsoft Magentic-One (outer-loop stall adaptation and ledger).
- Workflow and role patterns inspired by claude-flow and Felix Rieseberg's developer workflows.
- Antigravity is a trademark of Google LLC. This open-source implementation is completely independent.
