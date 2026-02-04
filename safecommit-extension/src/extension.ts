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

type ReviewEntry = {
  id: string;
  label: string;
  time: string;
  repoRoot: string;
  data: ReviewResponse;
};

type HookStatusPayload = {
  status: "started" | "completed" | "error";
  runId?: string;
  repoRoot?: string;
  timestamp?: string;
  message?: string;
  response?: ReviewResponse;
  label?: string;
};

type HookState = {
  runId?: string;
  lastSignature?: string;
};

let panel: vscode.WebviewPanel | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
let lastReview: ReviewResponse | undefined;
const reviewHistory: ReviewEntry[] = [];
let activeReviewId: string | undefined;
let activeReviewEntry: ReviewEntry | undefined;
const hookWatchers = new Map<string, { watcher: vscode.FileSystemWatcher; repoRoot: string; statusFile: string }>();
const hookStates = new Map<string, HookState>();
const hookPollers = new Map<string, NodeJS.Timeout>();

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection("safecommit");
  context.subscriptions.push(diagnosticCollection);

  context.subscriptions.push(
    vscode.commands.registerCommand("safecommit.reviewStaged", () => reviewStaged(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("safecommit.installHook", () => installHook(context))
  );

  void autoInstallHook(context);
  void setupHookWatchers(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      void setupHookWatchers(context);
      disposeRemovedHookWatchers(event.removed);
    })
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
    openPanel(context);
    if (panel) {
      panel.webview.html = renderHtml({
        entry: activeReviewEntry,
        history: reviewHistory,
        activeId: activeReviewId
      });
    }
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

  openPanel(context);
  if (panel) {
    panel.webview.html = renderLoadingHtml();
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
  const entry: ReviewEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: "Pending commit",
    time: new Date().toLocaleString(),
    repoRoot,
    data: response
  };
  reviewHistory.unshift(entry);
  activeReviewId = entry.id;
  renderResults(context, entry);
  applyDiagnostics(repoRoot, response.findings);
}

async function setupHookWatchers(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    const repoRoot = await findRepoRoot(folder.uri.fsPath);
    if (!repoRoot) {
      continue;
    }
    await ensureHookWatcher(context, repoRoot);
  }
}

function disposeRemovedHookWatchers(removed: readonly vscode.WorkspaceFolder[]) {
  if (removed.length === 0) {
    return;
  }
  const removedRoots = new Set(removed.map((folder) => folder.uri.fsPath));
  for (const [gitDir, entry] of hookWatchers.entries()) {
    if (removedRoots.has(entry.repoRoot)) {
      entry.watcher.dispose();
      hookWatchers.delete(gitDir);
      hookStates.delete(entry.repoRoot);
      const poller = hookPollers.get(gitDir);
      if (poller) {
        clearInterval(poller);
        hookPollers.delete(gitDir);
      }
    }
  }
}

async function ensureHookWatcher(context: vscode.ExtensionContext, repoRoot: string) {
  const gitDir = await findGitDir(repoRoot);
  if (!gitDir) {
    return;
  }
  if (hookWatchers.has(gitDir)) {
    return;
  }

  const statusFile = path.join(gitDir, "safecommit", "review.json");
  const pattern = new vscode.RelativePattern(vscode.Uri.file(gitDir), "safecommit/review.json");
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const handler = () => {
    void handleHookStatusFile(context, statusFile, repoRoot);
  };

  watcher.onDidCreate(handler);
  watcher.onDidChange(handler);
  hookWatchers.set(gitDir, { watcher, repoRoot, statusFile });
  context.subscriptions.push(watcher);

  seedHookState(statusFile, repoRoot).catch(() => undefined);
  ensureHookPoller(context, gitDir, statusFile, repoRoot);
}

function ensureHookPoller(
  context: vscode.ExtensionContext,
  gitDir: string,
  statusFile: string,
  repoRoot: string
) {
  if (hookPollers.has(gitDir)) {
    return;
  }
  const interval = setInterval(() => {
    void handleHookStatusFile(context, statusFile, repoRoot);
  }, 750);
  hookPollers.set(gitDir, interval);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

async function seedHookState(statusFile: string, repoRoot: string) {
  let content = "";
  try {
    content = await fs.promises.readFile(statusFile, "utf8");
  } catch {
    return;
  }
  let payload: HookStatusPayload;
  try {
    payload = JSON.parse(content) as HookStatusPayload;
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const runId = payload.runId || "";
  const signature = `${runId}|${payload.status}|${payload.timestamp || ""}|${payload.message || ""}`;
  hookStates.set(repoRoot, { runId, lastSignature: signature });
}

async function handleHookStatusFile(context: vscode.ExtensionContext, statusFile: string, fallbackRepoRoot: string) {
  let content = "";
  try {
    content = await fs.promises.readFile(statusFile, "utf8");
  } catch {
    return;
  }

  let payload: HookStatusPayload;
  try {
    payload = JSON.parse(content) as HookStatusPayload;
  } catch {
    return;
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.status !== "started" && payload.status !== "completed" && payload.status !== "error") {
    return;
  }

  const repoRoot = payload.repoRoot || fallbackRepoRoot;
  if (!repoRoot) {
    return;
  }

  const runId = payload.runId || "";
  const signature = `${runId}|${payload.status}|${payload.timestamp || ""}|${payload.message || ""}`;
  const state = hookStates.get(repoRoot);
  if (!state && isStaleStatus(payload.timestamp)) {
    hookStates.set(repoRoot, { runId, lastSignature: signature });
    return;
  }
  if (state?.lastSignature === signature) {
    return;
  }

  if ((payload.status === "completed" || payload.status === "error") && state?.runId && runId && state.runId !== runId) {
    return;
  }

  if (payload.status === "started") {
    hookStates.set(repoRoot, { runId, lastSignature: signature });
    openPanel(context);
    if (panel) {
      panel.webview.html = renderLoadingHtml();
    }
    return;
  }

  if (payload.status === "error") {
    hookStates.set(repoRoot, { runId: runId || state?.runId, lastSignature: signature });
    openPanel(context);
    if (panel) {
      panel.webview.html = renderErrorHtml(payload.message || "SafeCommit: pre-commit hook failed.");
      panel.reveal();
    }
    return;
  }

  const response = normalizeReviewResponse(payload.response);
  if (!response) {
    openPanel(context);
    if (panel) {
      panel.webview.html = renderErrorHtml("SafeCommit: pre-commit hook completed without results.");
      panel.reveal();
    }
    return;
  }

  const entry: ReviewEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: payload.label || "Pre-commit",
    time: new Date(payload.timestamp ?? Date.now()).toLocaleString(),
    repoRoot,
    data: response
  };
  reviewHistory.unshift(entry);
  activeReviewId = entry.id;
  renderResults(context, entry);
  panel?.reveal();
  applyDiagnostics(repoRoot, response.findings);
  hookStates.set(repoRoot, { runId: runId || state?.runId, lastSignature: signature });
}

function isStaleStatus(timestamp?: string) {
  if (!timestamp) {
    return false;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return Date.now() - parsed > 2 * 60 * 1000;
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

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "openFile" && activeReviewEntry) {
      const file = message.file as string;
      const line = Number(message.line) || 1;
      const filePath = path.isAbsolute(file)
        ? file
        : path.join(activeReviewEntry.repoRoot, file);
      try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const position = new vscode.Position(Math.max(line - 1, 0), 0);
        const range = new vscode.Range(position, position);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      } catch (error) {
        vscode.window.showErrorMessage(`SafeCommit: Unable to open ${filePath}.`);
      }
      return;
    }

    if (message?.type === "selectReview") {
      const id = message.id as string;
      const entry = reviewHistory.find((item) => item.id === id);
      if (entry) {
        activeReviewId = entry.id;
        renderResults(context, entry);
      }
    }
  });

  if (reviewHistory.length > 0) {
    const entry = reviewHistory.find((item) => item.id === activeReviewId) ?? reviewHistory[0];
    activeReviewId = entry.id;
    renderResults(context, entry);
  } else if (lastReview) {
    const entry: ReviewEntry = {
      id: "last",
      label: "Last review",
      time: new Date().toLocaleString(),
      repoRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
      data: lastReview
    };
    renderResults(context, entry);
  } else {
    panel.webview.html = renderHtml({
      entry: undefined,
      history: [],
      activeId: undefined
    });
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

  try {
    const installed = await installHookFiles(context, repoRoot);
    if (installed) {
      vscode.window.showInformationMessage("SafeCommit: Pre-commit hooks installed.");
    } else {
      vscode.window.showInformationMessage("SafeCommit: Pre-commit hooks already present.");
    }
  } catch (error) {
    vscode.window.showErrorMessage(`SafeCommit: Failed to install hook. ${(error as Error).message}`);
  }
}

async function autoInstallHook(context: vscode.ExtensionContext) {
  const settings = getSettings();
  if (!settings.autoInstallHook) {
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const repoRoot = await findRepoRoot(workspaceFolder.uri.fsPath);
  if (!repoRoot) {
    return;
  }

  try {
    const installed = await installHookFiles(context, repoRoot);
    if (installed) {
      return;
    }
  } catch (error) {
    vscode.window.showWarningMessage(
      `SafeCommit: Auto hook install failed. ${(error as Error).message}`
    );
  }
}

async function installHookFiles(context: vscode.ExtensionContext, repoRoot: string): Promise<boolean> {
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const bashSource = context.asAbsolutePath(path.join("hooks", "pre-commit"));
  const nodeSource = context.asAbsolutePath(path.join("hooks", "pre-commit.js"));
  const bashTarget = path.join(hooksDir, "pre-commit");
  const nodeTarget = path.join(hooksDir, "pre-commit.js");

  try {
    const [bashSourceContent, nodeSourceContent] = await Promise.all([
      readNormalizedFile(bashSource),
      readNormalizedFile(nodeSource)
    ]);

    const bashExists = await fileExists(bashTarget);
    const nodeExists = await fileExists(nodeTarget);
    if (bashExists && nodeExists) {
      const [bashTargetContent, nodeTargetContent] = await Promise.all([
        readNormalizedFile(bashTarget),
        readNormalizedFile(nodeTarget)
      ]);
      const matches =
        bashTargetContent === bashSourceContent &&
        nodeTargetContent === nodeSourceContent;
      if (!matches) {
        return false;
      }

      const [bashNeedsNormalization, nodeNeedsNormalization] = await Promise.all([
        fileNeedsNormalization(bashTarget),
        fileNeedsNormalization(nodeTarget)
      ]);
      if (!bashNeedsNormalization && !nodeNeedsNormalization) {
        return false;
      }
    }

    await fs.promises.mkdir(hooksDir, { recursive: true });
    await fs.promises.writeFile(bashTarget, bashSourceContent, "utf8");
    await fs.promises.writeFile(nodeTarget, nodeSourceContent, "utf8");

    if (process.platform !== "win32") {
      await fs.promises.chmod(bashTarget, 0o755);
      await fs.promises.chmod(nodeTarget, 0o755);
    }

    return true;
  } catch (error) {
    throw error;
  }
}

function renderResults(context: vscode.ExtensionContext, entry: ReviewEntry) {
  if (!panel) {
    openPanel(context);
  }
  if (!panel) {
    return;
  }
  activeReviewEntry = entry;
  panel.webview.html = renderHtml({
    entry,
    history: reviewHistory,
    activeId: activeReviewId
  });
}

function renderHtml(options: { entry?: ReviewEntry; history: ReviewEntry[]; activeId?: string }): string {
  const entry = options.entry;
  const data = entry?.data ?? { requestId: "", findings: [], summary: { totalFindings: 0, bySeverity: {}, durationMs: 0 } };
  const grouped = groupFindings(data.findings);
  const summary = data.summary || { totalFindings: data.findings.length, bySeverity: {}, durationMs: 0 };
  const duration = summary.durationMs ? `${(summary.durationMs / 1000).toFixed(1)}s` : "";
  const fileCount = Object.keys(grouped).length;
  const criticalCount = summary.bySeverity?.critical ?? 0;
  const warningCount = summary.bySeverity?.warning ?? 0;
  const suggestionCount = summary.bySeverity?.suggestion ?? 0;
  const nitCount = summary.bySeverity?.nit ?? 0;
  const passedCount = data.findings.length === 0 ? 1 : 0;
  const statusText =
    criticalCount > 0
      ? `Commit blocked by ${criticalCount} critical issue${criticalCount === 1 ? "" : "s"}`
      : "Commit allowed";
  const severityOrder: Finding["severity"][] = ["critical", "warning", "suggestion", "nit"];
  const severityLabels: Record<Finding["severity"], string> = {
    critical: "Critical",
    warning: "Warning",
    suggestion: "Suggestion",
    nit: "Nit"
  };

  const sections = Object.entries(grouped)
    .map(([file, items], index) => {
      const fileName = file.split(/[\\/]/).pop() || file;
      const issueCount = items.length;
      const issueLabel = `${issueCount} issue${issueCount === 1 ? "" : "s"}`;
      const bySeverity = groupBySeverity(items);
      const severitySections = severityOrder
        .map((severity) => {
          const list = bySeverity[severity] || [];
          if (list.length === 0) {
            return "";
          }
          const findingsHtml = list
            .map((finding) => {
              const lineLabel =
                finding.lineStart === finding.lineEnd
                  ? `line ${finding.lineStart}`
                  : `lines ${finding.lineStart}-${finding.lineEnd}`;
              const patchCopy = finding.patch
                ? `${finding.patch}\n\n${lineLabel}`
                : "";
              const patchButton = finding.patch
                ? `<button class="btn" data-copy="${escapeAttr(patchCopy)}"><span class="icon">++</span>Copy Fix</button>`
                : "";
              const openButton = `
                <button class="btn" data-open-file="${escapeAttr(finding.file)}" data-open-line="${finding.lineStart}">
                  <span class="icon"><></span>
                  Jump to code
                </button>
              `;
              return `
                <div class="finding">
                  <div class="finding-header">
                    <span class="severity ${finding.severity}">${finding.severity.toUpperCase()}</span>
                    <span class="title">${escapeHtml(finding.title)}</span>
                    <span class="lines">${finding.lineStart}-${finding.lineEnd}</span>
                  </div>
                  <div class="message">${escapeHtml(normalizeCopyText(finding.message))}</div>
                  <div class="rationale">${escapeHtml(normalizeCopyText(finding.rationale))}</div>
                  <div class="actions">
                    ${openButton}
                    <button class="btn" data-copy="${escapeAttr(normalizeCopyText(finding.message))}">
                      <span class="icon">>></span>
                      Copy Message
                    </button>
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
        <section class="file-section" data-file-section="${index}">
          <button class="file-header" type="button" data-toggle="${index}" aria-expanded="false">
            <span class="file-name">${escapeHtml(fileName)}</span>
            <span class="file-meta">${issueLabel}</span>
            <span class="chevron" aria-hidden="true">v</span>
          </button>
          <div class="file-content" data-content="${index}">
            ${severitySections}
          </div>
        </section>
      `;
    })
    .join("\n");

  const emptyState = data.findings.length === 0 ? "No findings." : "";
  const historyOptions = options.history
    .map((item) => {
      const selected = item.id === options.activeId ? "selected" : "";
      const label = `${item.label} — ${item.time}`;
      return `<option value="${escapeAttr(item.id)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("\n");

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>SafeCommit Review</title>
        <style>
          :root {
            --bg: #1e1e1e;
            --card: #252526;
            --surface: #1f1f1f;
            --ink: #d4d4d4;
            --muted: #9da0a5;
            --accent: #0e639c;
            --border: #3c3c3c;
            --critical: #f14c4c;
            --warning: #cca700;
            --pass: #4ec9b0;
            --shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
          }
          * {
            box-sizing: border-box;
          }
          body {
            font-family: "Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", sans-serif;
            background: var(--bg);
            color: var(--ink);
            margin: 0;
            padding: 32px;
          }
          .page {
            max-width: 1080px;
            margin: 0 auto;
            background: var(--card);
            border-radius: 24px;
            box-shadow: var(--shadow);
            overflow: hidden;
            border: 1px solid var(--border);
          }
          .hero {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 24px;
            padding: 28px 32px;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
          }
          .hero h1 {
            margin: 0 0 8px;
            font-size: 24px;
            letter-spacing: -0.01em;
          }
          .subtitle {
            margin: 0;
            color: var(--muted);
            font-size: 14px;
          }
          .history {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 10px 14px;
            font-size: 13px;
            min-width: 260px;
            font-family: inherit;
            color: var(--ink);
          }
          .summary-row {
            display: grid;
            grid-template-columns: 1.3fr 1fr;
            gap: 16px;
            padding: 16px 32px;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
          }
          .summary-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 14px 16px;
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 12px;
            min-height: 54px;
          }
          .pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            background: #333333;
            color: var(--ink);
          }
          .pill::before {
            content: "";
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--muted);
          }
          .pill.critical::before {
            background: var(--critical);
          }
          .pill.warning::before {
            background: var(--warning);
          }
          .pill.pass::before {
            background: var(--pass);
          }
          .summary-meta {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 13px;
            color: var(--muted);
          }
          .summary-meta .divider {
            width: 1px;
            height: 16px;
            background: var(--border);
          }
          .status {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            color: var(--ink);
            background: #333333;
          }
          .status.blocked {
            background: #3a1d1d;
            color: var(--critical);
          }
          .status.allowed {
            background: #1f3329;
            color: var(--pass);
          }
          .content {
            padding: 22px 32px 32px;
            background: var(--bg);
          }
          .files {
            display: flex;
            flex-direction: column;
            gap: 14px;
          }
          .file-section {
            border: 1px solid var(--border);
            border-radius: 16px;
            background: var(--card);
            padding: 12px 14px;
          }
          .file-header {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 12px;
            cursor: pointer;
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 10px 12px;
            border-radius: 12px;
            color: inherit;
            text-align: left;
          }
          .file-header:focus {
            outline: 2px solid var(--accent);
            outline-offset: 3px;
          }
          .file-name {
            font-weight: 600;
            font-size: 14px;
          }
          .file-meta {
            color: var(--muted);
            font-size: 12px;
          }
          .chevron {
            margin-left: auto;
            font-size: 12px;
            color: var(--muted);
            transition: transform 0.15s ease;
          }
          .file-section.expanded .chevron {
            transform: rotate(180deg);
          }
          .file-content {
            display: none;
            padding: 12px 4px 4px;
          }
          .file-section.expanded .file-content {
            display: block;
          }
          .severity-group {
            margin-top: 8px;
          }
          .severity-group h3 {
            margin: 12px 0 6px;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--muted);
          }
          .finding {
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 14px;
            background: var(--card);
            margin-top: 12px;
          }
          .finding-header {
            display: flex;
            gap: 12px;
            align-items: center;
            flex-wrap: wrap;
          }
          .severity {
            font-weight: 700;
            font-size: 11px;
            padding: 4px 8px;
            border-radius: 999px;
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }
          .severity.nit { background: #24364a; color: #9cdcfe; }
          .severity.suggestion { background: #1f3329; color: #4ec9b0; }
          .severity.warning { background: #3a2f14; color: #cca700; }
          .severity.critical { background: #3a1d1d; color: #f14c4c; }
          .title {
            font-weight: 600;
            font-size: 14px;
          }
          .lines {
            color: var(--muted);
            font-size: 12px;
            margin-left: auto;
          }
          .message {
            margin-top: 10px;
            line-height: 1.45;
          }
          .rationale {
            margin-top: 8px;
            color: var(--muted);
          }
          .actions {
            margin-top: 12px;
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
          }
          .btn {
            border: 1px solid var(--border);
            background: var(--surface);
            padding: 8px 12px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-family: inherit;
            color: var(--ink);
            line-height: 1;
          }
          .btn:hover {
            background: #333333;
          }
          .icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            border-radius: 6px;
            background: #333333;
            font-weight: 700;
            font-size: 12px;
            color: var(--ink);
            line-height: 1;
            flex-shrink: 0;
          }
          .empty {
            margin: 20px 0 0;
            color: var(--muted);
            font-size: 14px;
          }
          @media (max-width: 900px) {
            body {
              padding: 16px;
            }
            .hero {
              flex-direction: column;
              align-items: flex-start;
            }
            .summary-row {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="hero">
            <div>
              <h1>SafeCommit Review</h1>
            </div>
            <select class="history" id="review-select">
              ${historyOptions || '<option value="">No reviews yet</option>'}
            </select>
          </header>
          <section class="summary-row">
            <div class="summary-card">
              <span class="pill critical">${criticalCount} Critical</span>
              <span class="pill warning">${warningCount} Warnings</span>
              <span class="pill pass">${passedCount} Passed</span>
            </div>
            <div class="summary-card summary-meta">
              <span>Runtime: ${duration || "—"}</span>
              <span class="divider"></span>
              <span>Files: ${fileCount}</span>
              <span class="divider"></span>
              <span class="status ${criticalCount > 0 ? "blocked" : "allowed"}">${statusText}</span>
            </div>
          </section>
          <div class="content">
            ${emptyState ? `<div class="empty">${emptyState}</div>` : ""}
            <div class="files">
              ${sections}
            </div>
          </div>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          const select = document.getElementById("review-select");
          if (select) {
            select.addEventListener("change", (event) => {
              const target = event.target;
              const id = target && target.value ? target.value : "";
              if (id) {
                vscode.postMessage({ type: "selectReview", id });
              }
            });
          }
          document.querySelectorAll("[data-toggle]").forEach((button) => {
            button.addEventListener("click", () => {
              const id = button.getAttribute("data-toggle");
              if (!id) {
                return;
              }
              const section = document.querySelector(\`[data-file-section="\${id}"]\`);
              if (!section) {
                return;
              }
              const expanded = section.classList.toggle("expanded");
              button.setAttribute("aria-expanded", expanded ? "true" : "false");
            });
          });
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
          document.querySelectorAll("button[data-open-file]").forEach((button) => {
            button.addEventListener("click", () => {
              const file = button.getAttribute("data-open-file") || "";
              const line = button.getAttribute("data-open-line") || "1";
              if (file) {
                vscode.postMessage({ type: "openFile", file, line });
              }
            });
          });
        </script>
      </body>
    </html>
  `;
}

function renderLoadingHtml(): string {
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>SafeCommit Review</title>
        <style>
          :root {
            --bg: #1e1e1e;
            --card: #252526;
            --ink: #d4d4d4;
            --muted: #9da0a5;
            --border: #3c3c3c;
          }
          body {
            font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            background: var(--bg);
            color: var(--ink);
            margin: 0;
            padding: 24px;
          }
          .card {
            background: var(--card);
            border: 1px solid var(--border);
            padding: 16px;
            border-radius: 8px;
          }
          .muted {
            color: var(--muted);
          }
        </style>
      </head>
      <body>
        <div class="card">
          <strong>SafeCommit Review</strong>
          <div class="muted">Review in progress…</div>
        </div>
      </body>
    </html>
  `;
}

function renderErrorHtml(message: string): string {
  const safeMessage = escapeHtml(message || "SafeCommit: pre-commit hook failed.");
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>SafeCommit Review</title>
        <style>
          :root {
            --bg: #1e1e1e;
            --card: #252526;
            --ink: #d4d4d4;
            --muted: #9da0a5;
            --border: #3c3c3c;
            --error: #f14c4c;
          }
          body {
            font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
            background: var(--bg);
            color: var(--ink);
            margin: 0;
            padding: 24px;
          }
          .card {
            background: var(--card);
            border: 1px solid var(--border);
            padding: 16px;
            border-radius: 8px;
          }
          .title {
            font-weight: 700;
          }
          .message {
            color: var(--error);
            margin-top: 6px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="title">SafeCommit Review</div>
          <div class="message">${safeMessage}</div>
        </div>
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

function normalizeCopyText(value: string): string {
  if (!value) {
    return value;
  }
  return value.replace(/'([A-Za-z0-9_.$]+\\(\\))'/g, "$1");
}

function normalizeReviewResponse(value: ReviewResponse | undefined): ReviewResponse | undefined {
  if (!value) {
    return undefined;
  }
  const findings = Array.isArray(value.findings) ? value.findings : [];
  const summary = value.summary || { totalFindings: findings.length, bySeverity: {}, durationMs: 0 };
  const normalizedSummary: Summary = {
    totalFindings: typeof summary.totalFindings === "number" ? summary.totalFindings : findings.length,
    bySeverity: summary.bySeverity && typeof summary.bySeverity === "object" ? summary.bySeverity : {},
    durationMs: typeof summary.durationMs === "number" ? summary.durationMs : 0
  };
  return {
    requestId: value.requestId || "",
    findings,
    summary: normalizedSummary
  };
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

async function findGitDir(repoRoot: string): Promise<string | undefined> {
  try {
    const output = await runGit(repoRoot, ["rev-parse", "--git-dir"]);
    const gitDir = output.trim();
    if (!gitDir) {
      return undefined;
    }
    return path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
  } catch {
    return undefined;
  }
}

function getSettings() {
  const config = vscode.workspace.getConfiguration("safecommit");
  return {
    apiBaseUrl: config.get<string>("apiBaseUrl", "http://localhost:8787"),
    apiKey: config.get<string>("apiKey", ""),
    failOnSeverity: config.get<string>("failOnSeverity", "critical"),
    maxDiffBytes: config.get<number>("maxDiffBytes", 200000),
    autoInstallHook: config.get<boolean>("autoInstallHook", true)
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readNormalizedFile(filePath: string): Promise<string> {
  const content = await fs.promises.readFile(filePath, "utf8");
  return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

async function fileNeedsNormalization(filePath: string): Promise<boolean> {
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return true;
  }
  return buffer.includes(0x0d);
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
