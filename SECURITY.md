# Security Policy

**简体中文版：[SECURITY.zh-CN.md](./SECURITY.zh-CN.md)**

<!-- 报告邮箱还没定：对外发布前把下面这行换成自己的安全报告地址。
     原来这里挂的是上游骨架作者的邮箱，打进我们的仓库等于把别人当本产品的安全联系人。 -->

## Reporting a vulnerability

If you discover a security vulnerability in Zhiwei, please report it privately — do **not** open a public issue.

**How to report:**
- **A dedicated security address is not published yet.** Until this section is filled in with the product's own contact, report privately through the maintainer of the repository you obtained the build from — do not file a public issue.
- Include in your report: affected version, vulnerability description, reproduction steps, and (if possible) a proof of concept.

We aim to acknowledge reports within 3 business days and will keep you informed of the fix timeline.

## Security design notes

- **Local-first**: all data (projects, chat history, knowledge base, token ledger) stays on the user's machine. There is no cloud storage and no telemetry.
- **Sandboxed agents**: agents can only operate inside their project directory — they cannot read or modify files outside the project root.
- **Local ports**: the backend listens on `127.0.0.1` (WebSocket 8080, health 8081) — loopback only, not exposed to the network.
- **API keys**: model provider keys are stored via environment variables / user configuration; they are never committed to the repository.

## Scope

This policy covers the Zhiwei application and its source code. Vulnerabilities in third-party dependencies should be reported to their respective projects.
