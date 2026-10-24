#!/usr/bin/env node
/**
 * Benchmark Report Generator for agent-boost (v0.4.0)
 *
 * Generates interactive, standalone HTML reports, Gantt execution timelines,
 * and cross-model comparison duels from live benchmark result JSON ledgers.
 * Zero external dependencies.
 *
 * Usage:
 *   node scripts/generate-benchmark-report.mjs [inputFile.json] [outputFile.html]
 *   node scripts/generate-benchmark-report.mjs --compare [runA.json] [runB.json] [output.html]
 *   npm run benchmark:report
 *   npm run benchmark:compare
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtNum(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "0";
  return n.toLocaleString("en-US");
}

/**
 * Common Apple-inspired stylesheet used across single-run and cross-model reports.
 */
export function getReportStyles() {
  return `
    :root {
      --bg: #f5f5f7;
      --card-bg: rgba(255, 255, 255, 0.85);
      --card-border: rgba(0, 0, 0, 0.08);
      --text: #1d1d1f;
      --text-sec: #86868b;
      --accent: #0071e3;
      --accent-hover: #0077ed;
      --success: #34c759;
      --warning: #ff9500;
      --danger: #ff3b30;
      --font-stack: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #000000;
        --card-bg: rgba(28, 28, 30, 0.8);
        --card-border: rgba(255, 255, 255, 0.12);
        --text: #f5f5f7;
        --text-sec: #a1a1a6;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-stack);
      background-color: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 40px 20px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 1140px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 36px;
    }
    .header-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(0, 113, 227, 0.1);
      color: var(--accent);
      margin-bottom: 12px;
    }
    h1 {
      font-size: 38px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .meta-subtitle {
      color: var(--text-sec);
      font-size: 15px;
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
    }
    .meta-item strong { color: var(--text); }
    
    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .metric-card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 24px;
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 24px rgba(0,0,0,0.06);
    }
    .metric-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-sec);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .metric-value-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .metric-big {
      font-size: 34px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .metric-delta {
      font-size: 14px;
      font-weight: 600;
      color: var(--success);
    }
    .metric-desc {
      font-size: 13px;
      color: var(--text-sec);
      margin-top: 6px;
    }

    /* Scoreboard Table */
    .table-card {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      overflow: hidden;
      margin-bottom: 32px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.03);
    }
    .table-header-box {
      padding: 20px 24px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .table-header-box h2 {
      font-size: 19px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 14px;
    }
    th {
      padding: 12px 20px;
      color: var(--text-sec);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--card-border);
    }
    td {
      padding: 16px 20px;
      border-bottom: 1px solid var(--card-border);
    }
    tr.task-row {
      cursor: pointer;
      transition: background 0.15s ease;
    }
    tr.task-row:hover {
      background: rgba(0, 113, 227, 0.04);
    }
    .task-id {
      font-size: 14px;
    }
    .task-sub {
      font-size: 12px;
      color: var(--text-sec);
      margin-top: 2px;
    }
    .pill-category {
      background: rgba(142, 142, 147, 0.12);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
    }
    .evidence-pill {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--text-sec);
    }
    .stat-pass { color: var(--success); font-weight: 600; }
    .stat-fail { color: var(--danger); font-weight: 600; }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .badge-boost {
      background: rgba(52, 199, 89, 0.15);
      color: var(--success);
    }
    .badge-pass {
      background: rgba(0, 113, 227, 0.15);
      color: var(--accent);
    }
    .badge-solo {
      background: rgba(255, 149, 0, 0.15);
      color: var(--warning);
    }
    .badge-fail {
      background: rgba(255, 59, 48, 0.15);
      color: var(--danger);
    }

    /* Accordion details */
    .task-detail-row td {
      padding: 0;
      background: rgba(0,0,0,0.02);
    }
    .detail-container {
      padding: 20px 24px;
      border-bottom: 1px solid var(--card-border);
    }
    .detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    .detail-col h4 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
      color: var(--text-sec);
    }
    .detail-metric {
      font-size: 13px;
      margin-bottom: 6px;
    }
    .code-box {
      margin-top: 10px;
      background: rgba(0,0,0,0.05);
      padding: 8px 12px;
      border-radius: 8px;
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-x: auto;
    }

    /* SVG Execution Timeline */
    .timeline-box {
      margin-top: 16px;
      padding: 14px 18px;
      background: rgba(0, 0, 0, 0.03);
      border-radius: 12px;
      border: 1px solid var(--card-border);
    }
    @media (prefers-color-scheme: dark) {
      .timeline-box {
        background: rgba(255, 255, 255, 0.04);
      }
    }
    .timeline-heading {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-sec);
      margin-bottom: 8px;
    }
    .timeline-svg {
      display: block;
      width: 100%;
      height: 64px;
    }

    /* Invariant Highlights */
    .invariants-box {
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 18px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .invariants-box h3 {
      font-size: 18px;
      margin-bottom: 12px;
    }
    .invariants-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .inv-item {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .inv-icon {
      font-size: 20px;
      line-height: 1;
    }
    .inv-title {
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 2px;
    }
    .inv-desc {
      font-size: 13px;
      color: var(--text-sec);
      line-height: 1.4;
    }

    footer {
      text-align: center;
      color: var(--text-sec);
      font-size: 13px;
      margin-top: 40px;
    }
  `;
}

/**
 * Render a proportional SVG execution timeline comparing two execution runs.
 */
export function renderExecutionTimelineSvg(armA, armB, labelA = "Solo", labelB = "Boost") {
  const wallA = Math.max(0, Number(armA?.wallMs) || 0);
  const wallB = Math.max(0, Number(armB?.wallMs) || 0);
  const maxWall = Math.max(wallA, wallB, 1);
  const widthA = Math.max(12, Math.round((wallA / maxWall) * 400));
  const widthB = Math.max(12, Math.round((wallB / maxWall) * 400));
  const secA = (wallA / 1000).toFixed(1);
  const secB = (wallB / 1000).toFixed(1);

  return `
    <div class="timeline-box">
      <div class="timeline-heading">⏱️ Execution Wall Clock &amp; Latency Profile</div>
      <svg class="timeline-svg" viewBox="0 0 580 64" preserveAspectRatio="xMidYMid meet">
        <!-- Arm A Bar -->
        <rect x="70" y="6" width="400" height="20" rx="6" fill="rgba(0,0,0,0.06)" />
        <rect x="70" y="6" width="${widthA}" height="20" rx="6" fill="#ff9500" />
        <text x="62" y="21" font-size="11" font-weight="600" text-anchor="end" fill="currentColor">${escapeHtml(labelA)}</text>
        <text x="${78 + widthA}" y="21" font-size="11" fill="currentColor">${secA}s (${armA?.attempts ?? 1} att, ${armA?.usage?.calls ?? 1} calls)</text>

        <!-- Arm B Bar -->
        <rect x="70" y="34" width="400" height="20" rx="6" fill="rgba(0,0,0,0.06)" />
        <rect x="70" y="34" width="${widthB}" height="20" rx="6" fill="#0071e3" />
        <text x="62" y="49" font-size="11" font-weight="600" text-anchor="end" fill="currentColor">${escapeHtml(labelB)}</text>
        <text x="${78 + widthB}" y="49" font-size="11" fill="currentColor">${secB}s (${armB?.complexityTier || "std"}, ${armB?.usage?.calls ?? 1} calls)</text>
      </svg>
    </div>
  `;
}

/**
 * Generate a standalone, Apple-inspired responsive HTML report.
 */
export function generateHtmlReport(summary) {
  const meta = summary?.meta || {};
  const agg = summary?.aggregate || {};
  const results = summary?.results || [];
  const model = meta.model || "mimo-v2.6-flash";
  const endpoint = meta.endpoint || "https://opencode.ai/zen/go/v1/chat/completions";
  const sessionId = meta.sessionId || "live-session";
  const dateStr = new Date().toISOString();

  const total = agg.total || results.length || 0;
  const soloPassed = agg.soloPassed ?? results.filter((r) => r.solo?.passed).length;
  const boostPassed = agg.boostPassed ?? results.filter((r) => r.boost?.passed).length;
  const soloPassRate = total > 0 ? ((soloPassed / total) * 100).toFixed(1) : "0.0";
  const boostPassRate = total > 0 ? ((boostPassed / total) * 100).toFixed(1) : "0.0";

  const soloTokens = agg.soloTokens ?? 0;
  const boostTokens = agg.boostTokens ?? 0;
  const tokenRatio = soloTokens > 0 ? (boostTokens / soloTokens).toFixed(2) : "1.00";

  const soloScore = typeof agg.soloScoreAvg === "number" ? agg.soloScoreAvg.toFixed(1) : "0.0";
  const boostScore = typeof agg.boostScoreAvg === "number" ? agg.boostScoreAvg.toFixed(1) : "0.0";

  const conflicts = agg.conflicts ?? 0;
  const rollbacks = agg.rollbacks ?? 0;
  const synthUsed = agg.synthUsed ?? 0;

  // Build table rows
  const rowsHtml = results.map((r, idx) => {
    const task = r.task || {};
    const solo = r.solo || {};
    const boost = r.boost || {};

    const statusBadge = (boost.passed && !solo.passed)
      ? '<span class="badge badge-boost">BOOST-ONLY</span>'
      : (boost.passed && solo.passed)
      ? '<span class="badge badge-pass">BOTH-PASS</span>'
      : (!boost.passed && solo.passed)
      ? '<span class="badge badge-solo">SOLO-ONLY</span>'
      : '<span class="badge badge-fail">BOTH-FAIL</span>';

    const soloStatus = solo.passed
      ? `<span class="stat-pass">PASS</span> (${solo.groundExitCode}/${solo.yardstickScore})`
      : `<span class="stat-fail">FAIL</span> (${solo.groundExitCode}/${solo.yardstickScore})`;

    const boostStatus = boost.passed
      ? `<span class="stat-pass">PASS</span> (${boost.groundExitCode}/${boost.yardstickScore})`
      : `<span class="stat-fail">FAIL</span> (${boost.groundExitCode}/${boost.yardstickScore})`;

    const evidences = [];
    if (boost.conflictsIntercepted > 0) evidences.push(`conflict:${boost.conflictsIntercepted}`);
    if (boost.rollbacks > 0) evidences.push(`rollback:${boost.rollbacks}`);
    if (boost.synthUsed) evidences.push("synth:1");
    if (boost.repairRounds !== undefined) evidences.push(`rounds:${boost.repairRounds}`);
    const evidenceStr = evidences.join(" ") || "clean";

    const rowId = `task-detail-${idx}`;

    return `
      <tr class="task-row" onclick="toggleDetail('${rowId}')">
        <td class="task-id">
          <strong>${escapeHtml(task.id)}</strong>
          <div class="task-sub">${escapeHtml(task.name)}</div>
        </td>
        <td><span class="pill-category">${escapeHtml(task.category || "General")}</span></td>
        <td>${soloStatus}</td>
        <td>${boostStatus}</td>
        <td><span class="evidence-pill">${escapeHtml(evidenceStr)}</span></td>
        <td>${statusBadge}</td>
      </tr>
      <tr id="${rowId}" class="task-detail-row" style="display: none;">
        <td colspan="6">
          <div class="detail-container">
            <div class="detail-grid">
              <div class="detail-col">
                <h4>Solo Model Performance</h4>
                <div class="detail-metric">Attempts: <strong>${solo.attempts ?? 1}</strong></div>
                <div class="detail-metric">Tokens: <strong>${fmtNum(solo.usage?.prompt ?? 0)} in / ${fmtNum(solo.usage?.completion ?? 0)} out</strong></div>
                <div class="detail-metric">Ground Exit: <strong>${solo.groundExitCode ?? 0}</strong> (Pass: ${solo.groundPass ?? 0}, Fail: ${solo.groundFail ?? 0})</div>
                <div class="detail-metric">Yardstick Score: <strong>${solo.yardstickScore ?? 0}/100</strong></div>
                ${solo.diffStat ? `<div class="code-box"><code>${escapeHtml(solo.diffStat)}</code></div>` : ""}
              </div>
              <div class="detail-col">
                <h4>Boost Toolchain Performance</h4>
                <div class="detail-metric">Complexity Tier: <strong>${escapeHtml(boost.complexityTier || "standard")}</strong></div>
                <div class="detail-metric">Tokens: <strong>${fmtNum(boost.usage?.prompt ?? 0)} in / ${fmtNum(boost.usage?.completion ?? 0)} out</strong></div>
                <div class="detail-metric">Ground Exit: <strong>${boost.groundExitCode ?? 0}</strong> (Pass: ${boost.groundPass ?? 0}, Fail: ${boost.groundFail ?? 0})</div>
                <div class="detail-metric">Yardstick Score: <strong>${boost.yardstickScore ?? 0}/100</strong></div>
                ${boost.diffStat ? `<div class="code-box"><code>${escapeHtml(boost.diffStat)}</code></div>` : ""}
              </div>
            </div>
            ${renderExecutionTimelineSvg(solo, boost, "Solo", "Boost")}
          </div>
        </td>
      </tr>
    `;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>agent-boost Live API Benchmark Report</title>
  <style>
    ${getReportStyles()}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-badge">LIVE API BENCHMARK • v0.4.0</div>
      <h1>Dual-Track Evaluation Scoreboard</h1>
      <div class="meta-subtitle">
        <div class="meta-item">Model: <strong>${escapeHtml(model)}</strong></div>
        <div class="meta-item">Endpoint: <strong>${escapeHtml(endpoint)}</strong></div>
        <div class="meta-item">Session: <strong>${escapeHtml(sessionId)}</strong></div>
        <div class="meta-item">Generated: <strong>${escapeHtml(dateStr)}</strong></div>
      </div>
    </header>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Pass@1 Success Rate</div>
        <div class="metric-value-row">
          <div class="metric-big">${boostPassRate}%</div>
          <div class="metric-delta">vs ${soloPassRate}% Solo</div>
        </div>
        <div class="metric-desc">${boostPassed}/${total} boost tasks passed vs ${soloPassed}/${total} solo</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Metered Token Efficiency</div>
        <div class="metric-value-row">
          <div class="metric-big">${tokenRatio}x</div>
          <div class="metric-delta">Ratio</div>
        </div>
        <div class="metric-desc">${fmtNum(boostTokens)} (Boost) vs ${fmtNum(soloTokens)} (Solo) metered tokens</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Yardstick Quality Score</div>
        <div class="metric-value-row">
          <div class="metric-big">${boostScore}</div>
          <div class="metric-delta">vs ${soloScore}</div>
        </div>
        <div class="metric-desc">Independent Agent-as-a-Judge 6-criterion evaluation</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Gating Invariants Enforced</div>
        <div class="metric-value-row">
          <div class="metric-big">${conflicts + rollbacks + synthUsed}</div>
          <div class="metric-delta">Protections</div>
        </div>
        <div class="metric-desc">${conflicts} write conflicts blocked • ${rollbacks} rollbacks • ${synthUsed} tests synthesized</div>
      </div>
    </div>

    <div class="table-card">
      <div class="table-header-box">
        <h2>Task-by-Task Live Duel Ledger</h2>
        <span style="font-size: 13px; color: var(--text-sec);">Click any row to view execution details</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Task &amp; Identifier</th>
            <th>Category</th>
            <th>Solo Result</th>
            <th>Boost Result</th>
            <th>Boost Evidences</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div class="invariants-box">
      <h3>Harness Architectural Invariants &amp; Protocol Guarantees</h3>
      <div class="invariants-list">
        <div class="inv-item">
          <div class="inv-icon">🛡️</div>
          <div>
            <div class="inv-title">100% Conflict Ownership Interception</div>
            <div class="inv-desc">detectTargetFileConflicts prevents subagents from overwriting shared server entrypoints before execution.</div>
          </div>
        </div>
        <div class="inv-item">
          <div class="inv-icon">⏪</div>
          <div>
            <div class="inv-title">LATS Checkpoints &amp; Rollback</div>
            <div class="inv-desc">Automated git reset --hard safely restores clean state when candidate fixes introduce test regressions.</div>
          </div>
        </div>
        <div class="inv-item">
          <div class="inv-icon">🧪</div>
          <div>
            <div class="inv-title">Autonomous Test Synthesis (INV-First)</div>
            <div class="inv-desc">Synthesizes syntax-checked reproduction tests (verify_synth.sh) when repositories lack test commands.</div>
          </div>
        </div>
        <div class="inv-item">
          <div class="inv-icon">⚖️</div>
          <div>
            <div class="inv-title">Single-Source-of-Truth AST Parity</div>
            <div class="inv-desc">10 gatekeeper pure functions 100% parameter- and body-identical across TS, JS, and ZCode workflows.</div>
          </div>
        </div>
      </div>
    </div>

    <footer>
      agent-boost v0.4.0 • Evaluated live against OpenCode Zen Gateway • Zero Third-Party Dependencies
    </footer>
  </div>

  <script>
    function toggleDetail(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = el.style.display === "none" ? "table-row" : "none";
    }
  </script>
</body>
</html>
`;
}

/**
 * Generate a standalone, Apple-inspired cross-model comparison HTML report.
 */
export function generateMultiModelReport(summaryA, summaryB) {
  const metaA = summaryA?.meta || {};
  const metaB = summaryB?.meta || {};
  const aggA = summaryA?.aggregate || {};
  const aggB = summaryB?.aggregate || {};
  const resultsA = summaryA?.results || [];
  const resultsB = summaryB?.results || [];

  const modelA = metaA.model || "Model A";
  const modelB = metaB.model || "Model B";
  const endpoint = metaA.endpoint || metaB.endpoint || "https://opencode.ai/zen/go/v1/chat/completions";
  const dateStr = new Date().toISOString();

  const totalA = aggA.total || resultsA.length || 0;
  const totalB = aggB.total || resultsB.length || 0;
  const boostPassedA = aggA.boostPassed ?? resultsA.filter((r) => r.boost?.passed).length;
  const boostPassedB = aggB.boostPassed ?? resultsB.filter((r) => r.boost?.passed).length;
  const soloPassedA = aggA.soloPassed ?? resultsA.filter((r) => r.solo?.passed).length;
  const soloPassedB = aggB.soloPassed ?? resultsB.filter((r) => r.solo?.passed).length;

  const boostRateA = totalA > 0 ? ((boostPassedA / totalA) * 100).toFixed(1) : "0.0";
  const boostRateB = totalB > 0 ? ((boostPassedB / totalB) * 100).toFixed(1) : "0.0";
  const soloRateA = totalA > 0 ? ((soloPassedA / totalA) * 100).toFixed(1) : "0.0";
  const soloRateB = totalB > 0 ? ((soloPassedB / totalB) * 100).toFixed(1) : "0.0";

  const tokenRatioA = aggA.soloTokens > 0 ? ((aggA.boostTokens || 0) / aggA.soloTokens).toFixed(2) : "1.00";
  const tokenRatioB = aggB.soloTokens > 0 ? ((aggB.boostTokens || 0) / aggB.soloTokens).toFixed(2) : "1.00";

  const scoreA = typeof aggA.boostScoreAvg === "number" ? aggA.boostScoreAvg.toFixed(1) : "0.0";
  const scoreB = typeof aggB.boostScoreAvg === "number" ? aggB.boostScoreAvg.toFixed(1) : "0.0";

  // Build task map across both runs
  const mapA = new Map(resultsA.map((r) => [r.task?.id, r]));
  const mapB = new Map(resultsB.map((r) => [r.task?.id, r]));
  const allIds = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).filter(Boolean);

  const rowsHtml = allIds.map((taskId, idx) => {
    const rA = mapA.get(taskId) || {};
    const rB = mapB.get(taskId) || {};
    const task = rA.task || rB.task || { id: taskId, name: taskId, category: "General" };

    const soloA = rA.solo || {};
    const boostA = rA.boost || {};
    const soloB = rB.solo || {};
    const boostB = rB.boost || {};

    const statusBadge = (boostA.passed && boostB.passed)
      ? '<span class="badge badge-pass">DUAL BOOST PASS</span>'
      : (boostA.passed || boostB.passed)
      ? '<span class="badge badge-boost">BOOST ADVANTAGE</span>'
      : '<span class="badge badge-fail">DUAL FAIL</span>';

    const fmtStatus = (s) => s.passed
      ? `<span class="stat-pass">PASS</span> (${s.groundExitCode ?? 0}/${s.yardstickScore ?? 0})`
      : `<span class="stat-fail">FAIL</span> (${s.groundExitCode ?? 1}/${s.yardstickScore ?? 0})`;

    const rowId = `cross-detail-${idx}`;

    return `
      <tr class="task-row" onclick="toggleDetail('${rowId}')">
        <td class="task-id">
          <strong>${escapeHtml(task.id)}</strong>
          <div class="task-sub">${escapeHtml(task.name)}</div>
        </td>
        <td><span class="pill-category">${escapeHtml(task.category || "General")}</span></td>
        <td>${fmtStatus(soloA)}</td>
        <td>${fmtStatus(boostA)}</td>
        <td>${fmtStatus(soloB)}</td>
        <td>${fmtStatus(boostB)}</td>
        <td>${statusBadge}</td>
      </tr>
      <tr id="${rowId}" class="task-detail-row" style="display: none;">
        <td colspan="7">
          <div class="detail-container">
            <div class="detail-grid">
              <div class="detail-col">
                <h4>${escapeHtml(modelA)} Performance</h4>
                <div class="detail-metric">Solo: <strong>${soloA.passed ? "PASS" : "FAIL"}</strong> (Exit: ${soloA.groundExitCode ?? 0}, Score: ${soloA.yardstickScore ?? 0})</div>
                <div class="detail-metric">Boost: <strong>${boostA.passed ? "PASS" : "FAIL"}</strong> (Exit: ${boostA.groundExitCode ?? 0}, Score: ${boostA.yardstickScore ?? 0})</div>
                <div class="detail-metric">Tokens: <strong>${fmtNum(boostA.usage?.prompt ?? 0)} in / ${fmtNum(boostA.usage?.completion ?? 0)} out</strong></div>
                <div class="detail-metric">Complexity Tier: <strong>${escapeHtml(boostA.complexityTier || "standard")}</strong></div>
              </div>
              <div class="detail-col">
                <h4>${escapeHtml(modelB)} Performance</h4>
                <div class="detail-metric">Solo: <strong>${soloB.passed ? "PASS" : "FAIL"}</strong> (Exit: ${soloB.groundExitCode ?? 0}, Score: ${soloB.yardstickScore ?? 0})</div>
                <div class="detail-metric">Boost: <strong>${boostB.passed ? "PASS" : "FAIL"}</strong> (Exit: ${boostB.groundExitCode ?? 0}, Score: ${boostB.yardstickScore ?? 0})</div>
                <div class="detail-metric">Tokens: <strong>${fmtNum(boostB.usage?.prompt ?? 0)} in / ${fmtNum(boostB.usage?.completion ?? 0)} out</strong></div>
                <div class="detail-metric">Complexity Tier: <strong>${escapeHtml(boostB.complexityTier || "standard")}</strong></div>
              </div>
            </div>
            ${renderExecutionTimelineSvg(boostA, boostB, `${modelA} Boost`, `${modelB} Boost`)}
          </div>
        </td>
      </tr>
    `;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>agent-boost Cross-Model Benchmark Comparison: ${escapeHtml(modelA)} vs ${escapeHtml(modelB)}</title>
  <style>
    ${getReportStyles()}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-badge">CROSS-MODEL COMPARISON • v0.4.0</div>
      <h1>${escapeHtml(modelA)} vs ${escapeHtml(modelB)} Live Duel</h1>
      <div class="meta-subtitle">
        <div class="meta-item">Endpoint: <strong>${escapeHtml(endpoint)}</strong></div>
        <div class="meta-item">Tasks Evaluated: <strong>${allIds.length}</strong></div>
        <div class="meta-item">Generated: <strong>${escapeHtml(dateStr)}</strong></div>
      </div>
    </header>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Boost Pass@1 Comparison</div>
        <div class="metric-value-row">
          <div class="metric-big">${boostRateA}% vs ${boostRateB}%</div>
        </div>
        <div class="metric-desc">${escapeHtml(modelA)}: ${boostPassedA}/${totalA} • ${escapeHtml(modelB)}: ${boostPassedB}/${totalB}</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Solo Baseline Pass@1</div>
        <div class="metric-value-row">
          <div class="metric-big">${soloRateA}% vs ${soloRateB}%</div>
        </div>
        <div class="metric-desc">${escapeHtml(modelA)}: ${soloPassedA}/${totalA} • ${escapeHtml(modelB)}: ${soloPassedB}/${totalB}</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Token Expansion Multipliers</div>
        <div class="metric-value-row">
          <div class="metric-big">${tokenRatioA}x vs ${tokenRatioB}x</div>
        </div>
        <div class="metric-desc">${escapeHtml(modelA)} (${fmtNum(aggA.boostTokens ?? 0)}) vs ${escapeHtml(modelB)} (${fmtNum(aggB.boostTokens ?? 0)})</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Yardstick Quality Scores</div>
        <div class="metric-value-row">
          <div class="metric-big">${scoreA} vs ${scoreB}</div>
        </div>
        <div class="metric-desc">Agent-as-a-Judge 6-criterion evaluation</div>
      </div>
    </div>

    <div class="table-card">
      <div class="table-header-box">
        <h2>Cross-Model Dual Duel Comparison</h2>
        <span style="font-size: 13px; color: var(--text-sec);">Click any row to expand side-by-side details</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Task &amp; Identifier</th>
            <th>Category</th>
            <th>${escapeHtml(modelA)} Solo</th>
            <th>${escapeHtml(modelA)} Boost</th>
            <th>${escapeHtml(modelB)} Solo</th>
            <th>${escapeHtml(modelB)} Boost</th>
            <th>Dual Verdict</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div class="invariants-box">
      <h3>Cross-Model Invariants &amp; Protocol Guarantees</h3>
      <div class="invariants-list">
        <div class="inv-item">
          <div class="inv-icon">🛡️</div>
          <div>
            <div class="inv-title">Model-Agnostic Conflict Interception</div>
            <div class="inv-desc">Ownership invariants hold equally across models, preventing race conditions regardless of model weights.</div>
          </div>
        </div>
        <div class="inv-item">
          <div class="inv-icon">⏪</div>
          <div>
            <div class="inv-title">Universal LATS Rollback</div>
            <div class="inv-desc">Hard git checkpoints safely revert regressive patches for any model arm.</div>
          </div>
        </div>
        <div class="inv-item">
          <div class="inv-icon">⚡</div>
          <div>
            <div class="inv-title">Adaptive Compute Scaling</div>
            <div class="inv-desc">Dynamic token budgets adjust per task tier, optimizing token expenditure across different model architectures.</div>
          </div>
        </div>
      </div>
    </div>

    <footer>
      agent-boost v0.4.0 • Cross-Model Benchmark Comparison • Zero Third-Party Dependencies
    </footer>
  </div>

  <script>
    function toggleDetail(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = el.style.display === "none" ? "table-row" : "none";
    }
  </script>
</body>
</html>
`;
}

/**
 * Generate a clean Markdown summary table for a single run.
 */
export function generateMarkdownSummary(summary) {
  const meta = summary?.meta || {};
  const agg = summary?.aggregate || {};
  const results = summary?.results || [];

  let md = `## 📊 agent-boost Live Benchmark Scoreboard (${meta.model || "mimo-v2.6-flash"})\n\n`;
  md += `| Task ID | Solo (${agg.soloPassed ?? 0}/${agg.total ?? results.length}) | Boost (${agg.boostPassed ?? 0}/${agg.total ?? results.length}) | Score (Solo / Boost) | Verdict |\n`;
  md += `| :------ | :------------------ | :------------------- | :------------------- | :------ |\n`;

  for (const r of results) {
    const task = r.task || {};
    const solo = r.solo || {};
    const boost = r.boost || {};
    const verdict = (boost.passed && !solo.passed) ? "**BOOST-ONLY**" : boost.passed ? "BOTH-PASS" : "SOLO-ONLY";
    md += `| \`${task.id}\` | ${solo.passed ? "PASS" : "FAIL"} (exit ${solo.groundExitCode}) | ${boost.passed ? "PASS" : "FAIL"} (exit ${boost.groundExitCode}) | ${solo.yardstickScore} / ${boost.yardstickScore} | ${verdict} |\n`;
  }

  md += `\n- **Token Expansion Ratio**: ${(agg.boostTokens / (agg.soloTokens || 1)).toFixed(2)}x (${fmtNum(agg.boostTokens)} boost vs ${fmtNum(agg.soloTokens)} solo tokens)\n`;
  md += `- **Intercepted Conflicts**: ${agg.conflicts ?? 0} | **LATS Rollbacks**: ${agg.rollbacks ?? 0} | **Synthesized Tests**: ${agg.synthUsed ?? 0}\n`;
  return md;
}

/**
 * Generate a clean Markdown summary table for cross-model comparisons.
 */
export function generateCrossModelMarkdown(summaryA, summaryB) {
  const modelA = summaryA?.meta?.model || "Model A";
  const modelB = summaryB?.meta?.model || "Model B";
  const aggA = summaryA?.aggregate || {};
  const aggB = summaryB?.aggregate || {};
  const mapA = new Map((summaryA?.results || []).map((r) => [r.task?.id, r]));
  const mapB = new Map((summaryB?.results || []).map((r) => [r.task?.id, r]));
  const allIds = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).filter(Boolean);

  let md = `## 📊 agent-boost Cross-Model Live Benchmark Duel (${modelA} vs ${modelB})\n\n`;
  md += `| Task ID | ${modelA} (Solo / Boost) | ${modelB} (Solo / Boost) | Verdict |\n`;
  md += `| :------ | :------------------------ | :------------------------ | :------ |\n`;

  for (const id of allIds) {
    const rA = mapA.get(id) || {};
    const rB = mapB.get(id) || {};
    const sA = rA.solo || {};
    const bA = rA.boost || {};
    const sB = rB.solo || {};
    const bB = rB.boost || {};
    const verdict = (bA.passed && bB.passed) ? "DUAL-PASS" : (bA.passed || bB.passed) ? "BOOST-VICTORY" : "DUAL-FAIL";
    md += `| \`${id}\` | ${sA.passed ? "PASS" : "FAIL"} / ${bA.passed ? "PASS" : "FAIL"} | ${sB.passed ? "PASS" : "FAIL"} / ${bB.passed ? "PASS" : "FAIL"} | ${verdict} |\n`;
  }

  md += `\n- **Boost Pass@1**: ${modelA} ${aggA.boostPassed ?? 0}/${aggA.total ?? allIds.length} vs ${modelB} ${aggB.boostPassed ?? 0}/${aggB.total ?? allIds.length}\n`;
  md += `- **Solo Pass@1**: ${modelA} ${aggA.soloPassed ?? 0}/${aggA.total ?? allIds.length} vs ${modelB} ${aggB.soloPassed ?? 0}/${aggB.total ?? allIds.length}\n`;
  md += `- **Yardstick Score Avg**: ${modelA} ${typeof aggA.boostScoreAvg === "number" ? aggA.boostScoreAvg.toFixed(1) : "0.0"} vs ${modelB} ${typeof aggB.boostScoreAvg === "number" ? aggB.boostScoreAvg.toFixed(1) : "0.0"}\n`;
  return md;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function latestRunJsons(count = 2) {
  const dir = path.join(REPO_ROOT, "live-results");
  if (!fs.existsSync(dir)) return [];
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /^live-run-.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return candidates.slice(0, count).map((c) => path.join(dir, c.f));
}

function latestRunJson() {
  const list = latestRunJsons(1);
  return list.length > 0 ? list[0] : null;
}

function main() {
  const isCompare = process.argv.includes("--compare");
  if (isCompare) {
    const nonFlags = process.argv.slice(2).filter((arg) => arg !== "--compare");
    let fileA = nonFlags[0];
    let fileB = nonFlags[1];
    let outputArg = nonFlags[2];

    if (!fileA || !fileB) {
      const recents = latestRunJsons(2);
      if (recents.length < 2) {
        console.error("Error: --compare requires at least two benchmark result JSON files.");
        console.error("Usage: node scripts/generate-benchmark-report.mjs --compare <runA.json> <runB.json> [output.html]");
        process.exit(1);
      }
      fileA = fileA || recents[1]; // older
      fileB = fileB || recents[0]; // newer
    }

    outputArg = outputArg || path.join(REPO_ROOT, "live-results", "cross-model-comparison.html");

    const summaryA = JSON.parse(fs.readFileSync(fileA, "utf8"));
    const summaryB = JSON.parse(fs.readFileSync(fileB, "utf8"));

    const html = generateMultiModelReport(summaryA, summaryB);
    fs.mkdirSync(path.dirname(path.resolve(outputArg)), { recursive: true });
    fs.writeFileSync(outputArg, html, "utf8");
    console.log(`✔ Cross-Model Comparison Report generated at: ${outputArg}`);
    console.log(`  Comparing: ${summaryA?.meta?.model || fileA} vs ${summaryB?.meta?.model || fileB}`);
    const md = generateCrossModelMarkdown(summaryA, summaryB);
    console.log("\n" + md);
    return;
  }

  const inputArg = process.argv[2] || latestRunJson();
  const outputArg = process.argv[3] || path.join(REPO_ROOT, "live-results", "report.html");

  if (!inputArg || !fs.existsSync(inputArg)) {
    console.error(`Input file not found: ${inputArg || "(no live-run JSON in live-results/)"}`);
    console.error("Usage: node scripts/generate-benchmark-report.mjs [input.json] [output.html]");
    process.exit(1);
  }
  if (!process.argv[2]) {
    console.log(`Using latest run JSON: ${inputArg}`);
  }

  const raw = fs.readFileSync(inputArg, "utf8");
  const summary = JSON.parse(raw);
  const html = generateHtmlReport(summary);

  fs.mkdirSync(path.dirname(path.resolve(outputArg)), { recursive: true });
  fs.writeFileSync(outputArg, html, "utf8");
  console.log(`✔ Interactive HTML report successfully generated at: ${outputArg}`);
}

if (process.argv[1] && process.argv[1].endsWith("generate-benchmark-report.mjs")) {
  main();
}
