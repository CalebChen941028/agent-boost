# agent-boost（深度多智能体推理攻坚）

[![CI](https://github.com/CalebChen941028/agent-boost/actions/workflows/ci.yml/badge.svg)](https://github.com/CalebChen941028/agent-boost/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18+-blue.svg)](https://nodejs.org/)

**面向复杂工程疑难的多智能体推理、分层并行执行与确定性验收修复工作流。**

用于攻克单 agent 难以胜任的高难度工程任务（隐蔽竞态、算法难题、跨多文件复杂重构、深层回归缺陷）。通过专家四问规划、独立因果评审、混合编队分层执行、确定性验收关卡、停滞根因诊断与换人独立复核，形成闭环保障。

---

## 核心流程

```
[任务输入]
   │
   ▼
1. 方案规划与独立评审
   ├── 方案规划：顶尖专家四问补齐一手材料与工具 + 评估更激进的验收线
   └── 方案评审：独立质疑任务前提中未经验证的因果判断，规避做错方向
   │
   ▼
2. 混合编队分层并行执行
   ├── 核心逻辑与疑难调查分配强模型
   └── 机械样板、文档与配置下沉轻量模型（allSettled + 失败升级重试）
   │
   ▼
3. 确定性验证关卡与停滞检测
   ├── 合并 stdout/stderr 并截取末尾 2000 字符（完整保留断言与堆栈）
   ├── 尾部 20 行去波动特征指纹对比（杜绝测试运行器首行静态标题误判）
   └── 连续相同错误特征触发「根因诊断员」深度排查，指导最小修复
   │
   ▼
4. 换人独立复核
   └── 未参与实现的复核员通读真实代码改动，严查回归、遗漏与陈述不实
   │
   ▼
5. 综合报告与客观结论文案
   └── 结论文案综合考量验收缺口与复核 high 级缺陷，拒绝盲目声称完成
```

---

## v0.2.0 关键缺陷修复

- **B1 (客观结论文案)**：修复复核员发现 high 级致命缺陷时结论文案依然盲目输出“已完成并通过验证”的严重错误。
- **B2 (保留失败输出尾部)**：修复此前截取头部丢失关键错误堆栈的缺陷；合并两路输出并精准保留末尾 2000 字符。
- **B3 (特征指纹归一化)**：针对 `npm test`、`pytest` 等首行固定导致停滞误判的缺陷，抽取末尾 20 行去除时间戳、内存地址与路径后的规范化指纹。
- **B4 (中立复验提示)**：复验轮次不再向验收员声称“上一轮缺口已修复”，改为“修复同事声称已处理，请独立复验”。
- **B5 (执行容错与升级)**：改用 `Promise.allSettled`，执行异常的工作流由强模型自动重试一次，不再因单项抛错中断整次运行。
- **B7 (编队档位枚举校验)**：严格校验 `teamProfile`（`hybrid` / `quality` / `economy`），非法参数直接报错。

---

## 安装说明

### ZCode 动态工作流
```bash
./install.sh --target zcode --lang zh
```

### Claude Code CLI / 通用环境
```bash
./install.sh --target claude
./install.sh --target generic --dest /path/to/project
```

---

## 单测执行

直接运行内置单元测试：

```bash
node --test tests/verify-gate.test.mjs
```

---

## 致谢与参考

- **Magentic-One**：停滞自适应与换人诊断机制思路来源。
- **claude-flow**：多智能体编排边界与共享状态机制参考。
- **Felix Rieseberg**：顶尖专家四问与激进验收线提议方法参考。

---

## 商标与免责声明

Antigravity 是 Google LLC 的商标。本项目为独立开源社区作品，与 Google LLC 或 Anthropic 无任何关联，亦未获得其官方授权或背书。

---

## 许可证

[MIT](LICENSE) © 2026 Liangliang Chen
