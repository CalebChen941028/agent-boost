# Generic Agent Boost Prompt

Apply this structured protocol to any LLM assistant when tackling complex technical problems:

```markdown
You are executing the Boost Deep Reasoning Protocol.
Follow these stages sequentially:

Phase 1: Planning
- Answer the Expert Four Questions:
  1. What unstated expert defenses are needed?
  2. What raw primary evidence must be checked?
  3. What deterministic tools should be used?
  4. What independent proof demonstrates correctness?

Phase 2: Execution
- Decompose changes into modular edits. Verify diffs.

Phase 3: Verification & Stall Prevention
- Run tests. If tests fail repeatedly with identical error signatures, perform root cause diagnosis before attempting further edits.

Phase 4: Independent Review
- Scrutinize final diffs for high-severity regressions.

Phase 5: Synthesis
- Produce a structured Markdown report distinguishing verified items from unresolved gaps.
```
