import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  formatFailureOutput,
  computeFailureSignature,
  detectTargetFileConflicts,
  formatConclusion,
  validateTeamProfile,
  resolveModelConfiguration,
  formatExperienceEntry,
  matchExperienceCues,
  evaluateTaskComplexity,
  calculateYardstickScore,
} from "../shared/verify-gate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("formatFailureOutput preserves tail instead of head", () => {
  const head = "FIRST_LINE_INITIAL_SETUP_LOGS\n".repeat(50);
  const tail = "ASSERTION_FAILED: expected true but got false at test.js:42\n".repeat(5);
  const combined = head + tail;

  const result = formatFailureOutput(combined, "", 150);
  assert.ok(!result.includes("FIRST_LINE_INITIAL_SETUP_LOGS"), "Head lines should be truncated");
  assert.ok(result.includes("ASSERTION_FAILED"), "Tail assertion must be retained");
});

test("computeFailureSignature normalizes volatile lines and ignores static header", () => {
  const runnerOutput1 = `
> my-pkg@1.0.0 test
TAP version 13
# Subtest: test suite
    at /Users/test/workspace/repo/src/index.js:104:12 (pid: 12345 in 14.5ms)
    AssertionError [ERR_ASSERTION]: expected 200 == 500 at 0x7ffee1234567
    not ok 1 - test failed
`;

  const runnerOutput2 = `
> my-pkg@1.0.0 test
TAP version 13
# Subtest: test suite
    at /var/jenkins/workspace/repo/src/index.js:205:99 (pid: 99881 in 98.2ms)
    AssertionError [ERR_ASSERTION]: expected 200 == 500 at 0x7faab9876543
    not ok 1 - test failed
`;

  const runnerOutput3 = `
> my-pkg@1.0.0 test
TAP version 13
# Subtest: test suite
    at /var/jenkins/workspace/repo/src/index.js:205:99 (pid: 99881 in 98.2 ms)
    AssertionError [ERR_ASSERTION]: expected 200 == 500 at 0x7faab9876543
    not ok 1 - test failed
`;

  const sig1 = computeFailureSignature(runnerOutput1);
  const sig2 = computeFailureSignature(runnerOutput2);
  const sig3 = computeFailureSignature(runnerOutput3);

  assert.equal(sig1, sig2, "Volatile paths, pids, durations, and addresses must normalize to the same signature");
  assert.equal(sig1, sig3, "Durations with whitespace (98.2 ms vs 14.5ms) must normalize to identical signature");
});

test("computeFailureSignature distinguishes different failures including HTTP status codes", () => {
  const failA = "Error: Connection refused to database at 127.0.0.1:5432";
  const failB = "SyntaxError: Unexpected token '}' in parser.js";
  const failHttp200 = "AssertionError: expected status 200 to equal 500";
  const failHttp404 = "AssertionError: expected status 404 to equal 200";

  assert.notEqual(computeFailureSignature(failA), computeFailureSignature(failB));
  assert.notEqual(
    computeFailureSignature(failHttp200),
    computeFailureSignature(failHttp404),
    "Small semantic numbers like HTTP status codes (200 vs 404) must not be erased into identical signatures",
  );
});

test("detectTargetFileConflicts catches overlapping files in parallel code workstreams", () => {
  const workstreams = [
    { title: "Auth refactor", kind: "code", targetFiles: ["./src/auth.ts", "src/utils.ts"] },
    { title: "Logging update", kind: "code", targetFiles: ["src/auth.ts", "src/logger.ts"] },
    { title: "Read-only audit", kind: "investigate", targetFiles: ["src/auth.ts"] },
  ];

  const conflicts = detectTargetFileConflicts(workstreams);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].file, "src/auth.ts");
  assert.deepEqual(conflicts[0].workstreams, ["Auth refactor", "Logging update"]);
});

test("formatConclusion reflects high severity review findings (B1 fix)", () => {
  const result = formatConclusion(
    "Implement auth module",
    2,
    [
      {
        what: "Security bypass in JWT validation",
        evidence: "auth.js:45",
        severity: "high",
        status: "verified",
      },
    ],
    [], // no gaps
    "zh",
  );

  assert.equal(result.hasBlockingIssues, true);
  assert.ok(result.conclusion.includes("未闭环问题"));
  assert.ok(result.conclusion.includes("高风险复核缺陷"));
  assert.ok(!result.conclusion.includes("已完成并通过验证"), "Must not falsely claim full completion");
});

test("formatConclusion reports aborted when all workstreams fail execution", () => {
  const resZh = formatConclusion("Refactor core", 3, [], [], "zh", 3);
  assert.equal(resZh.hasBlockingIssues, true);
  assert.ok(resZh.conclusion.includes("执行中止"));

  const resEn = formatConclusion("Refactor core", 2, [], [], "en", 2);
  assert.equal(resEn.hasBlockingIssues, true);
  assert.ok(resEn.conclusion.includes("aborted"));
});

test("formatConclusion reports success when no gaps, no high defects, and no failed workstreams", () => {
  const result = formatConclusion(
    "Implement auth module",
    2,
    [
      {
        what: "Minor typo in comment",
        evidence: "auth.js:12",
        severity: "low",
        status: "verified",
      },
    ],
    [],
    "zh",
    0,
  );

  assert.equal(result.hasBlockingIssues, false);
  assert.ok(result.conclusion.includes("已完成并通过验证"));
});

test("validateTeamProfile rejects invalid profile (B7 fix)", () => {
  assert.equal(validateTeamProfile("HYBRID"), "hybrid");
  assert.equal(validateTeamProfile("quality"), "quality");
  assert.equal(validateTeamProfile("economy"), "economy");

  assert.throws(() => validateTeamProfile("super-fast"), /Invalid teamProfile/);
});

test("resolveModelConfiguration maps aliases and defaults from config (B11 fix)", () => {
  const config = {
    default_light_model: "mimo-flash",
    models: {
      "mimo-flash": { id: "opencode/mimo-v2.6-flash", tier: "light" },
      "qwen-flash": { id: "qwen/qwen3.8-flash", tier: "light" },
    },
  };

  const resolvedAlias = resolveModelConfiguration("qwen-flash", config);
  assert.equal(resolvedAlias.modelId, "qwen/qwen3.8-flash");
  assert.equal(resolvedAlias.tier, "light");

  const resolvedDefault = resolveModelConfiguration("", config);
  assert.equal(resolvedDefault.modelId, "opencode/mimo-v2.6-flash");
  assert.equal(resolvedDefault.tier, "light");
});

test("formatExperienceEntry filters confounded cues and formats valid Harness² cues", () => {
  assert.equal(formatExperienceEntry(null), "NO_ENTRY");
  assert.equal(
    formatExperienceEntry({
      cue: "Multiple files edited",
      lesson: "Unknown",
      dimension: "DOM",
      verdict: "confounded",
      confidence: "low",
      evidence: "round 1",
    }),
    "NO_ENTRY",
  );

  const valid = formatExperienceEntry({
    cue: "When parallel code workstreams touch shared barrel index files",
    lesson: "Assign barrel exports to a single workstream targetFiles list",
    dimension: "INV",
    verdict: "helped",
    confidence: "high",
    evidence: "Prevented overwrite in Phase 2",
  });
  assert.ok(valid.includes("<experience>"));
  assert.ok(valid.includes("dimension: INV"));
  assert.ok(valid.includes("verdict: helped"));
});

test("build.mjs verifies 100% function body parity across TS, JS, and boost.dwf.ts", () => {
  const out = execFileSync(process.execPath, [path.join(rootDir, "scripts", "build.mjs")], {
    encoding: "utf8",
  });
  assert.ok(out.includes("Build verification successful!"));
});

test("install.sh and uninstall.sh support multi-target manifests (opencode, claude, codex, deepseek, workbuddy) and --lang flag", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-boost-test-"));
  try {
    const env = { ...process.env, HOME: tmpHome };
    // Install opencode with zh language
    execFileSync("bash", [path.join(rootDir, "install.sh"), "--target", "opencode", "--lang", "zh"], {
      env,
      encoding: "utf8",
    });

    const agentsJsonPath = path.join(tmpHome, ".opencode", "workflows", "agents.json");
    const plannerZhPath = path.join(tmpHome, ".opencode", "workflows", "roles", "planner.zh.md");
    const manifestOpencode = path.join(
      tmpHome,
      ".local",
      "share",
      "agent-boost",
      "install-manifest-opencode.json",
    );

    assert.ok(fs.existsSync(agentsJsonPath), "agents.json should be installed in ~/.opencode/workflows");
    assert.ok(fs.existsSync(plannerZhPath), "Chinese role prompt should be copied for --lang zh");
    assert.ok(fs.existsSync(manifestOpencode), "Target-specific manifest should be created");

    const agentsContent = fs.readFileSync(agentsJsonPath, "utf8");
    assert.ok(agentsContent.includes("roles/planner.zh.md"), "agents.json must reference .zh.md when --lang zh");

    // Also install claude, codex, deepseek, and workbuddy targets
    for (const target of ["claude", "codex", "deepseek", "workbuddy"]) {
      execFileSync("bash", [path.join(rootDir, "install.sh"), "--target", target, "--lang", "en"], {
        env,
        encoding: "utf8",
      });
    }

    const manifestClaude = path.join(tmpHome, ".local", "share", "agent-boost", "install-manifest-claude.json");
    const manifestDeepseek = path.join(tmpHome, ".local", "share", "agent-boost", "install-manifest-deepseek.json");
    const manifestWorkbuddy = path.join(tmpHome, ".local", "share", "agent-boost", "install-manifest-workbuddy.json");

    assert.ok(fs.existsSync(manifestOpencode), "opencode manifest must survive installing other targets");
    assert.ok(fs.existsSync(manifestClaude), "claude manifest must exist");
    assert.ok(fs.existsSync(manifestDeepseek), "deepseek manifest must exist");
    assert.ok(fs.existsSync(manifestWorkbuddy), "workbuddy manifest must exist");

    // Uninstall only claude
    execFileSync("bash", [path.join(rootDir, "uninstall.sh"), "--target", "claude"], {
      env,
      encoding: "utf8",
    });
    assert.ok(!fs.existsSync(manifestClaude), "claude manifest should be removed");
    assert.ok(fs.existsSync(manifestOpencode), "opencode manifest should remain intact");
    assert.ok(fs.existsSync(manifestDeepseek), "deepseek manifest should remain intact");
    assert.ok(fs.existsSync(manifestWorkbuddy), "workbuddy manifest should remain intact");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("formatFailureOutput handles 0, negative, and NaN maxLength safely", () => {
  assert.equal(formatFailureOutput("hello", "world", 0), "");
  assert.equal(formatFailureOutput("hello", "world", -5), "");
  assert.equal(formatFailureOutput("hello", "world", NaN), "");
  assert.equal(formatFailureOutput("hello", "world", "invalid"), "");
});

test("computeFailureSignature normalizes Windows subdirectories, Python tracebacks, and Go errors", () => {
  const winOutput1 = `
    Error: Failed test
        at C:\\Users\\admin\\repo\\test.py(45)
  `;
  const winOutput2 = `
    Error: Failed test
        at C:\\Users\\admin\\repo\\test.py(55)
  `;
  assert.equal(
    computeFailureSignature(winOutput1),
    computeFailureSignature(winOutput2),
    "Windows subdirectories with different line numbers should have identical signature",
  );

  const pyTraceback1 = `
Traceback (most recent call last):
  File "app.py", line 12, in <module>
    raise ValueError("invalid configuration")
ValueError: invalid configuration
  `;
  const pyTraceback2 = `
Traceback (most recent call last):
  File "app.py", line 99, in <module>
    raise ValueError("invalid configuration")
ValueError: invalid configuration
  `;
  assert.equal(
    computeFailureSignature(pyTraceback1),
    computeFailureSignature(pyTraceback2),
    "Python tracebacks with different line numbers should have identical signature",
  );

  const goError1 = `
--- FAIL: TestProcess (0.02s)
    main_test.go:42: received nil response
FAIL
  `;
  const goError2 = `
--- FAIL: TestProcess (0.05s)
    main_test.go:88: received nil response
FAIL
  `;
  assert.equal(
    computeFailureSignature(goError1),
    computeFailureSignature(goError2),
    "Go test failures with different line numbers should have identical signature",
  );

  const unicodeOutput = `【错误】测试失败：数据库连接超时`;
  const sig = computeFailureSignature(unicodeOutput);
  assert.ok(sig.startsWith("错误_测试失败_数据库连接超时"), "Prefix should support Unicode characters");
});

test("detectTargetFileConflicts handles backslashes, multiple slashes, and case insensitivity", () => {
  const workstreams = [
    {
      title: "Windows paths",
      kind: "code",
      targetFiles: [".\\src\\app.ts", "src//utils//helper.ts/", ".\\\\\\src\\nested.ts"],
    },
    {
      title: "POSIX paths",
      kind: "code",
      targetFiles: ["src/app.ts", "src/utils/helper.ts", ".//src/nested.ts"],
    },
    {
      title: "Case variation",
      kind: "code",
      targetFiles: ["SRC/App.TS", "././src/nested.ts"],
    },
    {
      title: "URI and leading slash",
      kind: "code",
      targetFiles: ["file:///src/app.ts", "/src/utils/helper.ts"],
    },
  ];

  const conflicts = detectTargetFileConflicts(workstreams);
  assert.equal(conflicts.length, 3);

  const appConflict = conflicts.find((c) => c.file.toLowerCase() === "src/app.ts");
  assert.ok(appConflict, "Conflict must be detected for src/app.ts despite backslashes, case, and file:// URIs");
  assert.equal(appConflict.workstreams.length, 4);
  assert.ok(appConflict.workstreams.includes("Windows paths"));
  assert.ok(appConflict.workstreams.includes("POSIX paths"));
  assert.ok(appConflict.workstreams.includes("Case variation"));
  assert.ok(appConflict.workstreams.includes("URI and leading slash"));

  const helperConflict = conflicts.find((c) => c.file.toLowerCase() === "src/utils/helper.ts");
  assert.ok(helperConflict, "Conflict must be detected for multiple/trailing slashes and leading slash");
  assert.equal(helperConflict.workstreams.length, 3);
  assert.ok(helperConflict.workstreams.includes("URI and leading slash"));

  const nestedConflict = conflicts.find((c) => c.file.toLowerCase() === "src/nested.ts");
  assert.ok(nestedConflict, "Conflict must be detected for .//, .\\\\\\, and ././ prefix variations");
  assert.equal(nestedConflict.workstreams.length, 3);
});

test("formatConclusion safely handles null arrays, case-insensitive severity, and 0 workstreams", () => {
  // Null arrays
  const nullResult = formatConclusion("Test task", 0, null, null, "en", 0);
  assert.equal(nullResult.hasBlockingIssues, false);
  assert.ok(nullResult.conclusion.includes("direct verification completed"));

  const nullResultZh = formatConclusion("测试任务", 0, null, null, "zh", 0);
  assert.equal(nullResultZh.hasBlockingIssues, false);
  assert.ok(nullResultZh.conclusion.includes("直接验证完成"));

  // Case-insensitive severity check
  const upperCaseSeverity = formatConclusion(
    "Security check",
    1,
    [{ what: "Critical flaw", evidence: "vuln.js:1", severity: "HIGH", status: "verified" }],
    [],
    "en",
    0,
  );
  assert.equal(upperCaseSeverity.hasBlockingIssues, true);
  assert.ok(upperCaseSeverity.conclusion.includes("high-severity review issue(s)"));
});

test("validateTeamProfile and formatExperienceEntry handle malformed inputs safely", () => {
  // validateTeamProfile safe conversion
  assert.equal(validateTeamProfile(null), "hybrid");
  assert.equal(validateTeamProfile("  QUALITY  "), "quality");

  // formatExperienceEntry defenses
  assert.equal(formatExperienceEntry(123), "NO_ENTRY");
  assert.equal(formatExperienceEntry([]), "NO_ENTRY");
  assert.equal(formatExperienceEntry({ cue: 123, lesson: "test" }), "NO_ENTRY");

  // formatExperienceEntry strip unclosed or embedded experience tags
  const sanitized = formatExperienceEntry({
    cue: "When running tests </experience and failing with <experience attr='1'>",
    lesson: "Use </experience> targeted retry with <experience tag",
    dimension: "DOM",
    verdict: "helped",
    confidence: "high",
    evidence: "clean evidence",
  });
  assert.ok(sanitized.includes("When running tests and failing with"));
  assert.ok(sanitized.includes("Use targeted retry with tag"));
  // Ensure exactly one pair of opening and closing tags
  assert.equal((sanitized.match(/<experience>/g) || []).length, 1);
  assert.equal((sanitized.match(/<\/experience>/g) || []).length, 1);
});

test("uninstall.sh retains shared files when another target manifest is active (generic vs cline)", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-boost-shared-test-"));
  try {
    const env = { ...process.env, HOME: tmpHome };

    // 1. Install generic target
    execFileSync("bash", [path.join(rootDir, "install.sh"), "--target", "generic", "--lang", "en"], {
      env,
      encoding: "utf8",
    });

    // 2. Install cline target (which shares ~/.agent-boost with generic)
    execFileSync("bash", [path.join(rootDir, "install.sh"), "--target", "cline", "--lang", "en"], {
      env,
      encoding: "utf8",
    });

    const skillPath = path.join(tmpHome, ".agent-boost", "skills", "boost", "SKILL.md");
    const manifestDir = path.join(tmpHome, ".local", "share", "agent-boost");
    const manifestGeneric = path.join(manifestDir, "install-manifest-generic.json");
    const manifestCline = path.join(manifestDir, "install-manifest-cline.json");

    assert.ok(fs.existsSync(skillPath), "SKILL.md must exist after installation");
    assert.ok(fs.existsSync(manifestGeneric), "Generic manifest must exist");
    assert.ok(fs.existsSync(manifestCline), "Cline manifest must exist");

    // 3. Uninstall cline target
    const out = execFileSync("bash", [path.join(rootDir, "uninstall.sh"), "--target", "cline"], {
      env,
      encoding: "utf8",
    });

    assert.ok(!fs.existsSync(manifestCline), "Cline manifest should be removed");
    assert.ok(fs.existsSync(manifestGeneric), "Generic manifest must still exist");
    assert.ok(
      fs.existsSync(skillPath),
      "SKILL.md must be retained because generic target is still active and references it",
    );
    assert.ok(out.includes("Retained shared file"), "Uninstall output should note file retention");

    // 4. Uninstall generic target
    execFileSync("bash", [path.join(rootDir, "uninstall.sh"), "--target", "generic"], {
      env,
      encoding: "utf8",
    });

    assert.ok(!fs.existsSync(manifestGeneric), "Generic manifest should be removed");
    assert.ok(!fs.existsSync(skillPath), "SKILL.md should now be removed since no targets reference it");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("uninstall.sh retains shared files when legacy install-manifest.json is active for another target", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-boost-legacy-test-"));
  try {
    const env = { ...process.env, HOME: tmpHome };

    // 1. Install cline target
    execFileSync("bash", [path.join(rootDir, "install.sh"), "--target", "cline", "--lang", "en"], {
      env,
      encoding: "utf8",
    });

    const manifestDir = path.join(tmpHome, ".local", "share", "agent-boost");
    const manifestCline = path.join(manifestDir, "install-manifest-cline.json");
    const legacyManifest = path.join(manifestDir, "install-manifest.json");
    const skillPath = path.join(tmpHome, ".agent-boost", "skills", "boost", "SKILL.md");

    // 2. Simulate pre-existing legacy manifest for 'generic' target referencing shared files
    const legacyData = {
      target: "generic",
      backup_timestamp: "20260101000000",
      files: [skillPath],
    };
    fs.writeFileSync(legacyManifest, JSON.stringify(legacyData, null, 2), "utf8");

    // 3. Uninstall cline target
    const out = execFileSync("bash", [path.join(rootDir, "uninstall.sh"), "--target", "cline"], {
      env,
      encoding: "utf8",
    });

    assert.ok(!fs.existsSync(manifestCline), "Cline manifest should be removed");
    assert.ok(
      fs.existsSync(legacyManifest),
      "Legacy manifest for generic target must NOT be deleted when uninstalling cline",
    );
    assert.ok(
      fs.existsSync(skillPath),
      "SKILL.md must be retained because generic target still references it via legacy manifest",
    );
    assert.ok(out.includes("Retained shared file"), "Uninstall output should note file retention");

    // 4. Uninstall everything (no target flag)
    execFileSync("bash", [path.join(rootDir, "uninstall.sh")], {
      env,
      encoding: "utf8",
    });

    assert.ok(!fs.existsSync(legacyManifest), "Legacy manifest should be cleaned up after full uninstall");
    assert.ok(!fs.existsSync(skillPath), "SKILL.md should now be removed");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("build.mjs lexical scanner handles complex return types, nested template strings, and regex braces", () => {
  // Execute build.mjs directly and ensure it completes cleanly with exit code 0
  const out = execFileSync(process.execPath, [path.join(rootDir, "scripts", "build.mjs")], {
    encoding: "utf8",
  });
  assert.ok(out.includes("✔ All 10 shared verify-gate functions are 100% parameter- and body-identical"));
  assert.ok(out.includes("Build verification successful!"));
});

test("matchExperienceCues intelligently recalls and ranks relevant cues while filtering noise", () => {
  // Empty or invalid inputs
  assert.equal(matchExperienceCues("", "any task"), "");
  assert.equal(matchExperienceCues("some cues", ""), "");
  assert.equal(matchExperienceCues(null, "task"), "");
  assert.equal(matchExperienceCues("cues", "task", 0), "");
  assert.equal(matchExperienceCues("cues", "task", -1), "");
  assert.equal(matchExperienceCues("cues", "task", NaN), "");

  const cueBank = `
<experience>
dimension: INV
cue: When parallel code workstreams touch shared barrel index files
lesson: Assign barrel exports to a single workstream targetFiles list
verdict: helped
confidence: high
evidence: Prevented overwrite in Phase 2
</experience>

<experience>
dimension: DOM
cue: When implementing JWT authentication token expiration
lesson: Enforce clock skew tolerance in verification asserts
verdict: helped
confidence: medium
evidence: Handled timezone jitter in auth tests
</experience>

<experience>
dimension: DOM
cue: Confounded observation on concurrent caching
lesson: Unknown caching effect
verdict: confounded
confidence: low
evidence: Multiple variables changed
</experience>
`;

  // Filter out confounded cues
  const resAuth = matchExperienceCues(cueBank, "Fix token expiration in JWT authentication module", 3);
  assert.ok(resAuth.includes("JWT authentication"));
  assert.ok(!resAuth.includes("Confounded observation"), "Confounded cues must be excluded");

  // Keyword relevance and ranking (barrel exports matches first cue)
  const resBarrel = matchExperienceCues(cueBank, "Refactor barrel index files across modules", 1);
  assert.ok(resBarrel.includes("barrel index files"));
  assert.ok(!resBarrel.includes("JWT authentication"), "Capped at maxCues = 1");

  // No keyword match returns empty string
  const resUnrelated = matchExperienceCues(cueBank, "Completely unrelated quantum mechanics topic", 3);
  assert.equal(resUnrelated, "");

  // CJK Chinese task matching without spaces
  const zhBank = `
<experience>
dimension: DOM
cue: 遇到内存泄漏时排查未清理的定时器
lesson: 检查 setInterval 与事件监听器
verdict: helped
confidence: high
evidence: memory.ts:45
</experience>
<experience>
dimension: INV
cue: 解决并发死锁时使用有序锁获取
lesson: 统一锁获取顺序
verdict: helped
confidence: high
evidence: lock.ts:12
</experience>
`;
  const resZh = matchExperienceCues(zhBank, "排查系统的内存泄漏问题", 1);
  assert.ok(resZh.includes("内存泄漏"), "Chinese query without spaces must recall relevant cue");
  assert.ok(!resZh.includes("并发死锁"));
});

test("evaluateTaskComplexity performs dynamic compute allocation across simple, standard, and hard tiers", () => {
  // Empty or null
  const emptyRes = evaluateTaskComplexity("");
  assert.equal(emptyRes.complexity, "simple");
  assert.equal(emptyRes.maxRepairRounds, 2);
  assert.equal(emptyRes.recommendedProfile, "economy");

  // Simple tasks
  const typoRes = evaluateTaskComplexity("Fix typo in README documentation and bump version", "", 1);
  assert.equal(typoRes.complexity, "simple");
  assert.equal(typoRes.maxRepairRounds, 2);
  assert.equal(typoRes.recommendedProfile, "economy");

  const zhSimple = evaluateTaskComplexity("修改注释和文档格式", "", 1);
  assert.equal(zhSimple.complexity, "simple");
  assert.equal(zhSimple.maxRepairRounds, 2);
  assert.equal(zhSimple.recommendedProfile, "economy");

  // Hard tasks: concurrency, security, memory leak, AST transformation, or many files
  const hardRes1 = evaluateTaskComplexity("Resolve race condition and deadlock in distributed lock manager");
  assert.equal(hardRes1.complexity, "hard");
  assert.equal(hardRes1.maxRepairRounds, 5);
  assert.equal(hardRes1.recommendedProfile, "quality");

  const hardRes2 = evaluateTaskComplexity("Fix privilege escalation security vulnerability in auth protocol");
  assert.equal(hardRes2.complexity, "hard");
  assert.equal(hardRes2.maxRepairRounds, 5);

  const hardResFiles = evaluateTaskComplexity("Refactor user profile service", "", 6);
  assert.equal(hardResFiles.complexity, "hard");
  assert.equal(hardResFiles.maxRepairRounds, 5);

  // Standard tasks
  const stdRes = evaluateTaskComplexity("Implement user avatar upload with file validation", "Include unit tests", 2);
  assert.equal(stdRes.complexity, "standard");
  assert.equal(stdRes.maxRepairRounds, 3);
  assert.equal(stdRes.recommendedProfile, "hybrid");
});

test("calculateYardstickScore quantitatively evaluates 6 Harness² criteria and pass/fail gate", () => {
  // Clean review
  const cleanRes = calculateYardstickScore([]);
  assert.equal(cleanRes.overallScore, 100);
  assert.equal(cleanRes.passed, true);
  assert.equal(cleanRes.deductions.length, 0);
  assert.equal(cleanRes.breakdown.delivery, 100);
  assert.equal(cleanRes.breakdown.conformance, 100);
  assert.equal(cleanRes.breakdown.fidelity, 100);
  assert.equal(cleanRes.breakdown.internalConsistency, 100);
  assert.equal(cleanRes.breakdown.operationalFitness, 100);
  assert.equal(cleanRes.breakdown.finish, 100);

  // High severity failure (e.g. conformance violation)
  const highFinding = [
    {
      what: "Changed public API return signature unexpectedly",
      evidence: "api.ts:15",
      severity: "high",
      status: "verified",
      criterion: "conformance",
    },
  ];
  const failRes = calculateYardstickScore(highFinding);
  assert.equal(failRes.breakdown.conformance, 60); // 100 - 40
  assert.equal(failRes.passed, false, "Any high severity finding must cause pass = false");
  assert.ok(failRes.deductions.length === 1);
  assert.equal(failRes.deductions[0].penalty, 40);

  // Medium and Low findings across criteria with text inference
  const mixedFindings = [
    { what: "Unused import causing type error", evidence: "index.ts:1", severity: "medium" },
    { what: "Residual TODO left in parser helper", evidence: "parser.ts:44", severity: "low" },
    { what: "Missing file requested by spec", evidence: "spec.md", severity: "low" },
  ];
  const mixedRes = calculateYardstickScore(mixedFindings);
  assert.equal(mixedRes.breakdown.internalConsistency, 85);
  assert.equal(mixedRes.breakdown.finish, 95);
  assert.equal(mixedRes.breakdown.delivery, 95);
  assert.equal(mixedRes.overallScore, 96);
  assert.equal(mixedRes.passed, true, "Minor defects without high severity can pass if score >= 85");
  assert.ok(mixedRes.overallScore >= 85);

  // Moderate defects dropping below 85-point threshold without high severity
  const moderateFindings = [
    { what: "Missing critical file 1", evidence: "docs.md", severity: "medium", criterion: "delivery" },
    { what: "Missing critical file 2", evidence: "api.md", severity: "medium", criterion: "delivery" },
    { what: "Schema shape mismatch 1", evidence: "index.ts", severity: "medium", criterion: "conformance" },
    { what: "Schema shape mismatch 2", evidence: "app.ts", severity: "medium", criterion: "conformance" },
    { what: "Unverified claim in docstring", evidence: "app.ts", severity: "medium", criterion: "fidelity" },
  ];
  const modRes = calculateYardstickScore(moderateFindings);
  assert.equal(modRes.overallScore, 84);
  assert.equal(modRes.passed, false, "Score below 85 must fail even without high severity defects");

  // Partial custom weights without omitted keys exceeding 100
  const partialWeights = { delivery: 1, conformance: 1 };
  const partialRes = calculateYardstickScore([], partialWeights);
  assert.equal(partialRes.overallScore, 100, "Partial customWeights must normalize to 100%");

  // Explicit full custom weights
  const customWeights = {
    delivery: 0.5,
    conformance: 0.5,
    fidelity: 0,
    internalConsistency: 0,
    operationalFitness: 0,
    finish: 0,
  };
  const weightedRes = calculateYardstickScore(mixedFindings, customWeights);
  assert.equal(weightedRes.overallScore, 98);
});
