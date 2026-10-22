# Contributing

**简体中文版：[CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)**

Thanks for your interest in contributing to Zhiwei! This is a small project.

## Ways to contribute

- **Report bugs**: open an issue with steps to reproduce
- **Suggest features**: open an issue describing the problem you're solving
- **Fix bugs / add features**: fork, branch, code, and open a pull request

## Development setup

See [TECH.md](./TECH.md) for architecture and local development:

```bash
npm install
cp .env.example .env                       # put your key in KNOWE_MODEL_API_KEY
python3.11 -m venv .venv                   # any Python 3.11+ works; 3.12 is what this branch is tested on
.venv/bin/pip install -r backend/requirements.txt
KNOWE_DEV_PYTHON="$PWD/.venv/bin/python" npm run electron:dev
```

In dev mode the Electron main process starts the backend with `python -m backend`, and the
interpreter only comes from `KNOWE_DEV_PYTHON` (otherwise it looks for a bundled `runtime/`, which a
fresh clone does not have). Packaged builds run the PyInstaller binary instead — no Python needed.

## Before submitting a PR

1. Run checks: `npm run typecheck && npm run lint && npm run test`
2. Run backend tests: `pytest backend/tests/` (from `backend/`)
3. Keep changes focused — one PR per concern
4. Update docs if behavior changes (user manual lives in `docs/`)

## Code style

- Frontend: TypeScript strict, ESLint rules enforced (`npm run lint`)
- Backend: Python, follows existing module conventions
- Keep it simple — this project values minimal, readable code over clever abstractions

## License

By contributing, you agree that your contributions are licensed under the [MIT](./LICENSE) license.
