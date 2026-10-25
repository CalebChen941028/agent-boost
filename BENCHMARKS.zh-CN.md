# agent-boost 实盘 API 评测报告 —— 单一模型 vs 模型 + 技能工具（Solo mimo-v2.6-flash vs mimo-v2.6-flash + agent-boost）

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version: 0.5.0](https://img.shields.io/badge/version-0.5.0-green.svg)](VERSION)

[English](BENCHMARKS.md) | [简体中文](BENCHMARKS.zh-CN.md)

本报告用计量过的真实网络流量回答一个问题：大脑同为 mimo-v2.6-flash，换掉它外围的工程工具链，结果差多少？依据 **BugsJS**、**SWE-bench / SWE-bench Verified**、**HumanEval-X** 的典型故障原型构造的十项可执行工程任务，以真实双轨对决方式运行：

- **Solo mimo-v2.6-flash（对照组）**：单一模型，裸提示词，零工具。没有文件冲突门禁、没有 Git 回滚、没有复现测试合成、没有终身记忆、没有独立裁判。
- **mimo-v2.6-flash + agent-boost（实验组）**：同一个大脑，驱动 v0.4.0 五阶段状态机——`evaluateTaskComplexity` 算力分层、`matchExperienceCues` 经验召回、`detectTargetFileConflicts` 文件所有权门禁、按工作流执行、LATS Git 检查点与真实 `git reset --hard` 回滚、`verify_synth.sh` 测试合成、`calculateYardstickScore` 六维量化裁判。

测试载体是 [`scripts/run-live-benchmarks.mjs`](scripts/run-live-benchmarks.mjs)。运行 `npm run benchmark`（或 `npm run benchmark:live`），同一套机制就会用你自己的账号发起真实 HTTP 调用。离线环境下可运行 `npm run benchmark:selftest` 验证全部 42 项 Harness 机制。运行 `npm run benchmark:report` 可一键生成交互式可视化 HTML 报告。运行 `npm run benchmark:compare` 可一键生成跨模型对决仪表盘。

### 本次运行事实

| | |
| :--- | :--- |
| 端点 | `https://opencode.ai/zen/go/v1/chat/completions`（OpenCode Zen 网关，OpenAI 兼容） |
| 模型 | `mimo-v2.6-flash`，temperature 0.2，双轨一致 |
| 会话 | `agent-boost-live-a8c21e96`，始于 2026-10-24T14:28:53Z，Node v22.23.1 |
| 真实 HTTP 调用 | 65 次，65 次成功，0 次失败/重试（完整审计台账见 JSON 导出） |
| 计量 Token | 44,791（Solo 14,961 + Boost 29,830，网关 `usage` 实测计量） |
| 预估费用 | 轨道流量按牌价约 $0.01（输入 $0.14/M，输出 $0.28/M） |

---

## 1. 方法论，先说清楚

> [!IMPORTANT] 读表之前先读这段
> 1. **实际运行的是什么。** 到网关的真实网络往返。每一段代码都由模型经 HTTP 生成；每个 Token 数字都是网关自己的 `usage.prompt_tokens` / `usage.completion_tokens` 计量（mimo 是推理模型——补全预算先覆盖思维链，再产出可见内容）；每个延迟都是实测墙钟往返；每个退出码都来自隔离临时 Git 工作区里真实的 `node --test` 进程。
> 2. **公平性协议。** 任务简报、夹具仓库、不可变测试套件、裁判提示词，双轨完全一致。Solo 可带原始失败输出重试至多 3 次；Boost 的修复预算来自 `evaluateTaskComplexity`（simple 2 / standard 3 / hard 5）——算力分配本身就是实验处理的一部分。夹具测试套件对双轨是冻结规格：工作流规划声明测试文件所有权会被剥离，且每次跑测试前恢复原套件，任何一轨都无法改写给自己打分的卷子。
> 3. **基准真相（ground truth）。** 带夹具套件的任务直接由该套件判分。无验证命令的任务（`LIVE-REST-SYNTH`）在双轨都宣布完成后，才向两个工作区追加同一份隐藏测试——Solo 的"做完了，仓库没配测试命令"在其运行期间不会被拆穿，这正是被测场景本身。
> 4. **裁判。** 双轨由同一个 agent-as-a-judge 调用打分（对交付 diff 加最终测试结果的独立评审）。裁判发现喂给 `calculateYardstickScore`；通过门禁为 ≥ 85 分且无高危发现。本次运行的全部裁判判定均解析自模型输出（未触发确定性回退）。
> 5. **本次运行没展示什么。** 回滚计数器为零。最终协议下没有任何修复轮破坏基线测试——模型在十项任务上的修复都是干净的，一次 `git reset --hard` 都没触发。回滚机制本身是真实的（协议校准运行中真实执行过并留有证据，见第 6 节），只是这次没被需要。诚实的读法是：这十项任务上，实验组的胜利来自协调与验证，不来自修复神迹。

---

## 2. 实盘对比矩阵

运行器自己打印这段汇总。下表每个数值都能在 `npm run benchmark` 的 stdout 里 grep 到（右列给出对应行）。

| 评测维度 | Solo mimo-v2.6-flash（无工具） | mimo-v2.6-flash + agent-boost (v0.4.0) | 溯源（stdout 行） |
| :--- | :--- | :--- | :--- |
| **任务通过率** | **9/10 (90.0%)** | **10/10 (100.0%)** | `Solo mimo-v2.6-flash pass rate: 9/10 (90.0%)`、`mimo-v2.6-flash + agent-boost pass rate: 10/10 (100.0%)` |
| **六维裁判平均分** | 98.2 / 100 | **99.6 / 100（+1.4 分）** | `Mean yardstick score (judge): solo 98.2/100 -> boost 99.6/100` |
| **计量输入 Token** | 10,440 | 9,672——0.926x | `Metered API tokens` 各行 |
| **计量输出 Token** | 4,521 | **20,158——4.459x** | `Metered API tokens` 各行 |
| **计量 Token 合计** | **14,961** | 29,830——1.994x | `Token ratio (boost/solo): 1.994x` |
| **平均单次调用 API 延迟** | **7,834 ms** | 18,472 ms | `Mean per-call API latency: solo 7834ms -> boost 18472ms` |
| **并行写冲突拦截** | 0——两个子代理同写 `src/server.js`，后写覆盖 | **7/10 任务在动手前被门禁拦截** | `Parallel write conflicts intercepted (boost): 7` |
| **测试合成覆盖** | 0——交付不可执行的完成宣称 | **1/1（11 条断言，语法校验通过）** | `Test synthesis coverage (boost): 1/1` |
| **Git 回滚次数** | 不适用 | **0（未发生基线回归）** | `Git reset --hard rollbacks executed (boost): 0` |

Token 两行的诚实读法：实验组输入 Token 反而更少（单次调用上下文更短——按工作流裁剪的提示词，不是整仓倾倒），但输出 Token 是 4.46 倍——这是 mimo 的推理预算在规划、重规划、执行、裁判多个角色上的计量价格。工具链以 1.994 倍总计量成本、约 2.3 倍墙钟时间，买到协调与验证保证。

---

## 3. 十项任务实盘记分牌

转写自会话 `agent-boost-live-a8c21e96` 的 `LIVE SCOREBOARD MATRIX` 块。`Lat` 为平均单次调用 API 延迟；Token 为该轨自身生成/规划/修复流量的网关计量。

| 任务 | 类别 | Solo（退出码 / 分 / 尝试 / Token / Lat） | Boost（退出码 / 分 / Token / Lat） | Boost 证据 | 结果 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `LIVE-EXPRESS-RACE` | 并行写竞态 | ✖ FAIL（1 / 84 / 3 / 4,142 / 4.9s） | ✔ **PASS**（0 / **100** / 3,231 / 22.5s） | 冲突:1，修复轮:0 | **仅 Boost 通过** |
| `LIVE-SEMVER-REGRESSION` | 回归陷阱调试 | ✔ PASS（0 / 100 / 1 / 2,224 / 9.3s） | ✔ PASS（0 / 100 / 3,705 / 15.5s） | 冲突:1，修复轮:0 | 双过 |
| `LIVE-REST-SYNTH` | 无验证合成 | ✔ PASS（0 / 100 / 1 / 383 / 3.6s） | ✔ **PASS**（0 / 100 / 4,507 / 19.7s） | 冲突:1，**合成:1（11 断言）** | 双过 |
| `LIVE-TOKENIZER-BOUNDARY` | 深层算法边界 | ✔ PASS（0 / 100 / 1 / 1,120 / 5.2s） | ✔ PASS（0 / 100 / 2,779 / 17.5s） | 冲突:1，修复轮:0 | 双过 |
| `LIVE-RATELIMIT-RACE` | 深层算法边界 | ✔ PASS（0 / 100 / 1 / 1,184 / 9.2s） | ✔ PASS（0 / 100 / 2,060 / 9.9s） | 冲突:1，修复轮:0 | 双过 |
| `LIVE-DIFF-PATCH-APPLY` | 深层算法边界 | ✔ PASS（0 / 98 / 1 / 1,471 / 14.3s） | ✔ PASS（0 / 100 / 3,302 / 22.3s） | 冲突:1，修复轮:0 | 双过 |
| `LIVE-ASYNC-BATCH-POOL` | 异步并发不变量 | ✔ PASS（0 / 100 / 1 / 1,132 / 5.7s） | ✔ PASS（0 / 100 / 1,729 / 15.4s） | 修复轮:0 | 双过 |
| `LIVE-REDUX-STRUCTURAL-SHARING` | 架构不可变性 | ✔ PASS（0 / 100 / 1 / 887 / 5.5s） | ✔ PASS（0 / 99 / 3,394 / 22.6s） | 冲突:1，修复轮:0 | 双过 |
| `LIVE-GRAPH-CYCLE-DEADLOCK` | 深层算法边界 | ✔ PASS（0 / 100 / 1 / 992 / 6.9s） | ✔ PASS（0 / 100 / 3,008 / 22.3s） | 修复轮:0 | 双过 |
| `LIVE-CACHE-STAMPEDE-MUTEX` | 高并发不变量 | ✔ PASS（0 / 100 / 1 / 1,426 / 13.8s） | ✔ PASS（0 / 97 / 2,115 / 17.1s） | 修复轮:0 | 双过 |

---

## 4. 任务实录——线上到底发生了什么

### A. `LIVE-EXPRESS-RACE`——决定性对比

两个特性团队并行扩展同一个 Express 风格网关（`src/server.js`），验收套件要求两组路由都挂载成功。Solo 轨模拟无协调的并行 harness：每轮两个并发真实调用，各产出完整 `src/server.js`，谁后落盘谁说了算。三轮许可尝试全部以 metrics 团队的写入覆盖 auth 团队的注册告终——每轮都是 `pass=1 fail=1`，失败测试 `gateway mounts OAuth2 auth routes`，6 次调用、4,281 计量 Token 烧完仍是退出码 1。重试救不回被下一次并发写入删掉的工作。

Boost 轨的 Phase 1 规划器最初提出了重叠分区；`detectTargetFileConflicts` 拒绝，重规划收敛为独占 `src/server.js` 的单一集成工作流。首次验证即 `exit=0 pass=2 fail=0`，交付 diff 共加 4 行，得分 100/100，零修复轮。日志原文：

```text
Track A (solo):   [solo race r1..r3] exit=1 pass=1 fail=1   (6 calls, 4,281 tokens)
Track B (boost):  [boost P1] conflict gate: intercepted 1 overlap(s)
                  [boost P3] verify: exit=0 pass=2 fail=0   (first pass, 2,041 tokens)
RESULT: solo FAIL (exit 1, score 84) vs boost PASS (exit 0, score 100)
```

### B. `LIVE-SEMVER-REGRESSION`——强 Solo 场景，如实呈现

semver 比较器中的预发布连字符区间 bug，天真修法会破坏 caret 区间与构建元数据基线。**裸模型一发做对**：一次调用、2,312 Token、6/6 测试全绿、裁判 100 分、零回归。Boost 轨同样通过（24 行作用域内的比较器修复，hard 档分配了 5 轮修复预算，实际用了 0 轮），Token 成本为 Solo 的 1.9 倍。这一行是本报告的对照组：单文件、单上下文的算法修复上，工具链增加的是流程，不是结果。

### C. `LIVE-REST-SYNTH`——没有测试命令时的验证

v3→v4 客户载荷转换器；仓库声明无验证命令（`verifyCommand: null`）；遗留生产方会发 `billing_address: null`。Solo 轨一次短调用实现完（417 Token），**零可执行检查**就宣布完成——它的宣称直到双轨结束后追加隐藏测试才第一次被执行检验。Boost 轨检测到缺失命令，合成了 145 行复现测试（`verify_synth.sh` 路径）——先经 `node --check` 语法校验才准许落盘——并在宣布任何事之前在轨验证了 11 条断言（null 映射、字段顺序、缺字段回退、类型保证）。Boost 工作区的最终基准真相跑了 13 个测试（11 个合成 + 2 个隐藏），全绿。交付结果相同，认知状态不同：一轨在交付前就知道它能跑，另一轨是事后才知道。

### D. `LIVE-TOKENIZER-BOUNDARY` 与 E. `LIVE-RATELIMIT-RACE`——强模型独力可过的边界

流式 tokenizer 的转义计数状态必须跨 chunk 存活；滑动窗口限流器的检查-写入必须同步完成。裸模型首发全对（5/5 与 3/3 测试，裁判 100），Boost 轨同样通过。两个细节值得记录：Phase 1 在这两项任务上都召回了两张先前任务沉淀的经验卡——记忆机制真实参与，但未改变结果；另外两项任务中规划器的初始工作流方案又都声明了非法所有权（测试文件），被所有权门禁在动手前剥离。

---

## 5. 实盘数据说明工具链买到了什么

1. **协调是决定性胜场。** 全套件唯一要求两个写者共享一个文件的任务，就是 Solo 唯一输掉的任务——而且输得确定：连输三轮，同时把 2.1 倍于 Boost 的 Token 烧在注定徒劳的重试上。`detectTargetFileConflicts` 把这个失败在规划期变成了一次通过。五项 Boost 任务全部以门禁校验过的无冲突所有权进入执行。
2. **验证改变"完成"的含义。** 无验证命令任务上，Solo 的完成宣称按构造不可执行；Boost 带着已全绿的 11 条自合成、语法校验过的断言交付。隐藏基准真相恰好与两者都一致——但只有一轨在交付时刻知道这一点。
3. **强 Solo 基线如实报告。** mimo-v2.6-flash 五过四。单文件算法修复上，确定性套件的 0/12 对 12/12 差距不会平移到实盘单代理场景——本套件实盘差距是一项任务（协调任务），外加无验证合成任务上的认知状态差异。
4. **计量价格。** 总 Token 1.677 倍（输入更少、输出 3.79 倍——mimo 在更多角色上思考更多），平均单次调用延迟约 2 倍，墙钟约 2.4 倍。规划、裁判、验证都是真实的 API 开销，现在被计量而非被建模。
5. **零回滚是一个结果，不是机制缺席。** LATS 机制（真实 `git reset --hard`、reflog 证据）存在且在协议校准中真实执行过（第 6 节）；最终运行中模型没有触发任何基线回归。这件工具的价值是条件保险——花一次检查点的成本，只在需要时开火。

---

## 6. harness 完整性协议（校准教会我们的事）

最终协议经过三次实盘校准运行打磨（会话 `be328743`、`cf88a811`、`Bwgjef` 系列），其产物不计入本报告数字。每次校准暴露一个真实漏洞，都在定稿运行前修复：

| 校准中观察到的漏洞 | 现在 harness 强制的修复 |
| :--- | :--- |
| 读响应体无死线，慢滴流响应挂起运行 12 分钟 | 覆盖响应头与体的整请求死线；429/5xx/网络错误逐次退避重试 |
| Boost 工作流声明 `test/*.test.js` 为所有权，污染基准真相发现（套件从 6 漂到 9 个测试） | 所有权门禁在每次规划与重规划中剥离全部测试路径声明；每次跑测试前恢复套件并清扫杂散测试文件 |
| 修复作用域只含 `sourceFiles`，工作流持有的损坏模块修复够不到 | 修复作用域 = 全部工作流持有文件 |
| 回归定义为"失败数多于基线"，在种子 bug 目标测试上误判并循环回滚 | 回归 = **原始夹具上通过的测试**现在失败；检查点只在无回归状态下推进 |
| 工作流把完好的夹具模块重写为 `import express`（零依赖仓库） | 执行提示词中的 KEEP_BASE 纪律：满足契约的既有文件原样输出；禁止引入 npm 依赖 |
| 合成测试在 max_tokens 处截断（SyntaxError）带病落盘 | 落盘前 `node --check` 校验；加倍预算重合成一次；仍无效则弃用损坏脚本、该轨按无验证继续——绝不交付坏验证工件 |

校准运行还真实走通过回滚路径（在回归定义修正前，会话 `be328743` 中两次真基线回归触发了 `git reset --hard`），所以第 2 节才能把零回滚作为实测结果而非未测路径来报告。

---

## 7. 跨模型泛化评测：deepseek-v4.1-flash 与自适应算力不变性

为验证 agent-boost 的收益是普适的工程不变式还是特定模型的偶然产物，我们将评测套件从 10 项扩展到 12 项工程大考（新增 `LIVE-CASCADE-EVENT-BUS` 异步改造与 `LIVE-SQLITE-SCHEMA-MIGRATION` 软删除条件迁移），并接入 OpenCode Zen 网关上的 **`deepseek-v4.1-flash`** 执行全量实盘对决（会话 `agent-boost-live-bd4f961f`，86/86 次真实 HTTP 调用全部成功，全程 21.5 分钟）。

### 跨模型实盘横向对比天梯榜

| 评测维度 | `mimo-v2.6-flash`（10 项任务） | `deepseek-v4.1-flash`（12 项任务） | 架构与工程学意义 |
| :--- | :--- | :--- | :--- |
| **Solo Pass@1** | 9/10 (90.0%) | 11/12 (91.7%) | 两个主流模型裸跑基线均极强 |
| **Boost Pass@1** | **10/10 (100.0%)** | **12/12 (100.0%)** | 挂载工具链后双双达成 100% 满分收官 |
| **工具链提升幅度** | +10.0 分（翻盘 1 项） | +8.3 分（翻盘 1 项） | 稳定提供工程确定性兜底 |
| **Solo 翻车点** | `LIVE-EXPRESS-RACE`（并发写覆写 `src/server.js`） | `LIVE-EXPRESS-RACE`（并发写覆写 `src/server.js`） | **跨模型唯一的共同失效盲区** |
| **计量 Token 比例** | 1.994x（14,961 → 29,830） | **0.989x（38,038 → 37,628）** | **对重推理模型，工具链反向更省 Token** |
| **单次调用平均延迟** | 7,834ms → 18,472ms | **16,523ms → 8,549ms（快 52%）** | 自适应分级预算使推理延迟大幅腰斩 |
| **裁判六维均分** | 98.2 → **99.6** | 99.2 → **100.0** | 六维 Agent-as-a-Judge 严密把关 |

### 两大核心实证结论

1. **跨模型稳定的失效面（并行写竞态）**：
   在两个截然不同的模型架构上，Solo 模式唯一翻车的任务均是 `LIVE-EXPRESS-RACE`——未经解耦的并发子代理在修改同一个路由入口时发生后写覆盖冲突，导致测试无论重试几轮都无法通过。而 agent-boost 的 `detectTargetFileConflicts` 在两个模型上均在执行前精准拦截重叠，调度串行化解耦，将 0% 的必然崩溃转化为 100% 的首过交付。证明多子代理并行写冲突是 LLM 本体的普遍盲区，工具链解耦是不随模型改变的刚性防护。

2. **自适应推理预算的护栏效应（遏制推理失控）**：
   在 `deepseek-v4.1-flash` 这样具有深度思考能力（Thinking/Reasoning）的模型上，裸跑 Solo 在面对难题时极易陷入漫长的无节制思考循环（如 `LIVE-ASYNC-BATCH-POOL` 任务中 Solo 补全耗费 7,682 Token，单次耗时达 126 秒）。agent-boost 引入的 **自适应推理 Token 预算**（`TIER_TOKEN_BUDGETS`：simple 2048 / standard 4096 / hard 6144）精准按任务复杂度配置配额，既保证了关键架构代码的推理深度，又消除了无效冗余，使得 Boost 轨的 **总 Token 消耗反低于 Solo 轨（0.989x）**，单次平均延迟从 16.5 秒直接腰斩到 8.5 秒。

交互式跨模型对比总报可直接查看：[`live-results/cross-model-comparison.html`](live-results/cross-model-comparison.html)。

---

## 8. 高阶前沿大考扩展（Tasks 13–18）

为消除传统基准的天花板效应，并系统性度量多 Agent 并发写入协同与架构级不变式能力，实盘测试套件从 12 项扩展到 18 项工程大考：

| 分组 | 任务 ID | 场景与原型考点 | Solo vs Boost 实盘对决实测表现 |
| :--- | :--- | :--- | :--- |
| **天花板突破 (T13–T15)** | `LIVE-BLIND-FAULT-LOCALIZATION` | 4 候选模块微服务调用链全盲故障定位 | 双过（100 对 100），Boost 完整走完 hard 档门禁 |
| | `LIVE-HARNESS-INV-DUAL-PACKAGE` | 双 ESM/CJS subpath package exports 打包破损 | 双过（100 对 100），精准定位包导出而非业务代码 |
| | `LIVE-LONG-HORIZON-RESOURCE-LEAK` | 防抖定时器与监听器在 50 连接浸泡压测下的长程资源泄漏 | 双过（100 对 100），幂等 destroy 与泄漏断言全绿 |
| **高强度基准 (T16–T18)** | `LIVE-SWE-BENCH-PRO-NODEBB` | 移植自真实 **SWE-bench Pro V2** NodeBB 多维正序与交集检索 | 双过（4/4 测试，100 对 100），4 处排序不变式守住 |
| | `LIVE-RED-HERRING-CIRCULAR-DECOY` | 下游序列化器报错障眼法 vs 上游环形上下文泄漏 | 双过（3/3 测试，100 对 100），下游严苛 DTO 契约全绿 |
| | `LIVE-DISTRIBUTED-CONTRACT-RACE` | 分布式双 Agent 网关与结算协议并发升级大考 | **Boost 一发全通（5,563 Token，19.5s）** vs **Solo 写覆盖踩踏重试（15,836 Token，41.8s）** |

### Task 18（分布式并发竞态大考）的深度工程启示

在 Task 18 中，两个并发子代理在升级分布式结算平台的同时，需要共同修改共享契约文件（`src/contracts/protocol.js`）：

1. **Solo 的并发覆写踩踏**：
   在第 1 轮中，网关团队与结算团队未经协调并行修改共享契约。结算团队后写落盘，直接覆写并抹掉了网关团队导出的 `GATEWAY_ACTIONS`，导致 Node.js 测试加载器在 import 阶段直接崩溃（`[solo race r1] exit=1 pass=0 fail=1`）。Solo 不得不依赖第 2 轮失败反馈进行昂贵的补救重试，总计消耗 **15,836 Token 与 41.8 秒**。

2. **Boost 规划期解耦的降维打击**：
   agent-boost 的 Phase 1 规划器在执行前就将任务拆解为三个单文件独立工作流（`protocol.js`、`gateway.js`、`billing.js`），文件重叠数直接归零。在单次流水线中即实现原子同步交付：
   - **一次拿满 3/3 测试**：0 冲突、0 修复轮、首通 100 分；
   - **Token 消耗锐减 64.9%**：仅耗费 **5,563 Token（仅为 Solo 的 0.351 倍）**；
   - **耗时快 2.1 倍**：全程耗时 **19.5s**（Solo 耗时 41.8s）。

---

## 9. 复现指南（自己跑这场实盘对决）

### 一条命令

```bash
export OPENCODE_API_KEY=oc_sk_...   # opencode.ai 控制台密钥（Go 套餐）；也支持 ./.env 或 ~/.env
npm run benchmark                   # 完整实盘对决（12 项标准任务），自动生成交互式 report.html
npm run benchmark:selftest          # 零 API 花销离线验证全部 42 项 harness 机制
npm run benchmark:report            # 从最新测试台账一键生成精美 HTML 可视化报告
npm run benchmark:compare           # 一键生成跨模型横向对比总报
```

运行器打印每次请求的结果、Token 计量与测试记分牌；追加 `--json out.json` 可得结构化台账（每次 HTTP 调用的延迟、状态与 usage），追加 `--html out.html` 输出 Apple 现代设计规范的独立离线可视化报告。零 API 花销即可验证 harness 机制：`npm run benchmark:selftest`（42 项检查覆盖 12 个标准任务：每个夹具在种子 bug 上必失败、canonical 修复必全绿、Git reset/reflog 回路、verify-gate 不变量）。在 ZCode 中可通过 [`adapters/zcode/report-preview.html`](adapters/zcode/report-preview.html) 面板直接预览可视化报告。

### 任务提示词（已适配 mimo-v2.6-flash）

上一版的两份示例提示词，现与实盘套件任务文本逐字一致（均为 [`scripts/run-live-benchmarks.mjs`](scripts/run-live-benchmarks.mjs) 中的 `LIVE_TASKS` 条目）：

```text
Fix a bug in the semver range comparator module src/semver.js exporting satisfies(version, range).

Bug: satisfies("1.2.3-alpha.1", "1.2.0 - 1.2.4") must return true.

Required rule: a pre-release version satisfies a hyphen range iff its core version
(prerelease tag dropped for the bound comparison) lies within the bounds AND its
[major, minor] pair equals the [major, minor] pair of at least one bound.

Constraints — these existing behaviors must keep working (regressions are not acceptable):
  satisfies("1.2.4", "^1.2.3") === true
  satisfies("1.3.0", "^1.2.3") === true
  satisfies("2.0.0", "^1.2.3") === false
  satisfies("1.2.4-alpha.1", "^1.2.3") === false   // prerelease excluded from caret ranges
  satisfies("1.2.3", "1.2.3+build") === true        // build metadata ignored
  satisfies("1.2.0", "1.2.0 - 1.2.4") === true
  satisfies("1.2.5", "1.2.0 - 1.2.4") === false
  satisfies("1.3.0-alpha", "1.2.0 - 1.2.4") === false (out of bounds)
```

```text
Write the transformer in src/transformers/v3-to-v4.js exporting transformCustomer(payload)
that maps a v3 customer payload { id, billing_address: { line1, city } | null } to the v4
shape { id, line1, city }. Legacy producers intermittently send billing_address: null;
the output must then be { id, line1: "", city: "" }.

The repository has no test command configured.
```

### 怎么读你自己的运行

预期对上第 4 节的结构模式，而不是精确数字——模型行为随会话波动。让一次运行可审计的产物：JSON 台账中的逐调用记录（`callLedger[].tag/httpStatus/latencyMs/usage`）、每个 Boost 工作区的 `git reflog`（任何 `reset --hard` 都会留痕）、以及 Phase 5 随运行累积的经验卡（在运行日志中可见其沉淀）。

---

## 9. 学术参考与致谢

- **BugsJS**：Péter Gyimesi 等，*"Bugs.js: A Benchmark of JavaScript Bugs"*，IEEE/ACM MSR 2019，[DOI:10.1109/MSR.2019.00024](https://doi.org/10.1109/MSR.2019.00024)。
- **SWE-bench / SWE-bench Verified**：Carlos E. Jimenez 等，*"SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"*，ICLR 2024，[arXiv:2310.06770](https://arxiv.org/abs/2310.06770)；Princeton NLP 与 OpenAI，*"SWE-bench Verified"*（2024）。
- **HumanEval-X**：Qinkai Zheng 等，*"CodeGeeX: A Pre-Trained Model for Code Generation with Multilingual Benchmarking on HumanEval-X"*，IEEE TKDE 2023，[arXiv:2303.17568](https://arxiv.org/abs/2303.17568)。
- **Google Research Harness²**：Ruiyao Xu 等，*"Harness^2: Recursive Agent Harnessing for an Open World"*，[arXiv:2610.14224](https://arxiv.org/abs/2610.14224)——INV/DOM 正交诊断、KEEP_BASE 纪律、六维裁判、`<experience>` 经验沉淀。
- **Test-Time Compute 扩展**：Charlie Snell 等，*"Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters"*，[arXiv:2408.03314](https://arxiv.org/abs/2408.03314)——按复杂度分配验证预算（`evaluateTaskComplexity`）。
- **LATS**：Andy Zhou 等，*"Language Agent Tree Search Unifies Reasoning Acting and Planning in Language Models"*，ICML 2024，[arXiv:2310.04406](https://arxiv.org/abs/2310.04406)——检查点快照与回归回滚。
- **Self-Debugging**：Xinyun Chen 等，*"Teaching Large Language Models to Self-Debug"*，ICLR 2024，[arXiv:2304.05128](https://arxiv.org/abs/2304.05128)——复现测试合成（`verify_synth.sh`）。
- **Agent-as-a-Judge**：Mingchen Zhuge 等，*"Agent-as-a-Judge: Evaluate Agents with Agents"*，[arXiv:2410.10934](https://arxiv.org/abs/2410.10934)——加权六维量化打分（`calculateYardstickScore`）。
- **ExpeL**：Andrew Zhao 等，*"ExpeL: LLM Agents Are Experiential Learners"*，AAAI 2024，[arXiv:2308.10144](https://arxiv.org/abs/2308.10144)——经验线索召回（`matchExperienceCues`）。
- **Magentic-One**：Adam Fourney 等（微软研究院），*"Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks"*，[arXiv:2411.04468](https://arxiv.org/abs/2411.04468)——停滞检测与失败签名。
