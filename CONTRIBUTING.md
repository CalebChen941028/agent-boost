# Contributing to agent-boost

[English](#english) | [简体中文](#中文)

---

## English

Thank you for contributing to `agent-boost`!

### Guidelines
1. **Single Source of Truth (SSOT) & Zero Dependencies**: Any changes to pure verification functions in `shared/verify-gate.ts` must maintain zero third-party dependencies and stay 100% body-identical across `shared/verify-gate.ts`, `shared/verify-gate.js`, and `adapters/zcode/boost.dwf.ts`.
2. **Bilingual Parity**: All role prompts (`roles/*.en.md` and `roles/*.zh.md`), adapters (`adapters/*`), and documentation (`README.md` and `README.zh-CN.md`) must maintain English and Chinese parity.
3. **Clean Room & Privacy Compliance**: Never commit personal API keys, `models.local.json`, internal provider gateway URLs, or proprietary company identifiers.
4. **Verification Commands**:
   ```bash
   npm test
   npm run benchmark:selftest
   ```

---

## 中文

感谢参与 `agent-boost` 开源项目贡献！

### 贡献准则
1. **单一真源（SSOT）与零外部依赖**：对 `shared/verify-gate.ts` 纯函数的任何修改必须保持零第三方依赖，并确保 `shared/verify-gate.ts`、`shared/verify-gate.js` 与 `adapters/zcode/boost.dwf.ts` 三处实现 100% 一致。
2. **中英双语对齐**：所有角色提示词（`roles/*.en.md` 与 `roles/*.zh.md`）、多端适配器（`adapters/*`）及说明文档（`README.md` 与 `README.zh-CN.md`）均需保持中英双语同步。
3. **开源合规与隐私保护**：严禁提交个人密钥、`models.local.json`、内部私有网关前缀或未授权的专有标识。
4. **本地验证命令**：
   ```bash
   npm test
   npm run benchmark:selftest
   ```
