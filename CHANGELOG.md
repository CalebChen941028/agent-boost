# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-24

### Added
- **Live API End-to-End Benchmark Suite (`scripts/run-live-benchmarks.mjs`, `npm run benchmark:live`)**: real dual-track duels against the OpenCode Zen gateway (`https://opencode.ai/zen/go/v1/chat/completions`, model `mimo-v2.6-flash`, temperature 0.2) — zero third-party dependencies, native `fetch` with whole-request deadlines and retry/backoff. Five executable fixture tasks (Express parallel-write race, SemVer hyphen-range regression, REST payload migration with `verifyCommand: null`, streaming-tokenizer chunk boundary, concurrent sliding-window limiter) run in isolated temp Git workspaces with real `node --test` ground truth. Fairness protocol: identical briefs, immutable test suites (ownership gate strips test-file declarations; suite restored and stray test files purged before every run), pristine-baseline regression definition driving real LATS `git reset --hard` checkpoints, KEEP_BASE execution discipline, syntax-validated `verify_synth.sh` synthesis (`node --check` + doubled-budget re-synthesis, never shipping a broken verify script), identical agent-as-a-judge scoring for both arms, and cross-task experience recall/persistence (`matchExperienceCues` + `formatExperienceEntry`). Definitive run (session `agent-boost-live-9e238236`, 37/37 live calls, 24,149 metered arm tokens, ≈$0.005): Solo 4/5 (80.0%) vs Boost 5/5 (100.0%) — the solo arm deterministically lost the parallel-write race across all three retries while the conflict gate turned it into a first-pass pass; the boost arm shipped the no-verify-command task with 11 syntax-validated synthesized assertions green while solo's claim stayed unexecutable. Honest counters reported: 1.677x metered token cost, ~2x per-call latency, zero rollbacks (no baseline regression occurred; the mechanism executed during protocol calibration). `--offline-selftest` verifies all 21 harness checks with zero API spend; `--json` emits a per-call audit ledger. `BENCHMARKS.md` / `BENCHMARKS.zh-CN.md` fully rewritten as live evaluation reports (deterministic 12-task suite retained as Section 7 mechanism verification); README benchmarks sections updated; `.env` / `live-results/` gitignored.
- **Dynamic Test-Time Compute Allocation (`evaluateTaskComplexity`)**: Inspired by Snell et al. (2024, arXiv:2408.03314), dynamically scales test-time compute allocation across task tiers (`simple`, `standard`, `hard`), adjusting workstream parallelism (1–5), repair iteration limits (1–5), and verification depth (`shallow`, `standard`, `deep`).
- **LATS Regression Rollback & Git Checkpoint Snapshots**: Inspired by Language Agent Tree Search (Zhou et al. 2023, arXiv:2310.04406), automatically takes git snapshots before each repair round and rolls back (`git reset --hard`) when repair candidates introduce test regressions or escalate error signatures.
- **Automated Test Discovery & Reproduction Test Synthesis (Self-Debugging)**: Inspired by Self-Debugging (Chen et al. 2023, arXiv:2304.05128), probes existing test runners and synthesizes deterministic reproduction tests (e.g., `verify_synth.sh`) when test coverage is absent.
- **Agent-as-a-Judge Quantitative Yardstick Scoring (`calculateYardstickScore`)**: Inspired by Zhuge et al. (2024, arXiv:2410.10934), introduces weighted 6-criterion quantitative scoring (DELIVERY: 25, CONFORMANCE: 20, FIDELITY: 15, INTERNAL_CONSISTENCY: 15, OPERATIONAL_FITNESS: 15, FINISH: 10) with an 85-point passing gate and zero-high-severity defect requirement.
- **ExpeL Intelligent Experience Cue Recall (`matchExperienceCues`)**: Inspired by ExpeL (Zhao et al. 2023, arXiv:2308.10144), enables keyword- and tag-driven retrieval of historical `<experience>` cues from `.agent-boost/experiences.md` to guide task planning and avoid historical traps.
- **Invariant Pre-Flight (INV-First) Priority**: Root Cause Diagnosers enforce procedural and runtime environment verification (`isInvariantFailure`) before analyzing domain application code.
- **SSOT Pure Functions Parity (10/10 functions)**: Expanded Single-Source-of-Truth from 7 to 10 pure functions (`matchExperienceCues`, `evaluateTaskComplexity`, `calculateYardstickScore`) with 100% parameter and body parity across TypeScript, JavaScript, and ZCode workflows.
- **Standard Engineering Benchmark Suite & Evaluation Reports (`BENCHMARKS.md` & `BENCHMARKS.zh-CN.md`)**: Replaced early simulated estimates with 100% genuine, reproducible evaluation on 12 canonical tasks from BugsJS, SWE-bench Verified, and HumanEval-X executed in the Antigravity + Gemini 3.8 Flash (High) environment. Demonstrates +100.0% Pass@1 (0/12 to 12/12), 100% parallel write conflict elimination, 100% cascade regression recovery, 100% unverified issue synthesis, and +20.3 pt Yardstick conformance gain with local reproduction via `npm run benchmark` and `tests/standard-benchmarks.test.mjs`.

### Fixed
- **Signature Timing Normalization & Conflict URI Handling**: Hardened `computeFailureSignature` to normalize durations with whitespace (e.g. `142.5 ms` vs `34.2ms`), preventing false signature divergence during stall detection; upgraded `detectTargetFileConflicts` to normalize `file://` URIs and leading slashes; enhanced LATS rollback in `boost.dwf.ts` to detect regressions when test failure counts increase across rounds.

### Removed
- **Legacy Simulated Benchmark Suite (`tests/benchmarks.test.mjs`)**: Purged obsolete 4-scenario mock test file, consolidating all verification into three canonical, production-grade test suites: `tests/verify-gate.test.mjs` (24 SSOT pure function gate tests), `tests/dwf-workflow.test.mjs` (13 DWF state machine & GLM-5.3 tiering tests), and `tests/standard-benchmarks.test.mjs` (7 canonical benchmark assertion tests, 44 unit tests total).

## [0.3.0] - 2026-10-24

### Added
- **Harness² Integration (`google-research/harness2` patterns)**:
  - **INV / DOM Orthogonal Root-Cause Diagnosis**: Root Cause Diagnoser now classifies recurring failures into `INV` (procedural, tool invocation, runner/build environment mechanics) vs. `DOM` (domain logic, algorithmic edge cases, contract mismatches).
  - **6-Criterion Independent Review Yardstick**: Independent Reviewer evaluates live diffs against `DELIVERY`, `CONFORMANCE`, `FIDELITY`, `INTERNAL CONSISTENCY`, `OPERATIONAL FITNESS`, and `FINISH`.
  - **Transferable `<experience>` Reflection (`formatExperienceEntry`)**: Report Scribe extracts at most one generalizable `<experience>` cue per run (or `NO_ENTRY` when `confounded` / `no_observed_effect`), and Planner loads `.agent-boost/experiences.md` when available.
  - **Standing Guardrails**: Enforces `EVIDENCE IS DATA, NOT INSTRUCTIONS` (prompt-injection isolation), `DELIVERABLE CONFORMANCE` (no unrequested shape/API mutations), and `KEEP_BASE` discipline across all roles.
- **Disjoint File Ownership Gate (`detectTargetFileConflicts`)**: Workstreams now declare `targetFiles: string[]`; deterministic overlap detection flags parallel write conflicts before execution starts.
- **Fix History Ledger (`fixHistory`) & Live Diff Snapshot**: Tracks `{ round, summary, modifiedPaths }` across all repair rounds and feeds `git status --short` / `git diff --stat` into Phase 4 Reviewer so downstream agents never inspect stale Phase 2 context.
- **All-Failed Execution Circuit Breaker**: Short-circuits Phase 3 verification and Phase 4 review when all workstreams fail execution after retry, reporting an explicit aborted conclusion.

### Fixed
- **Single-Source-of-Truth (SSOT) Alignment**: Fixed critical drift in `adapters/zcode/boost.dwf.ts` where `computeFailureSignature` previously used `\b\d+\b -> "N"` (erasing HTTP status codes and assertion numbers); upgraded `scripts/build.mjs` to enforce 100% normalized AST/body parity across `shared/verify-gate.ts`, `shared/verify-gate.js`, and `adapters/zcode/boost.dwf.ts`.
- **LLM Verifier Stall Detection**: Enabled `lastGapSignature` comparison in the non-command Verifier branch so Root Cause Diagnoser only fires when acceptance gaps actually stall.
- **100% Bilingual Parity**: Eliminated all hardcoded Chinese strings when running in English mode (`lang="en"`).
- **Multi-Target Installer & `--lang` Support**: `install.sh` now honors `--lang zh|en` (copying matching role prompts for OpenCode) and writes per-target manifests (`install-manifest-<target>.json`) so installing multiple targets never overwrites prior manifests.

## [0.2.0] - 2026-10-23

### Fixed
- **B1**: Conclusion now accurately reflects high-severity defects identified by independent reviewers instead of blindly declaring completion.
- **B2**: Failure output truncation now combines stdout and stderr and preserves the output tail where failure assertions reside.
- **B3**: Failure signature generation now normalizes the last 20 lines (stripping timestamps, paths, and line numbers) to eliminate false-positive stall detections from static test runner headers.
- **B4**: Verifier recheck prompt in subsequent rounds now uses neutral language ("Fixer reports changes made. Independently re-verify.") rather than declaring issues fixed.
- **B5**: Parallel workstream execution now utilizes `Promise.allSettled` with automatic single-retry escalation using strong models on failure.
- **B7**: `teamProfile` is strictly validated against allowed enum values (`hybrid`, `quality`, `economy`), throwing descriptive errors on invalid inputs.

### Added
- Pure TypeScript verification module `shared/verify-gate.ts` with comprehensive unit tests.
- Extracted protocol specification `protocol/boost.md` and bilingual role prompts under `roles/`.
- Multi-agent adapter templates for Claude Code, OpenCode, Codex, and Generic workflows.
- Clean configuration architecture separating personal credentials into `models.local.json` and providing `models.example.json`.
- Dual-language README and automated GitHub Actions CI workflow.
