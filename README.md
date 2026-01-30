# SafeCommit

SafeCommit is an MVP that reviews staged git changes with Gemini before commit. It ships as a VS Code extension and a Node.js backend.

## Folder structure

- `safecommit-extension/`
- `safecommit-backend/`

## Backend

### Requirements

- Node.js 18+
- `GEMINI_API_KEY` in the environment

### Setup

```bash
cd safecommit-backend
npm install
cp .env.example .env
```

Edit `.env` with your Gemini API key.

### Run

```bash
npm run dev
```

The backend listens on `http://localhost:8787` by default.

### Endpoint

`POST /v1/review/diff`

Body:

```json
{ "repoId": "string", "diff": "string", "files": ["string"] }
```

Response:

```json
{ "requestId": "string", "findings": [], "summary": { "totalFindings": 0, "bySeverity": {}, "durationMs": 0 } }
```

## VS Code Extension

### Setup

```bash
cd safecommit-extension
npm install
```

### Run in Extension Development Host

1. Open the repo in VS Code.
2. Run `Developer: Toggle Developer Tools` to see logs if needed.
3. Press `F5` to launch an Extension Development Host.
4. In the Dev Host, open a git repo, stage changes, then run:
   - Command Palette → `SafeCommit: Review Staged Changes`

### Settings

- `safecommit.apiBaseUrl` (default `http://localhost:8787`)
- `safecommit.apiKey` (optional)
- `safecommit.failOnSeverity` (default `critical`)
- `safecommit.maxDiffBytes` (default `200000`)

## Pre-commit Hooks

Two hooks are provided:

- Bash: `safecommit-extension/hooks/pre-commit`
- Node: `safecommit-extension/hooks/pre-commit.js`

### Install via VS Code

Run `SafeCommit: Install Pre-Commit Hook` from the Command Palette. This copies both hook files into `.git/hooks/`.

### Manual install

```bash
cp safecommit-extension/hooks/pre-commit .git/hooks/pre-commit
cp safecommit-extension/hooks/pre-commit.js .git/hooks/pre-commit.js
chmod +x .git/hooks/pre-commit .git/hooks/pre-commit.js
```

### Hook configuration (environment variables)

- `SAFECOMMIT_API_BASE_URL` (default `http://localhost:8787`)
- `SAFECOMMIT_API_KEY` (optional)
- `SAFECOMMIT_FAIL_ON_SEVERITY` (default `critical`)
- `SAFECOMMIT_MAX_DIFF_BYTES` (default `200000`)

The hook is bypassable with `git commit --no-verify`.

## Testing on a sample repo

1. Start the backend.
2. Open a git repo and stage some changes.
3. Use the VS Code command or run a commit to trigger the hook.

## Notes

- The backend only analyzes staged diffs (`git diff --cached --unified=3`).
- If the backend is unreachable, the extension shows a friendly error and the hook allows the commit.
