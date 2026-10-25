# Changelog

**简体中文版：[CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)**

This file records **only this branch (知微 / Zhiwei)**. Upstream Knowe's own history ends at
**v1.0.38 (2026-08-20)** and is deliberately not reproduced here — for what this branch is and
what was added on top, see the fork statement in [README.md](./README.md).

Version counters on this branch: npm `version` starts at **1.0.39** (next number after upstream's
last published `1.0.38`), installer `productVersion` is **1.0.43.x** (the number shown in
Settings → About).

---

## v1.0.39 / product 1.0.43 (2026-10-19 → 2026-10-21)

### Office delivery — the point of this branch

- End-to-end verified: drop material + one sentence into a project group → get back a **real,
  editable Office file** (`.pptx` / `.docx` / `.xlsx`), openable and selectable in PowerPoint /
  Word / Excel, not a pasted image. Chinese text throughout.
- Members install their own generation libraries inside the sandbox (`python-pptx`,
  `python-docx`, `openpyxl`) — no external Office binary is required to produce a deliverable.

### Recipe layer (SKILL.md)

- Added written acceptance specs for what a deliverable must look like: page count, per-page
  title + bullet count, minimum font size, CJK not overflowing the box, page numbers / footer,
  no leftover placeholders.
- Three recipes shipped (PPT / Word report / Excel check), plus two more rulers so Word and
  Excel deliverables are measured too, not just PPT.
- The spec is attached by the project manager when it assigns work, and each member must run the
  checker itself before handing in.

### Quality gate + automatic rework

- New reviewer role in the loop: on delivery the manager dispatches a QA ticket to the test
  member, which runs the assertion list in the sandbox and writes a report.
- Failed assertions are pushed back as rework orders; the loop (deliver → QA → reject → rework →
  re-check) has been demonstrated live, including on a draft that genuinely fails.
- Approval cards no longer expire after 5 minutes silently — the runtime now uses a
  never-timeout mode, with the expiry state still rendered in the UI.

### Ledger, pricing, dashboard

- New read-only aggregation endpoint `GET /ledger`: deliverables grouped by *thing*, with version
  count, rework rounds, QA verdict and the checked file.
- New `GET /usage?project_id=&days=`: monthly totals plus `daily` and `by_agent` breakdowns.
  Amounts go through the same `aggregate_token_usage` as the Token panel, so the three surfaces
  can never disagree.
- Left sidebar gains 台账 / 版本 / 看板 entries. **No payment integration, no server-side accounts,
  no features actually locked** — the pricing page is display only, and the ledger has no
  "signed off by customer" column because that path has no implementation upstream.

### Frontend rebuild

- Palette reduced to white + black: no gradients, no shadows, one emphasis per screen; semantic
  status moved off red/green (pass = bold black, rejected = underlined black).
- Two left columns merged into one 248px rail with group headings; settings' 220px vertical
  directory collapsed into a horizontal text tab row; contacts / knowledge / favorites rails
  narrowed 332 → 264.
- Chat reading column constrained to 680px and centered; composer square-cornered; the outcome
  panel is now a 460px push rail beside the chat card instead of an overlay that covers it.
- Welcome state replaces the blank screen: heading, a usable input, three example briefs.
- Fixed a stale placeholder bug: the composer computed "not connected" text once at mount and
  never refreshed after the socket came up.

### Account, identity, security

- First-run blocker replaced by a real local login page (email + password, PBKDF2-SHA256, hashes
  only — never plaintext).
- Closed a leak where `GET /settings` returned API keys in plaintext to the renderer.
- Brand renamed to 知微 / Zhiwei across window title, tray, installer, About page and sidebar;
  avatar pool rebuilt (13 + 13) with badge-style role labels.
- Contact details and the upstream update feed removed from the shipped app.

### Member naming

- A user-spoken member name now wins over generated labels, in three tiers: spoken name →
  persisted roster name (including archived members) → role + sequence fallback.
- Spoken names are sanitized (whitespace collapsed, capped at 24 chars) and cannot rename an
  existing member; requesting a name for an unknown member id is rejected rather than silently
  invented. 8 backend tests cover the tiers.

### Demo & shipped assets (2026-10-25)

- `skills/system/`: the 7 built-in recipes (3 writing specs + 3 QA specs + 1 acceptance discipline)
  are now **version-controlled**. They used to live only inside the gitignored data directory, so a
  fresh clone got an empty folder and the README's "7 built-in SKILL.md recipes" was untrue for
  everyone else.
- `demo/hotel/`: hotel-scenario demo pack — a fictional outlet (景岸·杭州钱江世纪城店), its October
  2026 operations ledger, the group's quality-inspection notice, the regional manager's review
  requirements, plus three paste-ready work orders. The ledger is script-generated with its own
  conservation assertions, and one inconsistency is planted on purpose (GOP 40.04% against a 42%
  budget, which cannot be signed off unless it is traced to specific cost lines) so that
  "QA rejects → rework → re-check" actually happens during a demo instead of being narrated.
  Brand, outlet and every number are invented.
- Recipes now ship with the installer: `electron-builder.yml` copies `skills/` into
  `resources/skills` and the main process injects `KNOWE_SYSTEM_SKILLS_DIRS` when packaged.
  Without this, a clean install could only look for recipes in a data directory that does not exist
  until after install — i.e. no writing specs, no QA rulers on a new machine.
  Verified against the installed build (2026-10-25): `Contents/Resources/skills` holds all 7
  `SKILL.md`, and the live `KnoweBackend` process carries
  `KNOWE_SYSTEM_SKILLS_DIRS=<app>/Contents/Resources/skills` (read out of its process environment);
  it binds 127.0.0.1:8080/8081. Not yet re-run: an actual task inside the packaged app, which needs
  clicks — the release build deliberately has no remote-debugging port.
- `demo/hotel/产出示例/`: one real run kept as evidence — the 3 final files (with byte counts and
  SHA-256 that still match), the 8 in-workspace QA/author reports, and all 24 dispatch artifacts
  (12 `instruction-*` + 12 `report-*`, including the two `status: FAILED` ones). Local absolute
  paths were replaced with `<项目根>`; nothing else was edited.
- The three QA recipes now pin where the report goes and what it is called
  (`report-<step>-<agentId>-<title>.md`, at the project root, not in a subfolder), because the
  delivery ledger claims verdicts by that name and showed "未质检" for reports that did exist.
  The PPT and Excel writing recipes now also require document properties
  (`core_properties.author`, `wb.properties.creator`) to be set before saving — python-pptx ships a
  blank template whose author is a stranger, and that name used to end up in every deck we delivered.

### Packaging notes (found the hard way, 2026-10-25)

- `npm run dist:mac` assembles the installer from whatever sits in `dist/KnoweBackend/`; it does not
  rebuild the Python backend. Ours was three days old, so backend fixes from this round were in the
  repo but not in the app until PyInstaller was re-run (TECH.md, step 1). Check that directory's
  timestamp after any backend change.
- The chain also stops at `copy:chromium` when the backend interpreter has no `playwright`
  installed, before `electron-builder` ever runs. This build skipped that step, so the installer
  carries no bundled headless Chromium — same as the previously installed build.

### Documentation

- 90 broken image references across 44 doc pages fixed (paths pointed at `docs/assets/` from
  inside `docs/CN|EN/`).
- Stale version numbers and anchors in the changelog / account pages updated to v1.0.43.

---

## Older versions

v1.0.38 and earlier belong to upstream Knowe and are not maintained here.
