# Safecommit (Local code reviewer)

Safecommit is a local-first workflow that reviews **staged** Git changes before you commit. It ships as:

- A VS Code extension that shows a review panel and diagnostics
- A Node.js backend that talks to Gemini
- Optional pre-commit hooks (bash + node) for terminal workflows

## Screenshots

Add your screenshots here:

- `docs/panel.png`
- `docs/terminal.png`

Example embeds (leave as-is and replace the files):

![Safecommit panel](docs/panel.png)
![Safecommit terminal](docs/terminal.png)

## Features

- Review staged diffs with Gemini before committing
- Inline diagnostics and a rich results panel
- History of recent reviews
- Optional pre-commit hook that can block commits by severity

## Folder Structure

- `safecommit-backend/` Node.js API that calls Gemini
- `safecommit-extension/` VS Code extension + hook scripts

## Quickstart

### 1) Backend (local API)

```bash
cd safecommit-backend
npm install
cp .env.example .env
```

Set your Gemini key in `safecommit-backend/.env`, then:

```bash
npm run dev
```

Default API base URL: `http://localhost:8787`

### 2) VS Code extension (dev host)

```bash
cd safecommit-extension
npm install
```

Then in VS Code:

1. Open the repo folder.
2. Press `F5` to launch an Extension Development Host.
3. In the Dev Host, open a Git repo, stage changes, then run:
   - Command Palette → `SafeCommit: Review Staged Changes and Open Results Panel`

## Pre-commit Hook (optional)

Install from VS Code:

- Command Palette → `SafeCommit: Install Pre-Commit Hook`

Manual install:

```bash
cp safecommit-extension/hooks/pre-commit .git/hooks/pre-commit
cp safecommit-extension/hooks/pre-commit.js .git/hooks/pre-commit.js
chmod +x .git/hooks/pre-commit .git/hooks/pre-commit.js
```

The hook is bypassable with `git commit --no-verify`.

## Configuration

### VS Code settings

- `safecommit.apiBaseUrl` (default `http://localhost:8787`)
- `safecommit.apiKey` (optional)
- `safecommit.failOnSeverity` (default `critical`)
- `safecommit.maxDiffBytes` (default `200000`)
- `safecommit.autoInstallHook` (default `true`)

### Hook environment variables

- `SAFECOMMIT_API_BASE_URL` (default `http://localhost:8787`)
- `SAFECOMMIT_API_KEY` (optional)
- `SAFECOMMIT_FAIL_ON_SEVERITY` (default `critical`)
- `SAFECOMMIT_MAX_DIFF_BYTES` (default `200000`)

## API

`POST /v1/review/diff`

```json
{ "repoId": "string", "diff": "string", "files": ["string"] }
```

Response:

```json
{
  "requestId": "string",
  "findings": [],
  "summary": { "totalFindings": 0, "bySeverity": {}, "durationMs": 0 }
}
```

## Security & Privacy Notes

- The backend sends diffs to Gemini. Don’t use this on sensitive/private code unless you’re comfortable with that.
- The extension and hook do not store diffs on disk; they send the staged diff to the backend in memory.
- Keep your API keys out of git. This repo ships only `.env.example`.

## Development Notes

- The backend reads staged diffs with `git diff --cached --unified=3`.
- If the backend is unreachable, the extension shows an error and the hook allows the commit.

## License

MIT (see `LICENSE`).
