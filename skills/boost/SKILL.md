---
name: boost
description: >-
  Boost multi-agent deep reasoning & verification engine (powered by Magentic-One stall adaptation,
  Expert Four Questions, and Google Research Harness² INV/DOM reflection). Solves hard bugs, race
  conditions, algorithm challenges, cross-file refactorings, and recurring regressions. Workflow:
  solution planning & disjoint targetFiles gate → parallel execution (allSettled + retry + circuit
  breaker) → deterministic verification & INV/DOM root-cause diagnosis → fresh 6-criterion reviewer
  → synthesized report & transferable <experience> cue.
  Boost 深度推理：用多智能体工作流攻克硬问题（复杂 bug、竞态条件、算法难题、跨文件疑难重构、根因不明的问题）。
  流程：方案规划与独立评审（专家四问 + targetFiles 冲突门禁） → 并行工作流执行（allSettled 容错与失败熔断） →
  验证关卡+修复轨迹账本+INV/DOM 双维度根因诊断 → 换人六维标尺复核 → 汇总报告与 Harness² 跨任务经验沉淀。
---

# Boost — Multi-Agent Deep Reasoning & Verification Engine / 深度多智能体推理引擎

Inspired by publicly documented multi-agent orchestration patterns (**Microsoft Magentic-One**, **claude-flow**, **Felix Rieseberg**'s Expert Four Questions, and **Google Research Harness²** recursive adaptation & experience reflection). Independent open-source implementation, not affiliated with or endorsed by Google LLC or Anthropic.

概念受公开文档化的多智能体编排工作流启发（融合 Microsoft **Magentic-One**、**claude-flow**、**Felix Rieseberg** 专家四问以及 **Google Research Harness²** 递归自适应与经验沉淀体系）。独立开源实现，与 Google LLC 或 Anthropic 无关联、未获其背书。

---

## 1. Multi-Agent Runtime Dispatch / 多平台运行调度协议

Automatically detect the host agent runtime and execute the corresponding protocol:
根据当前宿主 Agent 环境自动选择对应的执行方式：

### A. ZCode Dynamic Workflow (`boost.dwf.ts`)
1. **Profile Selection / 档位选择**: Call `ListModels` to inspect available models (`[current]` marks the active session model), then prompt the user to select `teamProfile`:
   - **`hybrid` (Recommended / 推荐)**: Heavy model for Planner, Critic, Diagnoser, Fixer, Verifier, Reviewer, and core-logic workstreams; Light model for mechanical/boilerplate workstreams and Scribe.
   - **`quality` (All-Heavy / 全强)**: Heavy model for all roles and workstreams. Best for critical algorithms and security-sensitive tasks.
   - **`economy` (Cost-Saving / 省钱)**: Light model for all execution workstreams; Heavy model retained for quality gates (Planner, Critic, Diagnoser, Verifier, Reviewer).
2. **Launch / 启动**: Call `CreateWorkflow`:
   ```json
   {
     "saved": {
       "name": "boost",
       "args": {
         "task": "...",
         "teamProfile": "hybrid",
         "lightModel": "",
         "verifyCommand": "npm test",
         "lang": "auto"
       }
     }
   }
   ```

### B. Claude Code CLI / Subagent Environments (`.claude/commands/boost.md`)
- Orchestrate the 5 phases using native `Task` / subagent spawning for parallel `Workstream` execution and independent `Reviewer` verification, following the full protocol in `adapters/claude-code/boost.md`.

### C. OpenCode (`adapters/opencode/agents.json`)
- Dispatch to the 8 specialized role configurations (`planner`, `critic`, `executor`, `verifier`, `diagnoser`, `fixer`, `reviewer`, `scribe`) bound to bilingual prompts in `roles/*.en.md` or `roles/*.zh.md`.

### D. Codex CLI & Generic Single-Agent Environments (`adapters/codex/protocol.md`, `adapters/generic/boost.md`)
- Execute the 5-phase state machine sequentially by explicitly switching role personas (`[Role: Solution Planner]` $\rightarrow$ `[Role: Plan Critic]` $\rightarrow$ `[Role: Workstream Executor]` $\rightarrow$ `[Role: Independent Verifier / Diagnoser / Fixer]` $\rightarrow$ `[Role: Independent Reviewer]` $\rightarrow$ `[Role: Report Scribe]`).

---

## 2. Architecture & Gate Mechanics / 核心关卡机制

1. **Expert Four Questions & Disjoint File Gate (`targetFiles` / 专家四问与文件边界门禁)**:
   - Before decomposing workstreams, the Planner answers four questions in each workstream's `detail` (unstated expert defenses, first-hand raw evidence, deterministic tools, independent proof), evaluates stretch acceptance criteria, and declares explicit `targetFiles: string[]` per `code` workstream.
   - `detectTargetFileConflicts` deterministically blocks overlapping `targetFiles` across parallel workers before any file is modified.
2. **Independent Causal Critique & `KEEP_BASE` Discipline (独立因果评审与 `KEEP_BASE` 克制原则)**:
   - The Critic inspects real workspace code in read-only mode and challenges unproven causal assumptions in the task premise.
   - Following Harness² `KEEP_BASE` discipline, if the initial plan is grounded and conflict-free, the Critic approves it without inventing unnecessary churn.
3. **Fault-Tolerant Parallel Execution & Circuit Breaker (`Promise.allSettled` + 全败熔断)**:
   - Parallel workstreams run via `Promise.allSettled`; any rejected workstream automatically escalates to a strong model for 1x retry.
   - If all workstreams fail after retry, the engine trips the circuit breaker, skipping Phase 3 and Phase 4 to avoid wasting tokens and reporting an explicit aborted conclusion.
4. **Deterministic Verification Gate & Fix History Ledger (`fixHistory` / 确定性验证与修复账本)**:
   - Runs `verifyCommand` (up to 3 rounds), preserving the **last 2000 characters** of combined `stdout` + `stderr` (retaining assertion stack traces).
   - Every repair round appends a structured `FixRecord` (`round`, `summary`, `modifiedPaths`) to `fixHistory`, passed alongside live `git status --short` / `git diff --stat` to downstream Verifier, Reviewer, and Scribe.
5. **Stall Detection & Harness² `INV`/`DOM` Diagnosis (停滞检测与双维度根因诊断)**:
   - Computes a DJB2-hashed normalized signature over the last 20 lines (preserving HTTP status codes and semantic assertion numbers while stripping timestamps, hex addresses, file paths, and 4+ digit PIDs).
   - On consecutive identical signatures, escalates to the Root-Cause Diagnoser, which classifies the defect into **`INV`** (procedure, tool/runner invocation, build state) vs. **`DOM`** (domain logic, algorithmic edge cases) before minimal repair.
6. **Independent 6-Criterion Review (换人六维标尺复核)**:
   - Fresh Reviewer evaluates live workspace diffs against the Harness² 6-criterion yardstick: `DELIVERY`, `CONFORMANCE`, `FIDELITY`, `INTERNAL CONSISTENCY`, `OPERATIONAL FITNESS`, and `FINISH`.
   - Functional bugs, crashes, or contract violations are marked `high` severity and directly block success claims in `formatConclusion`.
7. **Harness² Transferable `<experience>` Reflection (跨任务可迁移经验沉淀)**:
   - Scribe extracts at most one generalizable `<experience>` cue (`formatExperienceEntry`), automatically filtering out `confounded` or `no_observed_effect` edits (`NO_ENTRY`).
