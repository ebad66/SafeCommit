import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type Finding = {
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: "nit" | "suggestion" | "warning" | "critical";
  title: string;
  message: string;
  rationale: string;
  patch?: string;
};

type Summary = {
  totalFindings: number;
  bySeverity: Record<string, number>;
  durationMs: number;
};

type ReviewResponse = {
  requestId: string;
  findings: Finding[];
  summary: Summary;
};

let panel: vscode.WebviewPanel | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
let lastReview: ReviewResponse | undefined;

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection("safecommit");
  context.subscriptions.push(diagnosticCollection);

  context.subscriptions.push(
    vscode.commands.registerCommand("safecommit.reviewStaged", () => reviewStaged(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("safecommit.openPanel", () => openPanel(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("safecommit.installHook", () => installHook(context))
  );
}

export function deactivate() {
  diagnosticCollection?.dispose();
}

async function reviewStaged(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("SafeCommit: No workspace folder is open.");
    return;
  }

  const repoRoot = await findRepoRoot(workspaceFolder.uri.fsPath);
  if (!repoRoot) {
    vscode.window.showErrorMessage("SafeCommit: Unable to find a git repository.");
    return;
  }

  let diff = "";
  let files: string[] = [];

  try {
    diff = await runGit(repoRoot, ["diff", "--cached", "--unified=3"]);
    const filesOutput = await runGit(repoRoot, ["diff", "--cached", "--name-only"]);
    files = filesOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    vscode.window.showErrorMessage(`SafeCommit: Failed to read staged diff. ${(error as Error).message}`);
    return;
  }

  if (!diff.trim()) {
    vscode.window.showInformationMessage("SafeCommit: No staged changes to review.");
    clearDiagnostics();
    renderResults(context, { requestId: "", findings: [], summary: { totalFindings: 0, bySeverity: {}, durationMs: 0 } });
    return;
  }

  const settings = getSettings();
  const maxBytes = settings.maxDiffBytes;
  const diffBytes = Buffer.byteLength(diff, "utf8");
  let truncated = false;
  if (diffBytes > maxBytes) {
    diff = Buffer.from(diff, "utf8").subarray(0, maxBytes).toString("utf8");
    truncated = true;
  }

  if (truncated) {
    vscode.window.showWarningMessage("SafeCommit: Diff was truncated due to size limits.");
  }

  let response: ReviewResponse;
  try {
    response = await callBackend(settings.apiBaseUrl, settings.apiKey, {
      repoId: repoRoot,
      diff,
      files
    });
  } catch (error) {
    vscode.window.showErrorMessage(`SafeCommit: Backend request failed. ${(error as Error).message}`);
    return;
  }

  lastReview = response;
  renderResults(context, response);
  applyDiagnostics(repoRoot, response.findings);
}

function openPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "safecommit",
    "SafeCommit Review",
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  panel.onDidDispose(() => {
    panel = undefined;
  });

  if (lastReview) {
    renderResults(context, lastReview);
  } else {
    panel.webview.html = renderHtml({ requestId: "", findings: [], summary: { totalFindings: 0, bySeverity: {}, durationMs: 0 } });
  }
}

async function installHook(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("SafeCommit: No workspace folder is open.");
    return;
  }

  const repoRoot = await findRepoRoot(workspaceFolder.uri.fsPath);
  if (!repoRoot) {
    vscode.window.showErrorMessage("SafeCommit: Unable to find a git repository.");
    return;
  }

  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const bashSource = context.asAbsolutePath(path.join("hooks", "pre-commit"));
  const nodeSource = context.asAbsolutePath(path.join("hooks", "pre-commit.js"));
  const bashTarget = path.join(hooksDir, "pre-commit");
  const nodeTarget = path.join(hooksDir, "pre-commit.js");

  try {
    await fs.promises.mkdir(hooksDir, { recursive: true });
    await fs.promises.copyFile(bashSource, bashTarget);
    await fs.promises.copyFile(nodeSource, nodeTarget);

    if (process.platform !== "win32") {
      await fs.promises.chmod(bashTarget, 0o755);
      await fs.promises.chmod(nodeTarget, 0o755);
    }

    vscode.window.showInformationMessage("SafeCommit: Pre-commit hooks installed.");
  } catch (error) {
    vscode.window.showErrorMessage(`SafeCommit: Failed to install hook. ${(error as Error).message}`);
  }
}

function renderResults(context: vscode.ExtensionContext, data: ReviewResponse) {
  if (!panel) {
    openPanel(context);
  }
  if (!panel) {
    return;
  }
  panel.webview.html = renderHtml(data);
}

function renderHtml(data: ReviewResponse): string {
  const grouped = groupFindings(data.findings);
  const summary = data.summary || { totalFindings: data.findings.length, bySeverity: {}, durationMs: 0 };
  const duration = summary.durationMs ? `${summary.durationMs} ms` : "";
  const severityOrder: Finding["severity"][] = ["critical", "warning", "suggestion", "nit"];
  const severityLabels: Record<Finding["severity"], string> = {
    critical: "Critical",
    warning: "Warning",
    suggestion: "Suggestion",
    nit: "Nit"
  };

  const sections = Object.entries(grouped)
    .map(([file, items]) => {
      const bySeverity = groupBySeverity(items);
      const severitySections = severityOrder
        .map((severity) => {
          const list = bySeverity[severity] || [];
          if (list.length === 0) {
            return "";
          }
          const findingsHtml = list
            .map((finding) => {
              const patchButton = finding.patch
                ? `<button data-copy="${escapeAttr(finding.patch)}">Copy patch</button>`
                : "";
              return `
                <div class="finding">
                  <div class="finding-header">
                    <span class="severity ${finding.severity}">${finding.severity.toUpperCase()}</span>
                    <span class="title">${escapeHtml(finding.title)}</span>
                    <span class="lines">${finding.lineStart}-${finding.lineEnd}</span>
                  </div>
                  <div class="message">${escapeHtml(finding.message)}</div>
                  <div class="rationale">${escapeHtml(finding.rationale)}</div>
                  <div class="actions">
                    <button data-copy="${escapeAttr(finding.message)}">Copy message</button>
                    ${patchButton}
                  </div>
                </div>
              `;
            })
            .join("\n");

          return `
            <div class="severity-group">
              <h3>${severityLabels[severity]}</h3>
              ${findingsHtml}
            </div>
          `;
        })
        .join("\n");

      return `
        <section class="file-section">
          <h2>${escapeHtml(file)}</h2>
          ${severitySections}
        </section>
      `;
    })
    .join("\n");

  const emptyState = data.findings.length === 0 ? "<p>No findings.</p>" : "";

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>SafeCommit Review</title>
        <style>
          :root {
            --bg: #f4f1ec;
            --card: #ffffff;
            --ink: #1f2a2e;
            --muted: #6a6f73;
            --accent: #0b6bcb;
            --border: #e2e0db;
          }
          body {
            font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            background: var(--bg);
            color: var(--ink);
            margin: 0;
            padding: 24px;
          }
          h1 {
            margin: 0 0 12px;
            font-size: 20px;
          }
          h2 {
            font-size: 16px;
            margin: 16px 0 8px;
          }
          h3 {
            font-size: 14px;
            margin: 12px 0 6px;
            color: var(--muted);
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
          .summary {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            background: var(--card);
            border: 1px solid var(--border);
            padding: 12px;
            border-radius: 8px;
          }
          .badge {
            background: #f0f2f4;
            border-radius: 999px;
            padding: 4px 10px;
            font-size: 12px;
            color: var(--muted);
          }
          .file-section {
            background: var(--card);
            border: 1px solid var(--border);
            padding: 12px;
            border-radius: 8px;
            margin-top: 16px;
          }
          .severity-group {
            padding-top: 4px;
          }
          .finding {
            border-top: 1px solid var(--border);
            padding-top: 12px;
            margin-top: 12px;
          }
          .finding-header {
            display: flex;
            gap: 12px;
            align-items: center;
          }
          .severity {
            font-weight: 700;
            font-size: 12px;
            padding: 4px 8px;
            border-radius: 6px;
            text-transform: uppercase;
          }
          .severity.nit { background: #e6f0ff; color: #1f4b99; }
          .severity.suggestion { background: #e8f7ef; color: #1f6b3a; }
          .severity.warning { background: #fff4e5; color: #8a5a00; }
          .severity.critical { background: #fde8e8; color: #9f1f1f; }
          .title { font-weight: 600; }
          .lines { color: var(--muted); font-size: 12px; margin-left: auto; }
          .message { margin-top: 8px; }
          .rationale { margin-top: 6px; color: var(--muted); }
          .actions { margin-top: 10px; display: flex; gap: 8px; }
          button {
            border: 1px solid var(--border);
            background: #fff;
            padding: 6px 10px;
            border-radius: 6px;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <h1>SafeCommit Review</h1>
        <div class="summary">
          <span class="badge">Total: ${summary.totalFindings}</span>
          <span class="badge">Critical: ${summary.bySeverity?.critical ?? 0}</span>
          <span class="badge">Warning: ${summary.bySeverity?.warning ?? 0}</span>
          <span class="badge">Suggestion: ${summary.bySeverity?.suggestion ?? 0}</span>
          <span class="badge">Nit: ${summary.bySeverity?.nit ?? 0}</span>
          <span class="badge">Duration: ${duration}</span>
        </div>
        ${emptyState}
        ${sections}
        <script>
          document.querySelectorAll("button[data-copy]").forEach((button) => {
            button.addEventListener("click", async () => {
              const text = button.getAttribute("data-copy") || "";
              try {
                await navigator.clipboard.writeText(text);
              } catch (error) {
                console.error(error);
              }
            });
          });
        </script>
      </body>
    </html>
  `;
}

function groupFindings(findings: Finding[]): Record<string, Finding[]> {
  return findings.reduce<Record<string, Finding[]>>((acc, finding) => {
    acc[finding.file] = acc[finding.file] || [];
    acc[finding.file].push(finding);
    return acc;
  }, {});
}

function groupBySeverity(findings: Finding[]): Record<string, Finding[]> {
  return findings.reduce<Record<string, Finding[]>>((acc, finding) => {
    acc[finding.severity] = acc[finding.severity] || [];
    acc[finding.severity].push(finding);
    return acc;
  }, {});
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}

function clearDiagnostics() {
  diagnosticCollection.clear();
}

function applyDiagnostics(repoRoot: string, findings: Finding[]) {
  const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

  for (const finding of findings) {
    const filePath = path.isAbsolute(finding.file)
      ? finding.file
      : path.join(repoRoot, finding.file);
    const startLine = Math.max(finding.lineStart - 1, 0);
    const endLine = Math.max(finding.lineEnd - 1, startLine);
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, Number.MAX_SAFE_INTEGER)
    );
    const diagnostic = new vscode.Diagnostic(range, `${finding.title}: ${finding.message}`, mapSeverity(finding.severity));
    const list = diagnosticsByFile.get(filePath) || [];
    list.push(diagnostic);
    diagnosticsByFile.set(filePath, list);
  }

  diagnosticCollection.clear();

  for (const [filePath, diagnostics] of diagnosticsByFile.entries()) {
    const uri = vscode.Uri.file(filePath);
    diagnosticCollection.set(uri, diagnostics);
  }
}

function mapSeverity(severity: Finding["severity"]): vscode.DiagnosticSeverity {
  switch (severity) {
    case "critical":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "suggestion":
      return vscode.DiagnosticSeverity.Hint;
    case "nit":
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 10 });
  return stdout;
}

async function findRepoRoot(startPath: string): Promise<string | undefined> {
  let current = startPath;
  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function getSettings() {
  const config = vscode.workspace.getConfiguration("safecommit");
  return {
    apiBaseUrl: config.get<string>("apiBaseUrl", "http://localhost:8787"),
    apiKey: config.get<string>("apiKey", ""),
    failOnSeverity: config.get<string>("failOnSeverity", "critical"),
    maxDiffBytes: config.get<number>("maxDiffBytes", 200000)
  };
}

async function callBackend(apiBaseUrl: string, apiKey: string, body: { repoId: string; diff: string; files: string[] }): Promise<ReviewResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(`${apiBaseUrl}/v1/review/diff`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const json = (await response.json()) as ReviewResponse;
    return json;
  } finally {
    clearTimeout(timeout);
  }
}
