# Zhiwei — Technical Overview

A quick technical guide for developers who want to run, build, or extend Zhiwei. Zhiwei is a branch of
upstream Knowe; what was added on top is listed in [README.md → About this branch](./README.md#about-this-branch).
For the full user manual, see [docs](./docs/EN/00-Overview.md) (中文见 [docs/CN](./docs/CN/00-概述.md)).

---

## Architecture at a glance

![Zhiwei architecture](./docs/assets/TECH-architecture-en.png)

- **Frontend**: Electron + React 18 + TypeScript, built with electron-vite
- **Backend**: Python 3.11 (FastAPI-style async server), packaged with PyInstaller
- **Communication**: local WebSocket (127.0.0.1:8080) + health endpoint (127.0.0.1:8081)
- **Data**: stored locally — see [Data & privacy](#data--privacy)

## Harness: task lifecycle & completion mechanism

The Harness (`backend/knowe_harness/`, ~4,300 lines) is the mechanism layer that governs the full lifecycle of every task — from task envelope and journaling, through the completion state machine, to user-facing projections and outbox delivery. It guarantees the mechanism cannot go wrong: results must be traced and decisions must be recorded — while placing no restriction on agent behavior.

![Harness mechanism](./docs/assets/TECH-harness-en.png)

## Repository layout

| Path | What it is |
|---|---|
| `electron/` | Electron main process & preload (desktop shell, window, updater, tray) |
| `src/` | React renderer (UI components, state, i18n) |
| `backend/` | Python backend (agents, harness, storage, knowledge, tools) |
| `backend/tests/` | Backend test suite (55+ test files) |
| `docs/` | Full user manual (CN + EN) |
| `assets/` | Banner image & demo videos |
| `scripts/` | Build/dev helper scripts |

## Development

Requirements: Node.js 20+, Python 3.11, and a model API key (e.g. DeepSeek).

```bash
# install frontend dependencies
npm install

# install backend dependencies
pip install -r backend/requirements.txt

# run in dev mode (frontend + Electron shell)
npm run electron:dev
```

The backend is started automatically by the Electron main process in dev mode. For backend-only work, see `backend/run_backend.py`.

### Verify / lint / test

```bash
npm run typecheck   # TypeScript check (renderer + main)
npm run lint        # ESLint
npm run test        # Vitest (frontend)
# backend tests: pytest backend/tests/ (from backend/)
```

### Configuration

Configuration is read from environment variables (see `backend/config.py`). Key ones:

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Model provider API key (or configure models in the app UI) |
| `DEEPSEEK_BASE_URL` | Custom provider base URL |
| `KNOWE_AGENT` | Agent mode: `fake` (offline, no LLM) or `deepseek` |
| `KNOWE_DATA_DIR` | Override data directory |

> `KNOWE_*`, `KnoweBackend`, the `knowe:` IPC prefix and `com.knowe.app` are **deliberately kept**: they
> are the runtime protocol between frontend and backend and the keys of data already on disk — renaming
> them breaks the app, not just the cosmetics. The product name lives in the UI and the installer only.

### Model key and `.env`

`KNOWE_MODEL_API_KEY` (legacy `DEEPSEEK_API_KEY` also works) is read at backend startup and injected
into every matching model binding. `.env` is looked for in this order — never via the current working
directory, because the interpreter Electron spawns has an unpredictable `cwd`:
`KNOWE_ENV_FILE` → `<KNOWE_INSTALL_ROOT>/.env` → `<KNOWE_DATA_DIR>/.env` → repo root `.env` → dotenv's
own search. Variables already present in the process environment win; `.env` only fills gaps.

When an env key is injected the module is *sealed*: `settings.json` is rewritten with empty `api_key`
fields, `_persist()` strips secrets on every later save, and `api_snapshot()` / `public_binding()`
expose only `has_api_key`. If no binding matches the declared scope (`KNOWE_MODEL_PROVIDER` /
`KNOWE_MODEL_BASE_URL`), nothing is sealed and the key you saved in Settings stays on disk — a stray
env variable must never silently wipe a user's keys. Never commit `.env`; only `.env.example` is tracked.

## Building the Windows installer

The full build pipeline produces an NSIS installer via electron-builder, with the Python backend bundled by PyInstaller.

```bash
# 1. build the Python backend (PyInstaller) — from backend/
python -m PyInstaller --noconfirm --clean KnoweBackend.spec

# 2. prepare Chromium for browser automation
npm run copy:chromium

# 3. build the full installer (electron-vite build + electron-builder NSIS)
npm run dist:win
```

Output lands in `release/` as `Zhiwei-Setup-<version>.exe`.

> **Note**: after changing backend code, you MUST re-run step 1 (PyInstaller) — electron-builder only assembles the frontend and does not rebuild the backend. Verify the bundled `KnoweBackend.exe` timestamp is fresh after packaging.

## Data & privacy

- All data lives **locally** under the install directory: `data/` (projects, chat history, knowledge base, token ledger)
- Chat history is never deleted by the app
- Agents operate inside a sandboxed project directory — they cannot touch files outside the project root
- No telemetry, no cloud storage: everything stays on your machine

## Common issues

| Symptom | Likely cause / fix |
|---|---|
| App opens but agents don't respond | Model API key missing or invalid — configure in Settings → Models |
| Backend fails to start | Port 8080/8081 occupied — check for another Zhiwei instance |
| Installer is ~250 MB | Normal: bundles Python runtime + Chromium for browser automation |

## License

[MIT](./LICENSE)
