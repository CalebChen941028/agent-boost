# Contributing to agent-boost

[English](#english) | [中文](#中文)

---

## English

Thank you for contributing to `agent-boost`!

### Guidelines
1. **Core Verification Logic**: Any changes to `shared/verify-gate.ts` must maintain zero third-party dependencies and pass all tests in `tests/`.
2. **Deterministic Behavior**: Ensure signature computation remains robust against varying timestamps, file paths, and memory addresses.
3. **Tests**:
   ```bash
   node --test tests/verify-gate.test.mjs
   ```

---

## 中文

感谢参与 `agent-boost` 项目贡献！

### 贡献准则
1. **核心关卡逻辑**：对 `shared/verify-gate.ts` 的任何改动必须保持零外部依赖，并通过 `tests/` 下的全部测试。
2. **确定性保障**：确保失败特征指纹提取能够稳定过滤时间戳、路径与内存地址波动。
3. **测试命令**：
   ```bash
   node --test tests/verify-gate.test.mjs
   ```
