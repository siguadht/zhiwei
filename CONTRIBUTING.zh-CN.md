# 贡献指南

**English version: [CONTRIBUTING.md](./CONTRIBUTING.md)**

感谢您对知微感兴趣！这是一个小项目。

## 参与方式

- **报告 bug**：提交 issue，附上复现步骤
- **建议功能**：提交 issue，描述你想解决的问题
- **修 bug / 加功能**：fork → 建分支 → 写代码 → 提交 pull request

## 开发环境

架构与本地开发说明见 [TECH.zh-CN.md](./TECH.zh-CN.md)：

```bash
npm install
cp .env.example .env                       # 密钥填进 KNOWE_MODEL_API_KEY
python3.11 -m venv .venv                   # 3.11 及以上都行，本分支实测用的是 3.12
.venv/bin/pip install -r backend/requirements.txt
KNOWE_DEV_PYTHON="$PWD/.venv/bin/python" npm run electron:dev
```

开发态由 Electron 主进程用 `python -m backend` 拉起后端，解释器只认 `KNOWE_DEV_PYTHON`——不设的话它
去找随包的 `runtime/`，而刚 clone 下来的仓库里没有这个目录。打包版直接跑 PyInstaller 产物，不需要本机 Python。

## 提交 PR 之前

1. 运行检查：`npm run typecheck && npm run lint && npm run test`
2. 运行后端测试：`pytest backend/tests/`（在 `backend/` 目录下执行）
3. 保持改动聚焦——一个 PR 只做一件事
4. 行为变化时更新文档（用户手册在 `docs/`）

## 代码风格

- 前端：TypeScript 严格模式，遵循 ESLint 规则（`npm run lint`）
- 后端：Python，遵循现有模块约定
- 保持简单——本项目推崇极简、可读的代码，而非花哨的抽象

## 许可证

参与贡献即表示您同意您的贡献以 [MIT](./LICENSE) 许可证授权。
