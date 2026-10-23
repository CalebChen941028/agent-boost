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

  const sig1 = computeFailureSignature(runnerOutput1);
  const sig2 = computeFailureSignature(runnerOutput2);

  assert.equal(sig1, sig2, "Volatile paths, pids, durations, and addresses must normalize to the same signature");
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
    default_light_model: "glm-flash",
    models: {
      "glm-flash": { id: "z-ai/glm-5.3-flash", tier: "light" },
      "qwen-flash": { id: "qwen/qwen3.8-flash", tier: "light" },
    },
  };

  const resolvedAlias = resolveModelConfiguration("qwen-flash", config);
  assert.equal(resolvedAlias.modelId, "qwen/qwen3.8-flash");
  assert.equal(resolvedAlias.tier, "light");

  const resolvedDefault = resolveModelConfiguration("", config);
  assert.equal(resolvedDefault.modelId, "z-ai/glm-5.3-flash");
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
  ];

  const conflicts = detectTargetFileConflicts(workstreams);
  assert.equal(conflicts.length, 3);

  const appConflict = conflicts.find((c) => c.file.toLowerCase() === "src/app.ts");
  assert.ok(appConflict, "Conflict must be detected for src/app.ts despite backslashes and case");
  assert.equal(appConflict.workstreams.length, 3);
  assert.ok(appConflict.workstreams.includes("Windows paths"));
  assert.ok(appConflict.workstreams.includes("POSIX paths"));
  assert.ok(appConflict.workstreams.includes("Case variation"));

  const helperConflict = conflicts.find((c) => c.file.toLowerCase() === "src/utils/helper.ts");
  assert.ok(helperConflict, "Conflict must be detected for multiple/trailing slashes");
  assert.equal(helperConflict.workstreams.length, 2);

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
  assert.ok(out.includes("✔ All 7 shared verify-gate functions are 100% parameter- and body-identical"));
  assert.ok(out.includes("Build verification successful!"));
});
