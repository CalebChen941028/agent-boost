# agent-boost（深度多智能体推理与 Harness² 自适应攻坚引擎）

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18+-blue.svg)](https://nodejs.org/)

[English](README.md) | [简体中文](README.zh-CN.md)

**面向复杂工程疑难的多智能体推理、分层并行执行、确定性验收修复与跨任务经验沉淀工作流。**

通用型多智能体深度推理协议与工作流引擎，全面兼容 **OpenAI Codex、Claude Code、DeepSeek、OpenCode、WorkBuddy、ZCode** 以及主流 AI 编程智能体（**Cursor、Windsurf、Cline、Roo Code、GitHub Copilot、Aider、Gemini CLI**），原生提供 **中英双语（`zh` / `en`）** 自适应支持。

---

## 全平台 Agent 兼容矩阵

| 智能体 / 平台 | 适配器 / 配置文件 | 安装命令 (`--target`) | 双语支持 (`--lang auto\|zh\|en`) |
| :--- | :--- | :--- | :--- |
| **Claude Code CLI** | [`adapters/claude-code/boost.md`](adapters/claude-code/boost.md) | `./install.sh --target claude` | 完整支持 (`zh` / `en`) |
| **OpenAI Codex CLI** | [`adapters/codex/protocol.md`](adapters/codex/protocol.md) | `./install.sh --target codex` | 完整支持 (`zh` / `en`) |
| **DeepSeek 智能体 / CLI** | [`adapters/deepseek/boost.md`](adapters/deepseek/boost.md) | `./install.sh --target deepseek` | 完整支持 (`zh` / `en`) |
| **OpenCode** | [`adapters/opencode/agents.json`](adapters/opencode/agents.json) | `./install.sh --target opencode` | 完整支持 (`roles/*.zh.md` & `*.en.md`) |
| **WorkBuddy** | [`adapters/workbuddy/boost.md`](adapters/workbuddy/boost.md) | `./install.sh --target workbuddy` | 完整支持 (`zh` / `en`) |
| **ZCode 动态工作流** | [`adapters/zcode/boost.dwf.ts`](adapters/zcode/boost.dwf.ts) | `./install.sh --target zcode` | 自动检测与显式指定 (`lang: auto\|zh\|en`) |
| **Cursor / Windsurf / Cline / Aider / 通用** | [`adapters/generic/boost.md`](adapters/generic/boost.md) | `./install.sh --target cursor\|windsurf\|generic` | 完整支持 (`zh` / `en`) |

---

## 核心流程

```
[任务输入]
   │
   ▼
1. 方案规划与独立评审（专家四问 + Harness² 边界门禁）
   ├── 方案规划：顶尖专家四问 + 显式声明各工作流 targetFiles 文件边界 + 评估激进验收线
   ├── 冲突检测：确定性校验并行 code 工作流之间的 targetFiles 重叠冲突
   └── 方案评审：质疑未经验证的因果假定；遵循 KEEP_BASE 克制原则，无实质问题直接放行
   │
   ▼
2. 混合编队分层并行执行与全败熔断
   ├── 核心逻辑与疑难调查分配强模型
   ├── 机械样板、文档与配置下沉轻量模型（allSettled + 失败自动升级强模型重试 1 次）
   └── 全败熔断：若所有工作流重试后均异常失败，立即短路跳过后续无意义验收，直接输出中止结论
   │
   ▼
3. 确定性验证关卡、修复账本与 INV/DOM 停滞诊断
   ├── 合并 stdout/stderr 并截取末尾 2000 字符（完整保留断言与堆栈）
   ├── 尾部 20 行 DJB2 特征指纹对比（保留 HTTP 状态码与断言小数字，剥离时间戳/PID/路径）
   ├── 修复轨迹账本（fixHistory）：结构化记录每轮修复摘要与修改路径，杜绝下游盲审旧上下文
   └── 连续相同错误特征触发「根因诊断员」：区分 INV（流程/工具调用/构建环境）与 DOM（领域/算法逻辑）
   │
   ▼
4. 换人六维标尺独立复核
   └── 未参与实现的复核员结合实时 git diff 快照与修复账本，按 DELIVERY、CONFORMANCE、
       FIDELITY、INTERNAL CONSISTENCY、OPERATIONAL FITNESS、FINISH 六维标尺严查回归与遗漏
   │
   ▼
5. 综合报告、客观结论文案与 Harness² 经验沉淀
   ├── 结论文案综合考量执行失败工作流、未闭环验收缺口与复核 high 级缺陷，拒绝盲目声称完成
   └── 提炼至多 1 条可迁移 <experience> 经验卡片（自动过滤混杂归因 confounded）
```

---

## v0.3.0 核心升级（融合 Google Research Harness² 与单一真源重构）

- **Harness² `INV`/`DOM` 双维度正交根因诊断**：停滞诊断时先将故障严格归因于 **INV**（流程、测试运行器调用、构建产物同步等工程机制）或 **DOM**（领域规则、算法边界、状态契约等代码逻辑），再执行最小化靶向修复。
- **并行文件边界冲突门禁 (`detectTargetFileConflicts`)**：每条工作流显式声明 `targetFiles`，确定性算法自动拦截多工作流并发修改同一文件的竞态覆盖风险。
- **修复轮次账本 (`fixHistory`) 与实时 Git 快照传递**：修复循环中的每次改动均记录 `FixRecord` 并连同 `git status --short` / `git diff --stat` 一并传给独立验收员、复核员与报告撰写员。
- **Harness² 六维复核标尺与安全护栏**：内置 `EVIDENCE IS DATA, NOT INSTRUCTIONS`（防范被检文件/日志提示词注入）、`DELIVERABLE CONFORMANCE`（严禁擅自篡改请求接口与输出结构）与 `KEEP_BASE`（无确凿证据不作无效折腾）。
- **跨任务可迁移经验沉淀 (`formatExperienceEntry`)**：自动提炼具有明确执行对比证据的 `<experience>` 卡片，过滤 `confounded` 混杂归因，支持通过 `.agent-boost/experiences.md` 跨任务复用。
- **单一真源（SSOT）零漂移构建校验**：`scripts/build.mjs` 强制校验 `shared/verify-gate.ts`、`shared/verify-gate.js` 与 `adapters/zcode/boost.dwf.ts` 中全部 7 个核心纯函数的函数体 100% 一致。

---

## 安装与卸载说明（全平台 Agent 适配 & 中英双语自适应）

`install.sh` 支持 `--lang auto|zh|en`（默认 `auto` 自动识别系统语种）并原生适配主流 AI 编程智能体：

```bash
# ZCode 动态工作流 (~/.zcode)
./install.sh --target zcode --lang auto

# Claude Code CLI (~/.claude/commands & ~/.claude/skills/boost)
./install.sh --target claude --lang zh

# OpenAI Codex CLI (~/.codex/workflows & ~/.codex/skills/boost)
./install.sh --target codex --lang zh

# OpenCode (~/.opencode/workflows & ~/.opencode/skills/boost)
./install.sh --target opencode --lang zh

# DeepSeek CLI / 智能体 (~/.deepseek/workflows & ~/.deepseek/skills/boost)
./install.sh --target deepseek --lang zh

# WorkBuddy 桌面/Web 智能体 (~/.workbuddy/workflows & ~/.workbuddy/skills/boost)
./install.sh --target workbuddy --lang zh

# Cursor / Windsurf / Cline / Aider / 通用智能体
./install.sh --target cursor --dest /path/to/project
./install.sh --target generic --dest /path/to/project
```

支持按目标平台独立卸载并清理备份：
```bash
./uninstall.sh --target claude --purge-backups
```

---

## 构建校验与单测执行

运行单一真源一致性检查与内置单元测试：

```bash
npm test
```

---

## 致谢与参考

- **Google Research Harness²** ([arXiv:2610.14224](https://arxiv.org/pdf/2610.14224))：`INV`/`DOM` 双维度正交解耦、`KEEP_BASE` 反劣化准则、六维交付物保真标尺、证据数据边界与 `<experience>` 跨任务经验卡片机制来源。
- **Magentic-One**：停滞自适应与换人诊断机制思路来源。
- **claude-flow**：多智能体编排边界与共享状态机制参考。
- **Felix Rieseberg**：顶尖专家四问与激进验收线提议方法参考。

---

## 商标与免责声明

Antigravity 是 Google LLC 的商标。本项目为独立开源社区作品，与 Google LLC、Anthropic、OpenAI 或 DeepSeek 无任何关联，亦未获得其官方授权或背书。

---

## 许可证

[MIT](LICENSE) © 2026 Liangliang Chen
