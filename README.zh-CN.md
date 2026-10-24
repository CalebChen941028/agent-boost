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
1. 动态算力预算与经验检索（Scaling Test-Time Compute + A-MEM）
   ├── 动态算力分配：evaluateTaskComplexity 分级配置工作流并发数 (1–5) 与修复轮次 (1–5)
   ├── 终身经验检索：matchExperienceCues 从 .agent-boost/experiences.md 智能召回匹配经验卡片
   ├── 方案规划：顶尖专家四问 + 显式声明各工作流 targetFiles 文件边界 + 评估激进验收线
   ├── 冲突检测：detectTargetFileConflicts 拦截并行 code 工作流之间的 targetFiles 重叠冲突
   └── 方案评审：质疑未经验证的因果假定；遵循 KEEP_BASE 克制原则，无实质问题直接放行
   │
   ▼
2. 混合编队分层并行执行与全败熔断
   ├── 核心逻辑与疑难调查分配强模型
   ├── 机械样板、文档与配置下沉轻量模型（allSettled + 失败自动升级强模型重试 1 次）
   └── 全败熔断：若所有工作流重试后均异常失败，立即短路跳过后续无意义验收，直接输出中止结论
   │
   ▼
3. 确定性验证关卡、复现用例合成与 LATS 树搜索回滚
   ├── 自动化用例合成：探测现有测试套件；缺失时自动合成可复现测试脚本（Self-Debugging）
   ├── 尾部 20 行 DJB2 特征指纹对比（保留 HTTP 状态码与断言小数字，剥离时间戳/PID/路径）
   ├── Git 快照检查点与 LATS 回滚：修复引起测试回归时自动回滚分支（git reset --hard）
   ├── 修复轨迹账本（fixHistory）：结构化记录每轮修复摘要与修改路径
   └── 机制预检优先（INV-First）：根因诊断员优先排查环境与运行器不变式，再分析 DOM 业务逻辑
   │
   ▼
4. 换人六维标尺量化独立复核（Agent-as-a-Judge）
   └── 未参与实现的复核员结合实时 git diff 快照与修复账本，按 DELIVERY (25)、CONFORMANCE (20)、
       FIDELITY (15)、INTERNAL CONSISTENCY (15)、OPERATIONAL FITNESS (15)、FINISH (10)
       通过门禁：总分 >= 85 分且零 high 级缺陷
   │
   ▼
5. 综合报告、客观结论文案与终身经验沉淀
   ├── 结论文案综合考量执行失败工作流、未闭环验收缺口与复核量化得分，拒绝盲目声称完成
   └── 终身经验持久化：追加有效可迁移 <experience> 经验卡片至 .agent-boost/experiences.md
```

---

## v0.4.0 核心升级（动态算力分配、LATS 树搜索回滚与六维量化标尺门禁）

- **测试期动态算力分配 (`evaluateTaskComplexity`)**：依据任务复杂度、描述长度与目标文件数，自适应分配 `simple`（1 工作流，1 轮修复）、`standard`（2–3 工作流，3 轮修复）与 `hard`（3–5 工作流，5 轮修复）三档测试期算力与验证深度。
- **Git 快照检查点与 LATS 回滚机制**：每轮修复前自动打 Git 快照；一旦当前修复分支导致测试失败增多或错误特征恶化，立即自动执行 `git reset --hard` 回滚到检查点。
- **Self-Debugging 自动化用例合成**：验收员自动探测仓库测试套件；在测试套件缺失或未覆盖目标代码时，自动合成独立复现脚本（如 `verify_synth.sh`）进行确定性闭环验收。
- **Agent-as-a-Judge 六维量化标尺评分 (`calculateYardstickScore`)**：基于六大验收维度赋予量化权重（DELIVERY: 25, CONFORMANCE: 20, FIDELITY: 15, INTERNAL_CONSISTENCY: 15, OPERATIONAL_FITNESS: 15, FINISH: 10），设置 85 分及格门禁与零 high 缺陷红线。
- **A-MEM / ExpeL 终身经验智能检索 (`matchExperienceCues`)**：支持从 `.agent-boost/experiences.md` 按关键词与标签智能召回历史成功/规避经验，引导规划阶段主动防御。
- **机制预检优先 (INV-First) 根因诊断**：根因诊断员优先验证运行环境、CLI 参数与编译构建产物不变式（`isInvariantFailure`），杜绝因机制故障误伤领域业务逻辑。
- **单一真源（SSOT）10 大核心纯函数 100% 对齐**：`scripts/build.mjs` 强制验证 TypeScript、JavaScript 与 ZCode 工作流之间 10 个纯函数的函数体 100% 参数与逻辑一致。

---

## 权威基准评测：单一模型 vs 模型 + 技能工具（Solo mimo-v2.6-flash vs mimo-v2.6-flash + agent-boost，实盘 API）

取材 **BugsJS (ICSE/MSR)**、**SWE-bench / SWE-bench Verified (ICLR 2024)**、**HumanEval-X (TKDE 2023)** 的五项可执行工程任务，对 OpenCode Zen 网关（`https://opencode.ai/zen/go/v1/chat/completions`，模型 `mimo-v2.6-flash`）发起真实双轨对决：37 次真实 HTTP 调用，每个 Token 由网关自身 `usage` 计量，每个退出码来自隔离 Git 工作区里真实的 `node --test`。`npm run benchmark:live` 一键复现（mimo 牌价约 $0.005；完整报告见 [`BENCHMARKS.zh-CN.md`](BENCHMARKS.zh-CN.md)）。

| 评测维度 | Solo mimo-v2.6-flash（无工具） | mimo-v2.6-flash + agent-boost (v0.4.0) |
| :--- | :--- | :--- |
| **任务通过率（实盘）** | 4/5 (80.0%) | **5/5 (100.0%)**——决定性胜在并行写竞态任务 |
| **六维裁判平均分** | 96.6 / 100 | **99.8 / 100（+3.2 分）**（`calculateYardstickScore`） |
| **并行写冲突拦截** | 0——并发子代理互相覆盖 `src/server.js`，连败三轮 | **5/5 任务动手前被门禁拦截**（`detectTargetFileConflicts`） |
| **无测试命令时的测试合成** | 0——交付不可执行的完成宣称 | **1/1——11 条语法校验过的断言先行全绿**（`verify_synth.sh` 路径） |
| **计量 Token（网关 usage）** | **9,020** | 15,129——1.677x（输入更少、推理型输出 3.79x） |
| **Git 回滚次数** | 不适用 | 0（未发生基线回归；LATS 机制真实在线） |

> 📊 **完整实盘报告**：含逐任务计量 Token 与延迟记分牌、线上任务实录、harness 完整性协议与强 Solo 基线的诚实分析——[**`BENCHMARKS.zh-CN.md`**](BENCHMARKS.zh-CN.md)（英文版：[**`BENCHMARKS.md`**](BENCHMARKS.md)）。
>
> 🧪 **一键复现**：`npm run benchmark:live` 用你自己的账号跑同一场实盘对决（`OPENCODE_API_KEY`）；`node scripts/run-live-benchmarks.mjs --offline-selftest` 零 API 花销验证全部 harness 机制。
>
> ⚙️ **确定性套件**：12 项零网络机制验证套件（`npm run benchmark`，毫秒级）仍以跨运行字节级一致的方式验证工具链保证——见报告第 7 节。

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

- **Google Research Harness² (Xu et al. 2026)** ([arXiv:2610.14224](https://arxiv.org/abs/2610.14224))：参考 Google Cloud AI Research *"Harness^2: Recursive Agent Harnessing for an Open World"*，融合 `INV`/`DOM` 双维度正交解耦、`KEEP_BASE` 反盲动纪律、六维交付物保真标尺、证据数据边界与 `<experience>` 跨任务经验卡片机制。
- **Scaling Test-Time Compute (Snell et al. 2024)** ([arXiv:2408.03314](https://arxiv.org/abs/2408.03314))：测试期动态算力与自适应验证预算分配机制参考。
- **Self-Debugging (Chen et al. 2023)** ([arXiv:2304.05128](https://arxiv.org/abs/2304.05128))：自动化测试运行器探测与确定性复现脚本合成机制参考。
- **LATS / Language Agent Tree Search (Zhou et al. 2023)** ([arXiv:2310.04406](https://arxiv.org/abs/2310.04406))：Git 快照检查点与失败分支回滚机制参考。
- **Agent-as-a-Judge (Zhuge et al. 2024)** ([arXiv:2410.10934](https://arxiv.org/abs/2410.10934))：六维量化标尺权重评分与通过门禁机制参考。
- **ExpeL / Experiential Learning (Zhao et al. 2023)** ([arXiv:2308.10144](https://arxiv.org/abs/2308.10144))：关键词智能经验召回与工作区终身记忆库持久化机制参考。
- **Magentic-One (Fourney et al. 2024)** ([arXiv:2411.04468](https://arxiv.org/abs/2411.04468))：停滞自适应与换人诊断机制思路来源。
- **claude-flow**：多智能体编排边界与共享状态机制参考。
- **Felix Rieseberg**：顶尖专家四问与激进验收线提议方法参考。


---

## 商标与免责声明

Antigravity 是 Google LLC 的商标。本项目为独立开源社区作品，与 Google LLC、Anthropic、OpenAI、DeepSeek 或 WorkBuddy 无任何关联，亦未获得其官方授权或背书。文中所提及的所有产品名称、商标与品牌均为其各自所有者的财产。

---

## 许可证

[MIT](LICENSE) © 2026 Liangliang Chen
