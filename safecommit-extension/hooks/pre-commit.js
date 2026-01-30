#!/usr/bin/env node
const { execSync } = require("child_process");
const readline = require("readline");

const apiBaseUrl = process.env.SAFECOMMIT_API_BASE_URL || "http://localhost:8787";
const apiKey = process.env.SAFECOMMIT_API_KEY || "";
const failOnSeverity = process.env.SAFECOMMIT_FAIL_ON_SEVERITY || "critical";
const maxDiffBytes = Number.parseInt(process.env.SAFECOMMIT_MAX_DIFF_BYTES || "200000", 10);

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function runGit(args) {
  return execSync(`git ${args}`, { encoding: "utf8" });
}

function truncateByBytes(input, maxBytes) {
  const buf = Buffer.from(input, "utf8");
  if (buf.length <= maxBytes) {
    return input;
  }
  return buf.subarray(0, maxBytes).toString("utf8");
}

function severityAtOrAbove(sev, threshold) {
  const order = { nit: 0, suggestion: 1, warning: 2, critical: 3 };
  return order[sev] >= order[threshold];
}

async function main() {
  try {
    runGit("rev-parse --show-toplevel");
  } catch {
    process.exit(0);
  }

  const answer = await prompt("SafeCommit: review staged changes before commit? (Y/n) ");
  const reply = (answer || "Y").toLowerCase();
  if (reply !== "y" && reply !== "yes") {
    process.exit(0);
  }

  let diff = "";
  try {
    diff = runGit("diff --cached --unified=3");
  } catch {
    process.exit(0);
  }

  if (!diff.trim()) {
    console.log("SafeCommit: no staged changes to review.");
    process.exit(0);
  }

  const filesOutput = runGit("diff --cached --name-only");
  const files = filesOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  diff = truncateByBytes(diff, maxDiffBytes);

  const body = JSON.stringify({
    repoId: process.cwd(),
    diff,
    files
  });

  const response = await fetch(`${apiBaseUrl}/v1/review/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body
  }).catch(() => undefined);

  if (!response || !response.ok) {
    console.log("SafeCommit: backend unavailable, skipping review.");
    process.exit(0);
  }

  const data = await response.json();
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const summary = data.summary || {};

  console.log("SafeCommit summary:", JSON.stringify(summary));
  const top = findings.slice(0, 5);
  for (const f of top) {
    console.log(`- ${f.severity} ${f.file}:${f.lineStart}-${f.lineEnd} ${f.title}`);
  }

  const shouldFail = findings.some((f) => severityAtOrAbove(f.severity, failOnSeverity));
  if (shouldFail) {
    console.log(`SafeCommit: blocking commit due to severity >= ${failOnSeverity}`);
    process.exit(1);
  }
}

main().catch(() => {
  console.log("SafeCommit: unexpected error, skipping review.");
  process.exit(0);
});
