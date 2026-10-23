/* zcode-workflow
description: Boost 深度推理（混合编队 + 专家四问深度增强）：方案规划按顶尖专家四问补齐原始材料与方法、主动提议更激进的验收线，评审质疑任务前提中未经验证的因果判断 → 并行执行（强/轻模型分层，allSettled容错）→ 验证关卡+停滞检测与根因诊断 → 换人复核 → 汇总报告。
whenToUse: 用户输入 /boost，或对确有难度的任务要求深度多智能体推理时。简单小改动不要用。
args:
  task:
    type: string
    description: 要攻克的任务描述，含目标与验收标准
    required: true
  verifyCommand:
    type: string
    description: 确定性验收命令；最多 3 轮修复循环，连续同样失败先根因诊断。留空则由独立验收员自行挑选仓库现有最强检查
    required: false
    default: ""
  teamProfile:
    type: string
    description: 编队档位：hybrid（规划者按难度分层，机械/文档类用轻量模型）/ quality（全强模型）/ economy（全部执行下沉轻量模型）；把关角色永不降级
    required: false
    default: hybrid
  lightModel:
    type: string
    description: 轻量模型 id 或别名（仅 hybrid/economy 档生效）；留空则默认继承强模型或本地配置
    required: false
    default: ""
  context:
    type: string
    description: 补充背景：约束、相关文件、已知线索
    required: false
    default: ""
  lang:
    type: string
    description: 语言偏好：auto / zh / en
    required: false
    default: auto
*/

interface Workstream {
  title: string;
  detail: string;
  kind: "code" | "investigate";
  tier: "heavy" | "light";
}

interface Plan {
  understanding: string;
  workstreams: Workstream[];
}

interface PlanCritique {
  hasBlockingIssues: boolean;
  issues: string[];
}

interface WorkstreamResult {
  title: string;
  summary: string;
  paths: string[];
  notes: string;
}

interface AcceptanceCheck {
  passed: boolean;
  evidence: string;
  gaps: string[];
}

interface ReviewFinding {
  what: string;
  evidence: string;
  severity: "low" | "medium" | "high";
  status: "verified" | "unconfirmed";
}

interface WorkflowReport {
  conclusion: string;
  findings: ReviewFinding[];
  verified: string[];
  notCovered: string[];
}

// B7: Validate teamProfile enum
const rawTeamProfile = String(args.teamProfile ?? "hybrid").trim().toLowerCase();
if (rawTeamProfile !== "hybrid" && rawTeamProfile !== "quality" && rawTeamProfile !== "economy") {
  throw new Error(`非法 teamProfile「${args.teamProfile}」：仅支持 hybrid、quality、economy`);
}
const teamProfile: "hybrid" | "quality" | "economy" = rawTeamProfile;

const task = String(args.task ?? "").trim();
if (!task) throw new Error("缺少 task 参数");

const verifyCommand = String(args.verifyCommand ?? "").trim();
const context = String(args.context ?? "").trim();
const MAX_FIX_ROUNDS = 3;

// Language determination
const rawLang = String(args.lang ?? "auto").trim().toLowerCase();
const isEn = rawLang === "en" || (rawLang === "auto" && !/[\u4e00-\u9fff]/.test(task));

// Pure helper: combine stdout+stderr and preserve TAIL (B2)
function formatFailureOutput(out: string = "", err: string = "", maxLen: number = 2000): string {
  const o = (out || "").trim();
  const e = (err || "").trim();
  const combined = o && e ? `${o}\n--- stderr ---\n${e}` : (o || e);
  if (combined.length <= maxLen) return combined;
  return combined.slice(-maxLen);
}

// Pure helper: normalized failure signature over last 20 lines (B3)
function computeFailureSignature(output: string): string {
  if (!output || !output.trim()) return "empty";
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "empty";
  return lines.slice(-20).map((line) => {
    return line
      .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/gi, "")
      .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "")
      .replace(/0x[a-f0-9]+/gi, "0xHEX")
      .replace(/:\d+:\d+/g, ":L:C")
      .replace(/:\d+/g, ":L")
      .replace(/\bline \d+\b/gi, "line N")
      .replace(/\b\d+(\.\d+)?(ms|s|m|%)\b/gi, "NUM_UNIT")
      .replace(/\b\d+\b/g, "N")
      .replace(/(?:\/[\w.-]+){2,}/g, "/PATH")
      .trim();
  }).filter((l) => l.length > 0).join(" | ");
}

// Light model tier resolution (clean, support models.local.json per B11)
let localModelConfig: any = null;
try {
  const cfgRes = await world.run("sh", [
    "-c",
    "cat models.local.json 2>/dev/null || cat ~/.config/agent-boost/models.local.json 2>/dev/null || true",
  ]);
  if (cfgRes.exitCode === 0 && cfgRes.stdout.trim()) {
    localModelConfig = JSON.parse(cfgRes.stdout.trim());
  }
} catch {
  // Ignore config reading errors, fall back to args
}

const lightModelArg = String(args.lightModel ?? "").trim();
let pickedLightId = "";
if (lightModelArg) {
  if (localModelConfig?.models?.[lightModelArg]?.id) {
    pickedLightId = localModelConfig.models[lightModelArg].id;
  } else {
    pickedLightId = lightModelArg;
  }
} else if (localModelConfig?.default_light_model) {
  const def = localModelConfig.default_light_model;
  pickedLightId = localModelConfig.models?.[def]?.id ?? def;
}

const lightTier: AgentOptions = pickedLightId ? { model: model(pickedLightId) } : {};

phase(isEn ? "Plan solution & independent critique" : "制定方案并独立评审");

const planner = agent(isEn ? "Solution Planner" : "方案规划", {
  system: isEn
    ? "You are a senior systems architect. Inspect workspace files (read-only) then decompose the task into parallel workstreams. Before decomposing, answer the Expert Four Questions in each workstream detail: 1) What unstated expert defenses are required? 2) What raw evidence must be examined? 3) What deterministic tools to use? 4) What independent proof confirms correctness? In understanding, evaluate whether an aggressive stretch acceptance line is feasible."
    : "你是资深工程师。先读工作区里与任务相关的文件，再把任务拆成可并行的工作流。拆解前先按顶尖专家标准自问四个问题，并把答案写进各条工作流的 detail：1) 最顶尖的人会做哪些未要求的事？2) 从哪些一手材料入手？3) 用什么具体工具？4) 何种独立证明判定正确？在 understanding 里评估激进验收线是否可行。",
});

const planPrompt = isEn
  ? `Task: ${task}\n${context ? `Context: ${context}\n` : ""}Decompose task into workstreams. Mark tier: light only for mechanical/boilerplate changes; heavy for core logic. Propose aggressive stretch criteria in understanding if feasible.`
  : `任务：${task}\n${context ? `补充背景：${context}\n` : ""}先勘察工作区（只读），再给出方案。任务很小时给 1 条工作流即可。为每条工作流标 tier：机械/样板标 light，核心逻辑与疑难调查标 heavy。并在 understanding 里评估更激进的验收线建议。`;

const plan = await planner.ask<Plan>(planPrompt);
log(isEn ? `Plan ready: ${plan.workstreams.length} workstreams` : `方案：${plan.understanding}；拆成 ${plan.workstreams.length} 条工作流`);

const critic = agent(isEn ? "Plan Critic" : "方案评审", {
  system: isEn
    ? "You are a rigorous plan reviewer. Inspect real code in read-only mode. Challenge unproven causal assumptions in the task premise before code changes occur. Identify risks of rework or missed acceptance points."
    : "你是苛刻的方案评审。亲自读相关文件核对方案（不要改文件），只挑会导致返工、遗漏验收点或文件冲突的问题。检查任务前提中是否有未经验证的因果判断，要求先从原始材料复现或证伪。",
});

const critiquePrompt = isEn
  ? `Task: ${task}\nReview the proposed plan against workspace reality:\n${JSON.stringify(plan)}`
  : `任务是：${task}\n请评审以下方案，先自己读相关文件再下结论：\n${JSON.stringify(plan)}`;

const critique = await critic.ask<PlanCritique>(critiquePrompt);

const finalPlan =
  critique.hasBlockingIssues && critique.issues.length > 0
    ? await planner.ask<Plan>(
        isEn
          ? `Reviewer noted blocking issues. Revise plan addressing each:\n${critique.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
          : `评审人提出以下问题，请逐条吸收后给出修订方案：\n${critique.issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      )
    : plan;

phase(isEn ? "Execute parallel workstreams" : "并行推进各条工作流");

// B5: Promise.allSettled with retry on failure
const settledResults = await Promise.allSettled(
  finalPlan.workstreams.map(async (ws, i) => {
    const useLight = teamProfile === "economy" || (teamProfile === "hybrid" && ws.tier === "light");
    const name = `${isEn ? "Worker" : "执行"}-${i + 1}-${ws.title}`;
    const executor = agent(name, {
      system: ws.kind === "code"
        ? (isEn ? "Modify only files within your assigned responsibility. Re-read files to self-check. Report blockers truthfully." : "只改你职责内的文件；完成后重读自查。做不完或有误如实写在 notes 里。")
        : (isEn ? "Investigation only. Never modify files. Provide verified citations." : "只调查，不改文件。结论给出可核对证据。"),
      ...(useLight ? lightTier : {}),
    });

    try {
      return await executor.ask<WorkstreamResult>(
        `${isEn ? "Task" : "整体任务"}：${task}\n${isEn ? "Your workstream" : "你负责的工作流"}：\n${JSON.stringify(ws)}\n${context ? `Context: ${context}\n` : ""}`,
      );
    } catch (err: any) {
      log(`工作流「${ws.title}」执行异常，升级强模型重试一次...`);
      // Retry once with default strong model
      const retryExecutor = agent(`${name}-retry`, {
        system: ws.kind === "code"
          ? "你负责重试失败的工作流。只改动职责内文件并核对。"
          : "你负责重试调查工作流。只读调查并给出证据。",
      });
      return await retryExecutor.ask<WorkstreamResult>(
        `前次执行失败重试。\n整体任务：${task}\n工作流：\n${JSON.stringify(ws)}`,
      );
    }
  }),
);

const results: WorkstreamResult[] = settledResults.map((r, idx) => {
  if (r.status === "fulfilled") {
    report({ what: r.value.summary, where: r.value.paths.join("、"), notes: r.value.notes });
    return r.value;
  }
  const fallbackResult: WorkstreamResult = {
    title: finalPlan.workstreams[idx].title,
    summary: `Execution failed: ${String(r.reason)}`,
    paths: [],
    notes: "Worker failed after retry",
  };
  report({ what: fallbackResult.summary, where: "", notes: fallbackResult.notes });
  return fallbackResult;
});

phase(isEn ? "Verification & targeted repair loop" : "验证并修复到通过");

const fixer = agent(isEn ? "Targeted Fixer" : "修复", {
  system: isEn
    ? "Restore acceptance checks to pass. Keep changes minimal. Never bypass checks or perform opportunistic refactors."
    : "你负责让验收重新通过。改动尽量小、不绕过检查、不顺手重构。如果验收标准本身不可能满足，如实说明而不是造假。",
});

const diagnoser = agent(isEn ? "Root Cause Diagnoser" : "根因诊断", {
  system: isEn
    ? "Diagnose core root causes of recurring test failures. Inspect failure logs and code in read-only mode. Provide minimal repair path."
    : "你是根因诊断员（借鉴 Magentic-One 停滞自适应）。不要修改任何文件；亲自读代码与失败输出，诊断根本诱因并提供最小修复路径。",
});

let checkEvidence = "";
let gaps: string[] = [];

if (verifyCommand) {
  let lastFail = "";
  let lastSignature = "";
  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    const gate = await world.run("sh", ["-c", verifyCommand]);
    if (gate.exitCode === 0) {
      checkEvidence = `${verifyCommand} passed (Round ${round}, exit 0)`;
      gaps = [];
      lastFail = "";
      break;
    }

    // B2: combine stdout+stderr and take tail
    const failOut = formatFailureOutput(gate.stdout, gate.stderr, 2000);
    lastFail = `${verifyCommand} (exit ${gate.exitCode}):\n${failOut}`;

    // B3: normalized failure signature over tail 20 lines
    const signature = computeFailureSignature(failOut);

    if (round < MAX_FIX_ROUNDS) {
      if (signature !== "empty" && signature === lastSignature) {
        log(`连续两轮失败特征相同（停滞），先请根因诊断再修`);
        const diagnosis = await diagnoser.ask<string>(
          `验收命令连续失败且错误特征相同，此前修复未触及根因。失败输出：\n${lastFail}\n请诊断根因并给出最小修复路径。`,
        );
        await fixer.ask(
          `根因诊断员结论与修复路径：\n${diagnosis}\n请按此修复。失败输出：\n${lastFail}`,
        );
      } else {
        log(`验证未通过（第 ${round} 轮），交给修复同事`);
        await fixer.ask(`验收命令失败，请修复。失败输出：\n${lastFail}`);
      }
      lastSignature = signature;
    }
  }
  if (lastFail) {
    gaps = [lastFail];
    checkEvidence = lastFail;
  }
} else {
  const verifier = agent(isEn ? "Independent Verifier" : "独立验收", {
    system: isEn
      ? "Run strongest existing tests or verify criteria item-by-item against actual code diffs. Never modify files."
      : "你是验收员。优先运行仓库现有最强检查，只凭自己运行后的输出下结论；无命令则逐条核对标准。不要修改文件。",
  });
  let lastGapSignature = "";
  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    // B4: Neutral recheck prompt
    const recheckPrompt = isEn
      ? `Task & criteria: ${task}\nResults: ${JSON.stringify(results)}${
          round > 1 ? `\n(Round ${round}: Fixer reports changes made. Independently re-verify.)` : ""
        }\nPerform independent acceptance.`
      : `任务与验收标准：${task}\n各工作流的结果：${JSON.stringify(results)}${
          round > 1 ? `\n（这是第 ${round} 轮复验，修复同事声称已处理，请独立复验）` : ""
        }\n请独立验收。`;

    const check = await verifier.ask<AcceptanceCheck>(recheckPrompt);
    checkEvidence = check.evidence;
    if (check.passed) {
      gaps = [];
      break;
    }
    gaps = check.gaps;
    if (round < MAX_FIX_ROUNDS) {
      if (round > 1) {
        log(isEn ? `Verification gaps persist on round ${round}: invoking root cause diagnoser directly` : `验收缺口在第 ${round} 轮仍未解决：LLM 缺口直接调用根因诊断`);
        const diagnosis = await diagnoser.ask<string>(
          isEn
            ? `Acceptance gaps remain after initial repair. Gaps:\n${check.gaps.join("\n")}\nDiagnose root cause and give minimal repair path.`
            : `以下验收缺口经修复后仍未解决，此前修复未触及根因。缺口：\n${check.gaps.join("\n")}\n请诊断根因并给出最小修复路径。`,
        );
        await fixer.ask(
          isEn
            ? `Root cause diagnosis:\n${diagnosis}\nRepair these gaps:\n${check.gaps.join("\n")}`
            : `根因诊断结论与修复路径：\n${diagnosis}\n请按此修复缺口：\n${check.gaps.join("\n")}`,
        );
      } else {
        log(`验收发现 ${check.gaps.length} 个缺口，交给修复同事`);
        await fixer.ask(`验收发现以下缺口，请逐条修复：\n${check.gaps.join("\n")}`);
      }
    }
  }
}

phase(isEn ? "Independent review of final diffs" : "换人复核最终改动");

const reviewer = agent(isEn ? "Independent Reviewer" : "独立复核", {
  system: isEn
    ? "Independent code review. Inspect real diffs in read-only mode for regressions, omissions, and discrepancies. Assign 'high' only to functional bugs, crashes, or unmet criteria."
    : "你是没有参与实现的复核员，代表用户把关。亲自读工作区真实代码与改动，找遗漏、回归与报告不实。实质严重问题标 high 级。",
});

const finalReview = await reviewer.ask<ReviewFinding[]>(
  `${isEn ? "Task" : "任务"}：${task}\n${isEn ? "Results" : "各工作流报告"}：${JSON.stringify(results)}\n${isEn ? "Verification evidence" : "验证证据"}：${checkEvidence}\n${
    gaps.length > 0 ? (isEn ? "Warning: Unresolved acceptance gaps exist.\n" : "注意：验证尚有未解决的缺口。\n") : ""
  }${isEn ? "Return findings list (or empty array if no issues found)." : "返回发现的问题列表（没有问题返回空数组）。"}`,
);

for (const f of finalReview) {
  report(f);
}

phase(isEn ? "Synthesize and generate report" : "汇总并产出报告");

const scribe = agent(isEn ? "Report Scribe" : "报告撰写", {
  system: isEn
    ? "Synthesize findings into user-facing markdown report. Distinguish verified from unverified components."
    : "你把团队的完整过程汇总成给用户看的 Markdown 报告。区分已验证与未验证，给出改动清单与建议。",
  ...(teamProfile === "quality" ? {} : lightTier),
});

const reportMd = await scribe.ask<string>(
  `撰写最终报告全文（直接返回 Markdown 文本，不要写文件）。\n任务：${task}\n最终方案：${JSON.stringify(finalPlan)}\n工作流结果：${JSON.stringify(results)}\n验证证据：${checkEvidence || "无"}\n未解决缺口：${JSON.stringify(gaps)}\n复核发现：${JSON.stringify(finalReview)}`,
);

await artifact.markdown("report", reportMd, {
  title: isEn ? "Boost Deep Reasoning Report" : "Boost 深度推理报告",
  description: isEn ? "Full audit record of plan, execution, verification, and review." : "方案、执行、验证与独立复核的完整记录。",
  primary: true,
});

const findings: ReviewFinding[] = [...finalReview];
for (const g of gaps) {
  findings.push({
    what: `验收缺口未解决：${g.split("\n")[0]}`,
    evidence: g,
    severity: "high",
    status: "verified",
  });
}

const verified: string[] = [];
if (checkEvidence) verified.push(`验收：${checkEvidence}`);
verified.push(`独立复核：复核员审查了代码改动（提出 ${finalReview.length} 条意见）`);

const notCovered: string[] = [];
if (!verifyCommand) notCovered.push("未提供 verifyCommand，由独立验收员挑选现有检查代替");
if (gaps.length > 0) notCovered.push("存在未解决的验收缺口（见 findings）");

// B1: Conclusion reflects both gaps and high-severity review findings
const highReviewFindings = finalReview.filter((f) => f.severity === "high");
const shortTask = [...task].slice(0, 60).join("");

let conclusion = "";
if (gaps.length > 0 && highReviewFindings.length > 0) {
  conclusion = isEn
    ? `Task "${shortTask}" incomplete: ${gaps.length} verification gap(s) and ${highReviewFindings.length} high-severity defect(s) pending.`
    : `任务「${shortTask}」实施完成但验收未通过且存在 ${highReviewFindings.length} 项高危缺陷，详见报告与 findings。`;
} else if (gaps.length > 0) {
  conclusion = isEn
    ? `Task "${shortTask}" implemented but verification incomplete: ${gaps.length} gap(s) remaining.`
    : `任务「${shortTask}」已实现但验收未全过：${gaps.length} 个缺口待处理，详见报告与 findings。`;
} else if (highReviewFindings.length > 0) {
  conclusion = isEn
    ? `Task "${shortTask}" workstreams landed, but independent review identified ${highReviewFindings.length} high-severity defect(s).`
    : `任务「${shortTask}」各工作流已落地，但独立复核发现 ${highReviewFindings.length} 项高危缺陷未解决，不能视为已完成。`;
} else {
  conclusion = isEn
    ? `Task "${shortTask}" successfully completed and verified: ${results.length} workstream(s) landed; review noted ${finalReview.length} feedback item(s).`
    : `任务「${shortTask}」已完成并通过验证：${results.length} 条工作流落地，独立复核提出 ${finalReview.length} 条意见。`;
}

return { conclusion, findings, verified, notCovered };
