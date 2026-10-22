<div align="center">
  <img src="./public/brand/app-icon.png" alt="Zhiwei" width="120" />
</div>

# 知微 Zhiwei — Command your Agent team through group chat

[English](README.md) | [简体中文](README.zh-CN.md)

Zhiwei turns agents into a team — inside the chat interface you already know. Create a dedicated group chat for each project, and build a team of agents customized to it.

---

## Build your Agent team

Pull different agents into one group chat to serve a single project. Teams are organized by project — every project has its own dedicated group.

<p align="center">
  <video src="https://github.com/user-attachments/assets/4c223c55-42f4-4c47-9c36-c14676afff50" width="80%" controls autoplay loop muted playsinline></video>
</p>

## Customize your team members

Every agent is an independent instance — with its own identity and memory, and a model service you can freely choose for each. Give different members different "brains", so the right member handles the right job.

<p align="center">
  <video src="https://github.com/user-attachments/assets/994cc11b-793e-4ae8-ae65-4850bf257143" width="80%" controls autoplay loop muted playsinline></video>
</p>

## One sentence in, the team works

No prompt engineering, no task breakdowns to write. The Coordinator automatically splits your request into subtasks, assigns them to the right Workers, and reports back. When your decision is needed, a card pops up — one click and the team moves on.

<p align="center">
  <video src="https://github.com/user-attachments/assets/e73a3a42-1089-47bc-a584-92939b9b1dee" width="80%" controls autoplay loop muted playsinline></video>
</p>

## And more

- **Memory & knowledge base**: friendly chat history, favorites, and knowledge base — forward messages across groups, share experience within a project.
- **Safety boundary**: agents only operate inside their project directory — your other files are never touched.

---

## About this branch

**Zhiwei is a fork of the open-source [Knowe](https://github.com/HirezmingD/Knowe-agent-groupchat)
skeleton (MIT).** Upstream provides the parts that were already solved: the agent loop, the project
group chat, the Coordinator's task splitting, permissions and approval gates, memory, context
compaction, skill loading and MCP mounting. That code and its copyright stay with the upstream author.

What this branch adds — the part that makes it an *office* agent rather than a chat agent:

1. **It hands back a real file.** Drop material in, say one sentence, get an editable
   `.pptx` / `.docx` / `.xlsx` — selectable and re-typesettable in Office, in Chinese, not a rendered
   image. Members install their own generation libraries inside the sandbox; no external Office binary needed.
2. **A written spec layer for "what counts as acceptable".** 7 built-in SKILL.md recipes: three writing
   specs (structure and typography requirements per file type), three QA specs carrying
   **15 runnable assertions each**, and one acceptance discipline the Coordinator must follow.
3. **A quality gate that actually rejects.** The skeleton had removed the delivery-review step — its
   "accept / reject" buttons had no implementation behind them. This branch adds the missing layer:
   deliver → QA ticket to the test member → 15 assertions run in the sandbox → fail, and the
   Coordinator issues a rework order. Built without touching the state machine.
4. **Approval cards that don't betray you.** They used to expire silently after 5 minutes; now they wait.
5. **Local account + key hygiene.** A real local login page (PBKDF2, hashes only), and a closed leak where
   `GET /settings` returned API keys in plaintext to the renderer.
6. **Ledger / plan / dashboard**, all from real data — and deliberately no payment integration, no
   server-side accounts, and no invented columns (the ledger has no "signed off by customer" field,
   because that path has no implementation).
7. **The whole frontend redone**: white + black, zero gradients and shadows, one emphasis per screen,
   sizes measured against real products; plus user-spoken member naming with a three-tier resolution rule.

Full change list: [CHANGELOG.md](./CHANGELOG.md) · [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)

---

## Quick start

1. Build the installer locally (`npm run dist:win` / `npm run dist:mac`)
2. Install and open Zhiwei, then configure your model service (API Key)
3. Create a project group chat and start building your Agent team

## Learn more

- 📄 Quick tech overview [TECH.md](./TECH.md) · [简体中文版](./TECH.zh-CN.md)
- 📚 Full user manual [Docs (简体中文)](./docs/CN/00-概述.md) · [Docs (English)](./docs/EN/00-Overview.md)

## License

Licensed under the [MIT](./LICENSE) license.

This project is a derivative of the upstream Knowe skeleton, also MIT-licensed; the upstream
author retains copyright on the original code.

---

*Zhiwei is an AI-assisted tool. Users are responsible for the data and results produced while using it.*
