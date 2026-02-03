#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const apiBaseUrl =
  process.env.SAFECOMMIT_API_BASE_URL || "http://localhost:8787";
const apiKey = process.env.SAFECOMMIT_API_KEY || "";
const failOnSeverity = process.env.SAFECOMMIT_FAIL_ON_SEVERITY || "critical";
const maxDiffBytes = Number.parseInt(
  process.env.SAFECOMMIT_MAX_DIFF_BYTES || "200000",
  10,
);
const TUFF = `
███████╗ █████╗ ███████╗███████╗ ██████╗ ██████╗ ███╗   ███╗███╗   ███╗██╗████████╗
██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗████╗ ████║████╗ ████║██║╚══██╔══╝
███████╗███████║█████╗  █████╗  ██║     ██║   ██║██╔████╔██║██╔████╔██║██║   ██║   
╚════██║██╔══██║██╔══╝  ██╔══╝  ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██║   ██║   
███████║██║  ██║██║     ███████╗╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║   ██║   
╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝   ╚═╝   
`;

let activeRunId = "";
let activeRepoRoot = "";

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function runGit(args) {
  return execSync(`git ${args}`, { encoding: "utf8" });
}

function resolveGitDir(repoRoot) {
  try {
    const output = execSync("git rev-parse --git-dir", {
      encoding: "utf8",
      cwd: repoRoot,
    }).trim();
    if (!output) {
      return "";
    }
    return path.isAbsolute(output) ? output : path.join(repoRoot, output);
  } catch {
    return "";
  }
}

function createRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeStatus({ status, runId, repoRoot, response, message }) {
  if (!repoRoot || !runId) {
    return;
  }
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    return;
  }
  const statusFile = path.join(gitDir, "safecommit", "review.json");
  const payload = {
    status,
    runId,
    repoRoot,
    timestamp: new Date().toISOString(),
    ...(message ? { message } : {}),
    ...(response ? { response } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(payload), "utf8");
  } catch {}
}

function ensureUtf8Console() {
  if (process.platform !== "win32") {
    return;
  }
  try {
    execSync("chcp 65001 >NUL");
  } catch {}
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

function emptyResponse() {
  return {
    requestId: "local-no-diff",
    findings: [],
    summary: { totalFindings: 0, bySeverity: {}, durationMs: 0 },
  };
}

async function main() {
  let repoRoot = "";
  try {
    repoRoot = runGit("rev-parse --show-toplevel").trim();
  } catch {
    process.exit(0);
  }

  if (TUFF.trim()) {
    ensureUtf8Console();
    process.stdout.write(TUFF);
    if (!TUFF.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }

  const answer = await prompt(
    "SafeCommit: review staged changes before commit? (Y/n) ",
  );
  const reply = (answer || "Y").toLowerCase();
  if (reply !== "y" && reply !== "yes") {
    process.exit(0);
  }

  const runId = createRunId();
  activeRunId = runId;
  activeRepoRoot = repoRoot;
  writeStatus({ status: "started", runId, repoRoot });

  let diff = "";
  try {
    diff = runGit("diff --cached --unified=3");
  } catch {
    writeStatus({
      status: "error",
      runId,
      repoRoot,
      message: "SafeCommit: failed to read staged diff.",
    });
    process.exit(0);
  }

  if (!diff.trim()) {
    console.log("SafeCommit: no staged changes to review.");
    writeStatus({
      status: "completed",
      runId,
      repoRoot,
      response: emptyResponse(),
    });
    process.exit(0);
  }

  const filesOutput = runGit("diff --cached --name-only");
  const files = filesOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  diff = truncateByBytes(diff, maxDiffBytes);

  const body = JSON.stringify({
    repoId: process.cwd(),
    diff,
    files,
  });

  const response = await fetch(`${apiBaseUrl}/v1/review/diff`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body,
  }).catch(() => undefined);

  if (!response || !response.ok) {
    console.log("SafeCommit: backend unavailable, skipping review.");
    writeStatus({
      status: "error",
      runId,
      repoRoot,
      message: "SafeCommit: backend unavailable, skipping review.",
    });
    process.exit(0);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    console.log("SafeCommit: invalid response from backend.");
    writeStatus({
      status: "error",
      runId,
      repoRoot,
      message: "SafeCommit: invalid response from backend.",
    });
    process.exit(0);
  }
  writeStatus({ status: "completed", runId, repoRoot, response: data });
  const findings = Array.isArray(data.findings) ? data.findings : [];

  console.log("Found Issues:");
  if (findings.length === 0) {
    console.log("1. None");
  } else {
    const seen = new Set();
    let count = 0;
    for (const f of findings) {
      const severity = f.severity || "unspecified";
      const file = f.file || "unknown";
      const lineStart = f.lineStart ?? "?";
      const lineEnd = f.lineEnd ?? "?";
      const title = f.title || "Untitled issue";
      const key = `${severity}|${file}|${lineStart}|${lineEnd}|${title}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      count += 1;
      const location =
        lineStart === lineEnd
          ? `${file}:${lineStart}`
          : `${file}:${lineStart}-${lineEnd}`;
      console.log(`${count}. [${severity}] ${location} - ${title}`);
    }
  }

  const shouldFail = findings.some((f) =>
    severityAtOrAbove(f.severity, failOnSeverity),
  );
  if (shouldFail) {
    console.log(
      `SafeCommit: blocking commit due to severity >= ${failOnSeverity}`,
    );
    process.exit(1);
  }
}

main().catch(() => {
  if (activeRunId && activeRepoRoot) {
    writeStatus({
      status: "error",
      runId: activeRunId,
      repoRoot: activeRepoRoot,
      message: "SafeCommit: unexpected error, skipping review.",
    });
  }
  console.log("SafeCommit: unexpected error, skipping review.");
  process.exit(0);
});
