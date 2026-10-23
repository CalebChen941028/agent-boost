# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
