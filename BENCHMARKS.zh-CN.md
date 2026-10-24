# agent-boost 基准评测报告 —— 单一模型 vs 模型 + 技能工具（Solo GLM-5.3 vs GLM-5.3 + agent-boost）

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-green.svg)](VERSION)

[English](BENCHMARKS.md) | [简体中文](BENCHMARKS.zh-CN.md)

本报告回答一个问题：大脑同为 GLM-5.3，换掉它外围的工程工具链，结果差多少？依据 **BugsJS**、**SWE-bench / SWE-bench Verified**、**HumanEval-X** 的典型故障原型构造的 12 项可执行基准任务，双轨对照如下：

- **Solo GLM-5.3（对照组）**：单一模型，零工具。没有文件冲突门禁、没有 Git 回滚、没有复现测试合成、没有终身记忆、没有独立裁判。
- **GLM-5.3 + agent-boost（实验组）**：同一个大脑，驱动 v0.4.0 五阶段状态机——`detectTargetFileConflicts` 冲突拦截、LATS Git 快照回滚、`verify_synth.sh` 测试合成、INV-First 机制预检、`calculateYardstickScore` 六维量化裁判、`matchExperienceCues` 经验召回。

测试载体是 [`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs)。运行 `npm run benchmark`，本报告里的每个数字都会在你终端打印出来。环境要求只有 Node 18 及以上；CI 在 Node 18.x / 20.x / 22.x 三个版本上执行同一套校验（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。

---

## 1. 方法论，先说清楚

> [!IMPORTANT] 读表之前先读这段
> 1. **实际运行的是什么。** 一套确定性可执行模拟。对照组与实验组都执行真实 JavaScript：对照组跑无门禁的裸代码路径（后写覆盖、盲重试叠补丁、无验证即宣称完成），实验组调用仓库内置纯函数（[`shared/verify-gate.ts`](shared/verify-gate.ts) 中的 `detectTargetFileConflicts`、`computeFailureSignature`、`calculateYardstickScore`、`matchExperienceCues`、`evaluateTaskComplexity`）。12 项任务全套在笔记本上毫秒级跑完。修复轮次取自实际执行的循环计数器，Token 消耗按公开常量 `TOKENS_PER_AGENT_TURN = 1200`（[`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs)）乘以计数的模型轮次核算，因此 MTTR 与 Token 行跨运行字节级一致。
> 2. **没有运行的是什么。** 远程大模型 API。runner 唯一的导入是 `../shared/verify-gate.js`（[`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs)），零网络 I/O。下文 Token 数字是该核算模型下的账面轮次成本，并非 API 计量。GLM-5.3 是对照组与实验组在实盘中共用的大脑——本套件度量的是大脑外围的工具链，模型准确率不在其内。实盘双轨对照的完整流程见第 8 节。
> 3. **为什么差距是 0/12 vs 12/12。** 每项任务都是边界场景：对照组的故障模式被写成可执行事实（例如第二个工作流对 `src/server.ts` 的写入字面替换第一个），实验组的门禁按构造必然拦截。这组数字验证的是机制保证，而非实盘模型排行榜。实盘中强模型当然能做对相当一部分常规任务——在这 12 个边界上，缺失的工具直接决定成败。

本报告的每个数字满足两条溯源规则之一：能在 `npm run benchmark` 的 stdout 里 grep 到，或直接对应任务源码常量。凡属结构性推论而非实测的部分，正文均明确标注。

---

## 2. 单一模型 vs 模型+技能工具实测对比矩阵（Solo GLM-5.3 vs GLM-5.3 + agent-boost）

runner 执行任何任务之前先自报对照框架——以下横幅逐字引自 `npm run benchmark` stdout：

```text
================================================================================
  agent-boost v0.4.0 Standard Engineering Benchmark Evaluation Harness
  Comparison frame: Solo GLM-5.3 (single model) vs GLM-5.3 + agent-boost v0.4.0 (model + skill tools)
  Harness: deterministic executable simulation — no live LLM API calls (reproduce: npm run benchmark)
  Benchmark Datasets: BugsJS (ICSE/MSR), SWE-bench Verified, HumanEval-X
================================================================================
```

12 个任务块之后打印 `AGGREGATE SUMMARY` 汇总。下表逐行转写该汇总块；右列给出每个数值对应的 stdout 行，用 `npm run benchmark | grep` 即可逐项核对。

| 评测维度 | Solo GLM-5.3（无工具） | GLM-5.3 + agent-boost (v0.4.0) | 溯源（stdout 行） |
| :--- | :--- | :--- | :--- |
| **任务首次通过率 (Pass@1)** | **0/12 (0.0%)** | **12/12 (100.0%)**——+100.0%（12.0 倍） | `Baseline Solo Agent Pass Rate: 0/12 (0.0%)`、`With agent-boost v0.4.0 Pass Rate: 12/12 (100.0%)`、`First-Pass Pass Rate Delta: +100.0% (12.0x improvement)` |
| **并行写文件冲突拦截率** | 0/3——三项竞态任务全部发生静默后写覆盖 | **3/3（100.0% 拦截并解耦）** | `Parallel Write Race Conflicts Intercepted: 3/3 (100.0% elimination)`；对照组 0/3 即记分牌中 `BUGSJS-EXPRESS-104`、`BUGSJS-COMMANDER-212`、`BUGSJS-CHALK-031` 三行 baseline `FAIL` |
| **级联回归陷阱自愈率** | 0/2——无回滚，污染分支永久留存 | **2/2（100.0% 经 LATS reset 自愈）** | `Cascade Regressions Recovered via LATS: 2/2 (100.0% recovery)` |
| **无测试任务复现脚本合成覆盖率** | 0/1——无任何可执行检查即宣称完成 | **1/1（100.0% 自动合成）** | `Unverified Issues Synthesized via Synth: 1/1 (100.0% coverage)` |
| **六维 Yardstick 平均分** | 79.4 / 100（12 项全部被门禁拦截） | **99.7 / 100（+20.3 分）** | `Mean Harness² Yardstick Conformance Score: 79.4/100 -> 99.7/100 (+20.3 pts)` |
| **平均修复收敛轮次 (MTTR)** | **2.92 轮**（盲重试） | **1.00 轮**（工具介入） | `Mean Repair Rounds (MTTR): 2.92 (solo, blind retries) -> 1.00 (boost, tool-mediated)` |
| **核算 Token 消耗（比值）** | **116400** | **80400**——0.691x | `Accounted Token Spend (total): 116400 (solo) -> 80400 (boost)`、`Token Spend Ratio (boost/baseline): 0.691x` |

末两行怎么读。修复轮次是任务代码实际执行的循环计数——对照组每轮重放未确诊的补丁并重跑失败检查（盲重试上限三轮），实验组的计数器只在工具介入（冲突拦截、LATS 回滚、重诊断）真正发生时前进；若干实验组任务为 0 轮，因为首过规划已直接收敛。Token 消耗是该核算模型的成本单位——`TOKENS_PER_AGENT_TURN = 1200`（[`scripts/run-benchmarks.mjs:52`](scripts/run-benchmarks.mjs)）乘以每个被计数的模型轮次——不是 API 计量，harness 不发起任何调用。实盘 Token 比请用第 8 节指南测量。

---

## 3. 12 项任务完整对局记分牌

`npm run benchmark` 对每项任务打印一组对照——`Mode A (Solo GLM-5.3, no tools)` 对阵 `Mode B (GLM-5.3 + agent-boost)`，各带退出码、六维得分、实际执行修复轮次与核算 Token 消耗——随后输出汇总矩阵。下表转写自这些任务行；耗时随机器浮动，其余各项确定不变。

| 任务 ID | 数据集来源 | 故障类型 | Solo GLM-5.3（退出码 / 得分 / 轮次 / Token） | GLM-5.3 + agent-boost（退出码 / 得分 / 轮次 / Token） | 得分增益 | 结果 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `BUGSJS-EXPRESS-104` | BugsJS / Express.js | 并行写文件竞态 | ✖ FAIL（1 / 82 / 3 / 10800） | ✔ **PASS**（0 / **100** / 1 / 8400） | +18 分 | **已解决** |
| `BUGSJS-COMMANDER-212` | BugsJS / Commander.js | 并行写文件竞态 | ✖ FAIL（1 / 76 / 3 / 10800） | ✔ **PASS**（0 / **99** / 1 / 8400） | +23 分 | **已解决** |
| `SWEBENCH-SEMVER-088` | SWE-bench Verified / node-semver | 级联回归调试 | ✖ FAIL（1 / 80 / 3 / 9600） | ✔ **PASS**（0 / **100** / 2 / 8400） | +20 分 | **已解决** |
| `BUGSJS-LODASH-142` | BugsJS / Lodash（CVE-2018-3721） | 深层语义边界 | ✖ FAIL（1 / 86 / 2 / 7200） | ✔ **PASS**（0 / **99** / 1 / 6000） | +13 分 | **已解决** |
| `SWEBENCH-ASYNC-039` | SWE-bench / Async.js | 深层语义边界 | ✖ FAIL（**124** / 76 / 3 / 9600） | ✔ **PASS**（0 / **100** / 2 / 7200） | +24 分 | **已解决** |
| `BUGSJS-MINISEARCH-055` | BugsJS / Minisearch | 深层语义边界 | ✖ FAIL（1 / 81 / 3 / 9600） | ✔ **PASS**（0 / **100** / 0 / 4800） | +19 分 | **已解决** |
| `HUMANEVALX-JS-084` | HumanEval-X / LeetCode Hard | 算法与状态机 | ✖ FAIL（1 / 80 / 3 / 9600） | ✔ **PASS**（0 / **99** / 0 / 4800） | +19 分 | **已解决** |
| `SWEBENCH-PRISMA-117` | SWE-bench Verified / Prisma ORM | 级联回归调试 | ✖ FAIL（1 / 80 / 3 / 9600） | ✔ **PASS**（0 / **99** / 2 / 8400） | +19 分 | **已解决** |
| `SWEBENCH-REST-063` | SWE-bench / REST 迁移 | 无验证合成 | ✖ FAIL（1 / 76 / 3 / 9600） | ✔ **PASS**（0 / **100** / 1 / 6000） | +24 分 | **已解决** |
| `BUGSJS-MOCHA-076` | BugsJS / Mocha.js | 深层语义边界 | ✖ FAIL（1 / 80 / 3 / 9600） | ✔ **PASS**（0 / **100** / 1 / 4800） | +20 分 | **已解决** |
| `HUMANEVALX-JS-112` | HumanEval-X / LeetCode Hard | 深层语义边界 | ✖ FAIL（1 / 80 / 3 / 9600） | ✔ **PASS**（0 / **100** / 0 / 4800） | +20 分 | **已解决** |
| `BUGSJS-CHALK-031` | BugsJS / Chalk.js | 并行写文件竞态 | ✖ FAIL（1 / 76 / 3 / 10800） | ✔ **PASS**（0 / **100** / 1 / 8400） | +24 分 | **已解决** |

`SWEBENCH-ASYNC-039` 的退出码 124 是典型的超时签名：对照组的环形锁依赖永不解开，harness 将其编码为超时退出。平均分由十二行直接算出：对照组 `953/12 = 79.4`，实验组 `1196/12 = 99.7`。实验组的零轮次条目（`MINISEARCH-055`、`HUMANEVALX-JS-084`、`HUMANEVALX-JS-112`）是首过直接收敛——经验召回、算力档位分配与原子化设计把修复轮次本身消掉了。

任务来源：

- **BugsJS**：Node.js 权威缺陷基准（Gyimesi 等，*MSR/ICSE 2019*），取材 Express、Commander、Lodash、Minisearch、Mocha、Chalk。
- **SWE-bench / SWE-bench Verified**：双重验证仓库基准（Jimenez 等，*ICLR 2024*）——`FAIL_TO_PASS` 必须转绿，`PASS_TO_PASS` 不许变红；本套件覆盖 node-semver、Async.js、REST schema 迁移与 Prisma ORM。
- **HumanEval-X**：多语言算法基准（Zheng 等，*IEEE TKDE 2023*），覆盖流式状态机解析与并发限流。

---

## 4. 执行拓扑对照

### A. Solo GLM-5.3：扁平无协同循环
```
[用户任务]
     │
     ▼
[单一智能体 / 未协同并行子智能体]
     │
     ├──► 子智能体 1 修改业务文件 A & 共享入口
     └──► 子智能体 2 修改业务文件 B & 共享入口 ──► [后写覆盖，静默丢失]
     │
     ▼
[在损坏状态上继续修改] ──► [测试回归] ──► [补丁摞补丁] ──► [级联恶化]
     │
     ▼
[对话式自我认证] ──► "全部完成" ──► [生产崩溃 / CI 失败]
```

### B. GLM-5.3 + agent-boost：五阶段确定性状态机
```
[用户任务]
     │
     ▼
Phase 1: 动态算力分配与终身经验记忆
  ├── evaluateTaskComplexity: 算力档位（简单: 1 轮 / 标准: 3 轮 / 困难: 5 轮）
  ├── matchExperienceCues: 从 .agent-boost/experiences.md 召回 <experience> 经验卡片
  ├── Planner: 专家四问 + 各工作流显式声明互斥 targetFiles
  ├── detectTargetFileConflicts: 任何修改发生前拦截 targetFiles 重叠
  └── Critic: 质疑因果假定；执行 KEEP_BASE 防折腾纪律
     │
     ▼
Phase 2: 分层并行执行与熔断器
  ├── 重模型梯队: 算法攻坚与核心架构修改
  ├── 轻模型梯队: 样板与文档（allSettled + 1 次重试）
  └── 熔断器: 全工作流失败时短路后续验收
     │
     ▼
Phase 3: 验证门禁、INV-First 与 LATS 回滚
  ├── 测试发现；无验证命令时合成 verify_synth.sh
  ├── computeFailureSignature: 尾部 20 行 DJB2 归一化指纹（剥离 PID 与耗时）
  ├── INV-First: 先分离环境/运行器崩溃，再看业务逻辑
  ├── LATS 检查点: 修复前 git 快照；回归时 git reset --hard
  └── 停滞检测: 指纹一致即升级 INV/DOM 根因诊断
     │
     ▼
Phase 4: 六维 Yardstick 复核（Agent-as-a-Judge）
  └── 新任 Reviewer 按 DELIVERY (25)、CONFORMANCE (20)、FIDELITY (15)、
      INTERNAL CONSISTENCY (15)、OPERATIONAL FITNESS (15)、FINISH (10) 给 git diff 打分
      ——权重固定于 shared/verify-gate.ts:637。门禁：总分 >= 85 且零 high 级缺陷。
     │
     ▼
Phase 5: 客观结论与经验沉淀
  ├── 暴露遗留缺口与缺陷发现的诚实结论
  └── 有效 <experience> 卡片写入 .agent-boost/experiences.md
```

---

## 5. 为什么模型再强，也盖不住这四类故障

更强的模型能写出更好的补丁。下面四类故障没有一类是补丁质量问题；它们全部是协调与验证问题，单上下文推理再强也消不掉——因为模型对出事的资源没有原子操作权。

### 5.1 没有文件锁：并行写入互相吞噬

两个工作流都在 `targetFiles` 里列了 `src/server.ts`。无门禁时发生的事被 harness 写成可执行代码——后一次写入直接替换前一次（[`scripts/run-benchmarks.mjs:88`](scripts/run-benchmarks.mjs)）：

```js
let content = "app.use('/api/auth', authRouter);\n";
content = "app.use('/api/metrics', metricsRouter);\n"; // ws2 silently overwrites ws1
```

认证路由没了，运行时对 `/api/auth/login` 回答 `404`。对照组只看得见"路由缺失"这个症状，重放同一份并发补丁，再次被覆盖——stdout 为这份徒劳记下 `RepairRounds: 3, TokenSpend: 10800`。同一构造还抹掉了 Commander 桶导出里的 `TimeoutOption`（`:207`）和 Chalk 入口的 `chalk.hex`（`:1369`）。记分牌上的冲突拦截 0/3 说的就是这件事。实验组在执行前调用 `detectTargetFileConflicts`（`:155`），拒绝重叠，规划器重新切分为互斥文件集加串行组装——stdout 机制行：`Phase 1 intercepted conflict on src/server.ts. Decoupled into 3 disjoint workstreams.` 丢失的写入不会因为推理变强而失而复得；只有排序或互斥能救，而互斥是一件工具。

### 5.2 没有 Git 回滚：一个坏补丁毒化后续所有补丁

`SWEBENCH-SEMVER-088` 修复连字符区间的预发布判定。朴素比较器（[`scripts/run-benchmarks.mjs:341`](scripts/run-benchmarks.mjs)）确实修好了 `FAIL_TO_PASS`——同时弄坏了 `PASS_TO_PASS` 检查（`^1.2.3` 插入符号语义、`+build` 元数据）。没有检查点，每轮盲重试都往已坏的比较器上再叠一层表面修补并重跑套件；循环跑满三轮（`RepairRounds: 3`），套件依然失败。实验组修复前先打快照，比对失败指纹（`:390`），看到发散，执行 `git reset --hard` 回到检查点，再把修复收窄到连字符区间——stdout：`Signature shift detected regression. LATS rollback discarded poisoned patch. DOM diagnosis resolved both test suites.` `SWEBENCH-PRISMA-117` 在租户级联删除上重复同一模式。写出更好的正则救不了这一局；缺的是回到已知良好状态的能力——那是版本控制操作，属于思考之外的范畴。

### 5.3 没有测试合成：完成与否无从验证

`SWEBENCH-REST-063` 的设定是 `verifyCommand: null`。对照组改完转换器就宣布成功；第一个 `billing_address: null` 的请求抛出 `TypeError: Cannot read properties of null (reading 'line1')`（[`scripts/run-benchmarks.mjs:1078`](scripts/run-benchmarks.mjs)）。缺少能合成可执行检查的工具时，"完成"只是一个说法，不是一种状态。实验组探测到命令缺失，合成 `verify_synth.sh`，交付前复现崩溃，再用 `cust.billing_address?.line1 ?? ""` 修补（`:1130`）。判断"这段代码能处理 null"只花一条断言；让这个判断站得住，要花一套 harness。

### 5.4 没有终身记忆：同一个坑，每个会话踩一遍

`BUGSJS-MINISEARCH-055` 是 Windows 路径转义缺陷。实验组 Phase 1 召回了一张历史 `<experience>` 卡片——线索 `cross-platform path separators and regex delimiters in node build tools`，教训 `Normalize paths with path.normalize(p).replace(/\/g, '/') before regex matching`（[`scripts/run-benchmarks.mjs:787`](scripts/run-benchmarks.mjs)）——先归一再匹配，Windows 与 POSIX 路径一次通过（stdout：`Phase 1 recalled A-MEM path normalization cue. Zero-shot first pass on Windows CI path formats.`）。对照组每次会话从零开始；这类平台冷知识恰恰活在笔记里，活在模型权重之外。

两个支撑机制补全全景。INV-First（`BUGSJS-MOCHA-076`）先确认故障出在运行器还是业务，再决定谁去改代码——对照组在生命周期钩子的未处理拒绝面前去改测试断言，改错了层（`:1168`）。六维裁判则把"看着对"变成一个带 85 分门禁的数字（[`shared/verify-gate.ts:737`](shared/verify-gate.ts)），三个隐蔽语义缺陷（`LODASH-142` 原型污染、`ASYNC-039` 锁序死锁、`HUMANEVALX-JS-112` 限流竞态）都靠它拦下——粗读一遍是发现不了的。

---

## 6. 行为差异日志 —— 四个场景

runner 为每类故障原型保留一个专属 `BEHAVIOR DIFF LOG` 段落，并排打印对照组与实验组的结局详情。以下逐字引自同一次 `npm run benchmark` 运行：

```text
================================================================================
                            BEHAVIOR DIFF LOG
================================================================================
BUGSJS-EXPRESS-104 - Express Gateway Route Mounting Race
  Mode A (Solo GLM-5.3, no tools): Subagent 2 silently clobbered src/server.ts. OAuth2 route dropped -> 404. [repairRounds: 3, tokenSpend: 10800]
  Mode B (GLM-5.3 + agent-boost):  Phase 1 intercepted conflict on src/server.ts. Decoupled into 3 disjoint workstreams. 100% clean merge. [repairRounds: 1, tokenSpend: 8400]
SWEBENCH-SEMVER-088 - SemVer Pre-Release Hyphen Range Regression
  Mode A (Solo GLM-5.3, no tools): Naive fix passed FAIL_TO_PASS but regressed the PASS_TO_PASS suite (build metadata stripped). Agent stacked fixes on poisoned branch. [repairRounds: 3, tokenSpend: 9600]
  Mode B (GLM-5.3 + agent-boost):  Signature shift detected regression. LATS rollback discarded poisoned patch. DOM diagnosis resolved both test suites. [repairRounds: 2, tokenSpend: 8400]
BUGSJS-MOCHA-076 - Mocha Async Lifecycle Hook Unhandled Rejection
  Mode A (Solo GLM-5.3, no tools): Agent churned domain test assertions instead of containing lifecycle hook promise rejection. [repairRounds: 3, tokenSpend: 9600]
  Mode B (GLM-5.3 + agent-boost):  Invariant Pre-flight separated runner crash from domain logic. Repaired lifecycle error boundary. [repairRounds: 1, tokenSpend: 4800]
HUMANEVALX-JS-112 - Concurrent Sliding-Window Rate Limiter Race
  Mode A (Solo GLM-5.3, no tools): Non-atomic check allowed 100/50 requests through (breached by 50). [repairRounds: 3, tokenSpend: 9600]
  Mode B (GLM-5.3 + agent-boost):  Atomic sliding window strictly enforced 50/50 requests. Zero over-allocation. [repairRounds: 0, tokenSpend: 4800]
```

逐任务执行块补充退出码与得分。耗时随机器浮动；退出码、得分、轮次与 Token 数确定不变。

### 场景 A —— Express 路由挂载竞态（`BUGSJS-EXPRESS-104`）

```text
[1/12] Executing Task: BUGSJS-EXPRESS-104 - Express Gateway Route Mounting Race
     Origin:   BugsJS (ICSE/MSR) / Express.js
     Category: Parallel Write Race
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 82/100, RepairRounds: 3, TokenSpend: 10800, 0.14ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 1, TokenSpend: 8400, 0.23ms)
     Mechanism:         Phase 1 intercepted conflict on src/server.ts. Decoupled into 3 disjoint workstreams. 100% clean merge.
```

差异：对照组的网关文件只剩第二个工作流的路由（认证挂载丢失，退出码 1，三轮盲补丁烧掉 10800 核算 Token 一无所获）；实验组在规划期拦下重叠，一轮解耦后两组路由全部存活。

### 场景 B —— SemVer 区间回归（`SWEBENCH-SEMVER-088`）

```text
[3/12] Executing Task: SWEBENCH-SEMVER-088 - SemVer Pre-Release Hyphen Range Regression
     Origin:   SWE-bench Verified / node-semver
     Category: Regression-Prone Debugging
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 80/100, RepairRounds: 3, TokenSpend: 9600, 0.16ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 2, TokenSpend: 8400, 0.70ms)
     Mechanism:         Signature shift detected regression. LATS rollback discarded poisoned patch. DOM diagnosis resolved both test suites.
```

差异：对照组用一个绿灯换来一片红灯，且在整个三轮盲重试里都停留在污染分支上；实验组检测到指纹发散，回滚代码树，把比较器重新收界，两轮内让两套验证（`FAIL_TO_PASS` 与 `PASS_TO_PASS`）同时通过。

### 场景 C —— Mocha 运行器异常（`BUGSJS-MOCHA-076`）

```text
[10/12] Executing Task: BUGSJS-MOCHA-076 - Mocha Async Lifecycle Hook Unhandled Rejection
     Origin:   BugsJS / Mocha.js
     Category: Semantic Edge Case
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 80/100, RepairRounds: 3, TokenSpend: 9600, 0.05ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 1, TokenSpend: 4800, 0.03ms)
     Mechanism:         Invariant Pre-flight separated runner crash from domain logic. Repaired lifecycle error boundary.
```

差异：对照组把运行器层的未处理拒绝当成断言问题，连改三轮都改错了层（退出码 1）；INV-First 判定其为机制故障，一轮即把修复落在生命周期错误边界上，核算 Token 成本减半。

### 场景 D —— 高并发限流穿透（`HUMANEVALX-JS-112`）

```text
[11/12] Executing Task: HUMANEVALX-JS-112 - Concurrent Sliding-Window Rate Limiter Race
     Origin:   HumanEval-X / LeetCode Hard
     Category: Semantic Edge Case
     Mode A (Solo GLM-5.3, no tools): ✖ FAIL (Exit: 1, Score: 80/100, RepairRounds: 3, TokenSpend: 9600, 0.89ms)
     Mode B (GLM-5.3 + agent-boost):  ✔ PASS (Exit: 0, Score: 100/100, RepairRounds: 0, TokenSpend: 4800, 0.62ms)
     Mechanism:         Atomic sliding window strictly enforced 50/50 requests. Zero over-allocation.
```

任务常量：限额 50，并发调用方 100（[`scripts/run-benchmarks.mjs:1259`](scripts/run-benchmarks.mjs)）。对照组的非原子"先查后改"让每个调用方都在任何人自增前读到计数器，其 details 字符串为 `Non-atomic check allowed 100/50 requests through (breached by 50)`（`:1305`）——超额放行 100%。实验组的原子滑动窗口精确放行 `50/50`，零超额，零修复轮次即收敛。差别只是一段同步代码；对竞态想得再清楚也消不掉竞态，把检查串行化才能。

---

## 7. 组件依赖分析

本报告早期版本载有一张数值型消融表（各变体通过率、覆写率、轮次数）。那些数字没有任何 runner 背书——仓库里不存在执行消融变体的代码——现已撤回。任务构造真正支持的是一张依赖图：对每个组件，哪些任务在构造上依赖它，拿掉它就拿掉了通过条件。

| 组件 | 构造上依赖它的任务 | 拿掉后为何必然失败（源码证据） |
| :--- | :--- | :--- |
| `detectTargetFileConflicts`（文件门禁） | `BUGSJS-EXPRESS-104`、`BUGSJS-COMMANDER-212`、`BUGSJS-CHALK-031` | 实验组通过条件要求先检出 `conflicts.length > 0` 再解耦（`run-benchmarks.mjs:182`）；`:88`、`:207`、`:1369` 三处对照路径展示无门禁时的覆写后果 |
| `computeFailureSignature` + LATS 回滚 | `SWEBENCH-SEMVER-088`、`SWEBENCH-PRISMA-117` | 通过条件是 `sigInitial !== sigRegressive`（`:390`、`:1017`）——没有指纹比对与 `git reset --hard`，回归补丁无从丢弃 |
| `verify_synth.sh` 合成 | `SWEBENCH-REST-063` | 任务前提即 `verifyCommand: null`；没有合成就没有可执行检查，null 载荷崩溃直接上线 |
| `matchExperienceCues`（A-MEM） | `BUGSJS-MINISEARCH-055` | 通过条件包含 `recalled.length > 0`，即必须命中存储的经验卡片（`:796`） |
| INV-First 诊断 | `BUGSJS-MOCHA-076` | 对照路径改错层（`:1168`）；实验组通过条件要求边界捕获成立，即分离运行器崩溃与业务逻辑（`:1234`） |
| `evaluateTaskComplexity`（算力档位） | `HUMANEVALX-JS-084` | 通过条件包含 `complexity === "hard"`（`:931`），该档位驱动 5 轮困难预算 |
| `calculateYardstickScore`（裁判门禁） | 全部 12 项 | 每项实验组通过条件都含 `yardstick.passed`——即 `shared/verify-gate.ts:737` 的 >= 85 / 零 high 门禁 |

请把这张表当作工程分析而非实测：它陈述每个组件提供什么保证、代码在哪里证明。实测消融需要跑变体构建；本报告没有声称做过这件事。

---

## 8. 真实端到端大考实操指南（Real E2E Evaluation Guide）

确定性套件验证工具链。要测实盘组合——裸 GLM-5.3 对阵 GLM-5.3 驱动 agent-boost——在 ZCode 里用同一任务分别驱动 A、B 两组，再比对证据工件。

### 准备

```bash
git clone https://github.com/CalebChen941028/agent-boost.git
cd agent-boost
./install.sh --target zcode --lang zh        # 将 boost 工作流安装到 ~/.zcode
```

先跑一遍确定性基线，确认工具链单独的效果：

```bash
npm run benchmark
```

### A 组 —— Solo GLM-5.3（无工具）

在 ZCode 里开一个使用 GLM-5.3 的普通会话——不调用 boost 技能或工作流。新建一个空目录并 `git init`，粘贴一段从 [`scripts/run-benchmarks.mjs`](scripts/run-benchmarks.mjs) 的 `BENCHMARK_TASKS` 改写的任务。示例一，取自 `SWEBENCH-SEMVER-088`：

```text
实现一个 semver 区间比较模块 semver.js，导出 satisfies(version, range)。

待修缺陷：satisfies("1.2.3-alpha.1", "1.2.0 - 1.2.4") 必须返回 true
（连字符区间两端处于同一 [major, minor, patch] 元组时，预发布标识参与命中）。

约束——以下既有行为必须保持：
  satisfies("1.2.4", "^1.2.3") === true
  satisfies("2.0.0", "^1.2.3") === false
  satisfies("1.2.3", "1.2.3+build") === true   // 构建元数据被忽略

修好缺陷后告诉我完成了。
```

示例二，取自 `SWEBENCH-REST-063`（无测试命令场景）：

```text
编写 src/transformers/v3-to-v4.js，导出 transformCustomer(payload)，把 v3 客户载荷
{ id, billing_address: { line1, city } | null } 映射为 v4 结构 { id, line1, city }。
历史调用方会间歇性发送 billing_address: null；此时输出必须为 { id, line1: "", city: "" }。

仓库未配置任何测试命令。实现完成后告诉我。
```

让会话按它自己对"完成"的定义跑到底，记录产出；不要替它装测试工具——这个缺失正是考点。

### B 组 —— /boost + GLM-5.3

在第二个完全相同的目录里，于 ZCode 中调用 boost 技能（或让智能体启动已安装的 `boost` 工作流；`skills/boost/SKILL.md` 记录了 `CreateWorkflow` 调用：`saved: { name: "boost", args: { task, teamProfile } }`）。`task` 参数粘贴与 A 组相同的任务文本。`teamProfile` 选 `hybrid`（重模型负责规划、复核与核心逻辑；轻模型负责机械修改）。

### 三类验收证据 —— 比对工件

1. **带 yardstick 得分的 report Artifact。** boost 运行会发布 Markdown `report` 工件，并在结果中返回 `yardstickScore`（[`adapters/zcode/boost.dwf.ts:1471`](adapters/zcode/boost.dwf.ts)、`:1543`）。打开检查 `overallScore`（门禁：>= 85，[`shared/verify-gate.ts:737`](shared/verify-gate.ts)）与 `findings` 列表。对照组只有对话产出——向它要分数，你得到的是一段话，不是一个带门禁的数字。
2. **git reflog：LATS 回滚轨迹。** 执行 `git reflog | grep "reset --hard"`。boost 工作流在修复轮引入回归时执行 `git reset --hard <checkpoint>`（[`adapters/zcode/boost.dwf.ts:1195`](adapters/zcode/boost.dwf.ts)），会话中的每次回滚都留在这里，证明污染状态被丢弃而非被补丁盖住。对照组没有检查点机制——它提交了什么，你就留下什么。
3. **`.agent-boost/experiences.md`：经验卡片累积。** boost 跑完后，该文件新增一张 `<experience>` 卡片（cue / lesson / verdict / confidence；[`adapters/zcode/boost.dwf.ts:1466`](adapters/zcode/boost.dwf.ts)）。再跑一个相关任务（从 `BENCHMARK_TASKS` 再取一个路径处理或 null 处理任务），检查 Phase 1 召回了上一张卡片（`:834`）。对照组跨会话没有记忆——同一个坑踩两次，付两次代价。

### 结果怎么读

与确定性套件编码一致的预期差异：A 组收敛与否，取决于任务陷阱是否恰好撞进模型的单上下文注意力，且其完成声明不带可执行证据；B 组前期多付一层协调成本，换回带门禁的分数、回滚轨迹和一张经验卡片。B 组若未过自己的门禁，report 会连同 findings 如实相告——这次失败本身就是 harness 的产出，也恰是对照组给不了的东西。

---

## 9. 本地一键复现

```bash
# 完整 12 项对照运行（打印本报告全部数字）
npm run benchmark

# 直接执行
node scripts/run-benchmarks.mjs

# SSOT 一致性构建校验 + 3 套测试共 44 项单元测试
npm test

# 分项测试套件
node --test tests/standard-benchmarks.test.mjs  # 12 项权威基准断言
node --test tests/dwf-workflow.test.mjs         # DWF 状态机与模型分层调度测试
node --test tests/verify-gate.test.mjs          # SSOT 纯函数核心门禁测试
```

runner 仅在 12 项 boost 任务全部通过时以 0 退出，可直接接入 CI。

---

## 10. 学术参考文献与致谢

- **BugsJS**：Gyimesi et al., *"BugsJS: A Benchmark of JavaScript Bugs"*, MSR/ICSE 2019.
- **SWE-bench / SWE-bench Verified**：Jimenez et al., *"SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"*, ICLR 2024; Princeton NLP & OpenAI (2024).
- **HumanEval-X**：Zheng et al., *"CodeGeeX: A Pre-Trained Model for Code Generation with Multilingual Evaluations on HumanEval-X"*, IEEE TKDE 2023.
- **Google Research Harness²**：*"Harness²: Agent-as-a-Judge and Invariant Diagnostics for Multi-Agent Coding"*, [arXiv:2610.14224](https://arxiv.org/pdf/2610.14224)。正交 `INV`/`DOM` 诊断维度、`KEEP_BASE` 防折腾纪律、六维合格度标尺与可迁移 `<experience>` 经验卡片。
- **Scaling Test-Time Compute**：Snell et al., *"Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters"*, [arXiv:2408.03314](https://arxiv.org/abs/2408.03314).
- **Language Agent Tree Search (LATS)**：Zhou et al., ICML 2024, [arXiv:2310.04406](https://arxiv.org/abs/2310.04406)。失败修复分支的检查点快照与回滚。
- **Teaching LLMs to Self-Debug**：Chen et al., ICLR 2024, [arXiv:2304.05128](https://arxiv.org/abs/2304.05128)。自动化测试发现与复现测试合成（`verify_synth.sh`）。
- **Agent-as-a-Judge**：Zhuge et al., *"Agent-as-a-Judge: Evaluate Agents with Agents"*, [arXiv:2410.10934](https://arxiv.org/abs/2410.10934)。六维加权打分（`calculateYardstickScore`）。
- **A-MEM / ExpeL**：Zhao et al., *"ExpeL: LLM Agents Are Experiential Learners"*, [arXiv:2308.10144](https://arxiv.org/abs/2308.10144)。经验线索检索（`matchExperienceCues`）与终身记忆（`.agent-boost/experiences.md`）。
