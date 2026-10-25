"""
[v1.0.40] 交付台账（只读）。

一句话：把「这个项目到底产出了什么、谁做的、质检怎么判的」摊成一张表。

数据源三块，全是磁盘上已有的权威，本模块只读不写：
· 项目工作目录的文件清单 + sha256      → 东西**在不在**（这是唯一权威）
· completion_view_v1.user_visible.artifacts[] → 谁在哪一次交付里产出了这个哈希的文件
· handoffs/instruction-NN-*.md + report-NN-*.md → 派工单号、质检裁决

质检裁决的取法有依据，不是猜的：《交付验收纪律》菜谱规定质检报告
**末行只能是「结论：通过」或「结论：打回（k 条不合格：…）」**，所以末行即字段。
报告与交付物的关联用「报告正文点名的交付文件名」匹配；点名多个或零个 →
标记 ambiguous，宁可显示「关联不明确」也不替用户编一个结论。

已知缺口（如实说明，不做假数据填坑）：
· **签收**没有结构化记录——`accept_delivery` 只是 completion 里的建议动作字符串
  （knowe_harness/completion.py:96），没有任何代码实现它，也没有对应事件。
  所以台账不含签收列。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

# 大于这个体积的文件不算哈希（只按文件名认领出处），避免台账把用户大盘子拖慢
_MAX_HASH_BYTES = 8 * 1024 * 1024

_DELIVERABLE_EXTS = {".pptx", ".docx", ".xlsx", ".ppt", ".doc", ".xls", ".pdf", ".md", ".csv"}
_SUPPORT_PREFIXES = ("make_", "verify_", "check_", "build_", "gen_")

_REPORT_RE = re.compile(r"^report-(\d{1,4})-([A-Za-z0-9_\u4e00-\u9fff]+)-(.+)\.md$")
# 成员实际写报告时用的是中文文件名（报告_品质经营复盘质检.md），而且常放进子目录
# （脚本/、报告/）。交付物按菜谱恒落在项目根，报告却不一定 —— 所以报告递归找、
# 交付物只看根目录。名字里带这些词的 .md 才进报告池，再靠岗位判据决定谁能出裁决。
_REPORTISH_RE = re.compile(r"质检|复测|验收|审校|自检|审核")
_REPORT_SKIP_DIRS = {"_libs", "node_modules", "__pycache__", "素材", "rec"}
_INSTRUCTION_RE = re.compile(r"instruction-(\d{1,4})-([A-Za-z0-9_\u4e00-\u9fff]+)-(.+)\.md$")
_QA_VERDICT_RE = re.compile(r"^结论：\s*(通过|打回)(（(.*)）)?\s*$")
# 版本号后缀：_r1 / _v2 / _返工 / _合格 —— 归组时剥掉，剩下的就是「同一个东西」
_VERSION_SUFFIX_RE = re.compile(r"(_r\d+|_v\d+|_R\d+|_V\d+|_返工|_复测|_重做)+$")


def _sha256(path: Path) -> str | None:
    try:
        if path.stat().st_size > _MAX_HASH_BYTES:
            return None
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 16), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _iso(ts: Any) -> str:
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts).isoformat(timespec="seconds")
    return str(ts or "")


def base_name(stem: str) -> str:
    """剥掉版本后缀，得到「东西名」。季度复盘_r2 → 季度复盘。"""
    prev = None
    cur = stem
    while cur != prev:
        prev = cur
        cur = _VERSION_SUFFIX_RE.sub("", cur)
    return cur or stem


def _classify(name: str, ext: str) -> str:
    if _REPORT_RE.match(name):
        return "质检报告" if "质检" in name or "复测" in name else "交付报告"
    if ext in _DELIVERABLE_EXTS and not name.startswith(_SUPPORT_PREFIXES):
        return "交付物"
    if ext == ".py" and name.startswith(_SUPPORT_PREFIXES):
        return "支撑脚本"
    return "其它"


def _agent_slug(name: str) -> str:
    m = _REPORT_RE.match(name)
    return m.group(2) if m else ""


# ═══════════════════════════════════════════════════════════════
# 事件侧：把每次交付声明的产物做成 (文件名, 哈希) → 出处 的索引
# ═══════════════════════════════════════════════════════════════

def _index_artifacts(events: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    idx: dict[tuple[str, str], dict[str, Any]] = {}
    for ev in events:
        if ev.get("type") != "completion_view_v1":
            continue
        uv = ev.get("user_visible") or {}
        arts = uv.get("artifacts")
        if not isinstance(arts, list):
            continue
        meta = {
            "agent_id": str(ev.get("agent_id") or ""),
            "ts": _iso(ev.get("ts")),
            "seq": ev.get("seq"),
            "status": str(ev.get("status") or ""),
            "task_id": str(ev.get("task_id") or ""),
            "completion_id": str(ev.get("completion_id") or ""),
        }
        for a in arts:
            if not isinstance(a, dict):
                continue
            p = str(a.get("path") or a.get("name") or "").strip()
            if not p:
                continue
            name = Path(p).name
            sha = str(a.get("sha256") or "")
            # 后到的覆盖先到的：同一 (name, sha) 属于最新那次交付
            idx[(name, sha)] = meta
            idx.setdefault(("*", name), meta)   # 名字兜底索引（哈希对不上时退而求其次）
    return idx


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _task_orders(runtime_dir: Path) -> dict[str, dict[str, Any]]:
    """task_id → 派工单号/阶段。来自 task-envelopes 的 instruction_ref。"""
    out: dict[str, dict[str, Any]] = {}
    root = runtime_dir / "task-envelopes"
    if not root.is_dir():
        return out
    for task_dir in sorted(root.iterdir()):
        if not task_dir.is_dir():
            continue
        attempts = sorted(task_dir.glob("*.json"))
        if not attempts:
            continue
        env = _read_json(attempts[-1])
        ref = str(env.get("instruction_ref") or "")
        m = _INSTRUCTION_RE.search(ref)
        stage = ""
        parts = Path(ref).parts
        if len(parts) >= 2:
            stage = parts[-2]
        out[task_dir.name] = {
            "order": int(m.group(1)) if m else None,
            "slug": m.group(3) if m else "",
            "stage": stage,
            "goal": str(env.get("goal") or ""),
        }
    return out


# ═══════════════════════════════════════════════════════════════
# 质检侧：报告末行取裁决，正文点名认领被检文件
# ═══════════════════════════════════════════════════════════════

def _walk_reports(project_dir: Path) -> list[Path]:
    """项目根 + 一层子目录里的候选报告文件；依赖盘和素材盘不进。"""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(project_dir):
        depth = len(Path(dirpath).relative_to(project_dir).parts)
        if depth >= 1:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in _REPORT_SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if not fn.endswith(".md") or fn.startswith("."):
                continue
            if _REPORT_RE.match(fn) or _REPORTISH_RE.search(fn):
                out.append(Path(dirpath) / fn)
    return sorted(out)


def _verdict_of(report_path: Path) -> dict[str, Any]:
    """
    读裁决：菜谱规定报告末行只能是「结论：通过」或「结论：打回（k 条不合格：…）」。
    容忍结尾空行与一两个页脚行，所以往回扫最后 6 个非空行取第一条命中的；
    整段都不合规 → verdict=None，宁可显示「未质检」也不替用户编结论。
    """
    try:
        lines = [l.strip() for l in report_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    except OSError:
        return {"verdict": None, "detail": "", "line": ""}
    for line in reversed(lines[-6:]):
        m = _QA_VERDICT_RE.match(line)
        if m:
            return {"verdict": m.group(1), "detail": (m.group(3) or "").strip(), "line": line}
    return {"verdict": None, "detail": "", "line": ""}


def _target_of_report(text: str, candidates: list[str]) -> tuple[list[str], str]:
    """
    从质检报告里认领「被检的是哪个文件」。两级判据，都基于菜谱用词：
    1) 带「被检」标注的行里出现的交付文件名——这是报告自己声明的对象；
    2) 第 1 级撞出多个时，比全文提及次数，唯一最多者胜出。
    都分不出来 → 返回空 + ambiguous，绝不猜。
    """
    hits = [c for c in candidates if c in text]
    if not hits:
        return [], "未点名"
    label_lines = [l for l in text.splitlines() if "被检" in l]
    label_text = "\n".join(label_lines)
    labelled = [c for c in hits if c in label_text]
    if len(labelled) == 1:
        return labelled, "被检标注"
    pool = labelled or hits
    counts = {c: text.count(c) for c in pool}
    top = max(counts.values())
    winners = [c for c, n in counts.items() if n == top]
    if len(winners) == 1:
        return winners, f"提及{top}次"
    return pool, "关联不明确"


# ═══════════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════════

def build_ledger(
    *,
    project_id: str,
    project_dir: Path | None,
    runtime_dir: Path,
    events: list[dict[str, Any]],
    roster: dict[str, str],
) -> dict[str, Any]:
    """roster: agent_id → 职能标签（来自花名册，不在此生成名字）。"""
    artifact_idx = _index_artifacts(events)
    orders = _task_orders(runtime_dir)

    dir_exists = bool(project_dir and project_dir.is_dir())
    files: list[Path] = []
    if dir_exists:
        try:
            files = [p for p in sorted(project_dir.iterdir()) if p.is_file() and not p.name.startswith(".")]
        except OSError:
            dir_exists = False
            files = []

    names = [p.name for p in files]
    deliverable_names = [n for n in names if _classify(n, Path(n).suffix.lower()) == "交付物"]

    rows: list[dict[str, Any]] = []
    for p in files:
        ext = p.suffix.lower()
        if ext not in _DELIVERABLE_EXTS and ext != ".py":
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        category = _classify(p.name, ext)
        sha = _sha256(p)
        provenance = artifact_idx.get((p.name, sha or ""), {}) if sha else {}
        if not provenance:
            provenance = artifact_idx.get(("*", p.name), {})
        task_id = str(provenance.get("task_id") or "")
        order = orders.get(task_id, {})
        rows.append({
            "file": p.name,
            "ext": ext.lstrip("."),
            "bytes": st.st_size,
            "mtime": _iso(st.st_mtime),
            "sha256": sha,
            "category": category,
            "produced_by": provenance.get("agent_id") or "",
            "role": roster.get(provenance.get("agent_id") or "", ""),
            "produced_at": provenance.get("ts") or "",
            "delivery_status": provenance.get("status") or "",
            "order": order.get("order"),
            "stage": order.get("stage") or "",
            "task_id": task_id,
        })

    # ── 质检报告：认领被检文件 + 末行裁决 ──────────────────────
    qa_by_target: dict[str, list[dict[str, Any]]] = {}
    qa_reports: dict[str, dict[str, Any]] = {}
    report_pool: dict[str, Path] = {p.name: p for p in files if p.suffix == ".md"}
    if dir_exists:
        for p in _walk_reports(project_dir):
            report_pool.setdefault(p.name, p)
    for p in report_pool.values():
        m = _REPORT_RE.match(p.name)
        if not m and not _REPORTISH_RE.search(p.name):
            continue
        text = ""
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            pass
        # 中文名报告里没有人称，作者只能从交付事件反查：谁交的这个文件。
        provenance = artifact_idx.get(("*", p.name), {})
        agent_id = m.group(2) if m else str(provenance.get("agent_id") or "")
        role = roster.get(agent_id, "")
        is_qa = is_qa_report(agent_id, role)
        # ★ 只有质检岗的报告才带裁决。作者自己写「结论：通过」不算通过——
        #   判过的权利在测试岗手上，这是《交付验收纪律》的底线，不能让取数逻辑绕过它。
        verdict = _verdict_of(p) if is_qa else {"verdict": None, "detail": "", "line": ""}
        entry = {
            "report": p.name,
            "order": int(m.group(1)) if m else 0,
            "agent_id": agent_id,
            "role": role,
            "ts": str(provenance.get("ts") or _iso(p.stat().st_mtime)),
            "link": "",
            "targets": [],
            **verdict,
        }
        qa_reports[p.name] = entry
        if not is_qa:
            continue
        targets, link = _target_of_report(text, deliverable_names)
        entry["link"] = link
        entry["targets"] = targets
        if targets:
            for t in targets:
                qa_by_target.setdefault(t, []).append(entry)
        else:
            qa_by_target.setdefault("__unlinked__", []).append(entry)

    for r in rows:
        if r["category"] == "支撑脚本":
            continue
        own = qa_reports.get(r["file"])
        qas = sorted(qa_by_target.get(r["file"], []), key=lambda x: (x["order"], x["ts"]))
        r["qa"] = qas
        if own and own.get("verdict"):
            r["qa_verdict"], r["qa_detail"] = own["verdict"], own["detail"]
        else:
            r["qa_verdict"] = qas[-1]["verdict"] if qas else None
            r["qa_detail"] = qas[-1]["detail"] if qas else ""
        r["qa_link"] = qas[-1]["link"] if qas else ""
        # 报告行要知道自己检的是哪个东西；交付物行这里恒为空（它的质检在 qas 里）。
        r["checked"] = list(own["targets"]) if own and r["category"] != "交付物" else []

    # ── 按「东西」归组 ────────────────────────────────────────
    groups: dict[str, dict[str, Any]] = {}
    for r in rows:
        if r["category"] not in ("交付物", "其它"):
            continue
        key = base_name(Path(r["file"]).stem)
        g = groups.setdefault(key, {"name": key, "ext": r["ext"], "versions": [], "orders": []})
        g["versions"].append(r["file"])
        if r["order"] is not None:
            g["orders"].append(r["order"])

    group_list: list[dict[str, Any]] = []
    for key, g in groups.items():
        vs = [r for r in rows if r["file"] in g["versions"]]
        vs.sort(key=lambda r: (r["produced_at"] or r["mtime"]))
        latest = vs[-1] if vs else {}
        verdicts = [r["qa_verdict"] for r in vs if r["qa_verdict"]]
        group_list.append({
            "name": key,
            "ext": g["ext"],
            "version_count": len(vs),
            "rework_rounds": max(0, len(vs) - 1),
            "latest_file": latest.get("file") or "",
            "latest_bytes": latest.get("bytes"),
            "latest_role": latest.get("role") or latest.get("produced_by") or "",
            "latest_verdict": verdicts[-1] if verdicts else None,
            "orders": sorted(g["orders"]),
            "files": g["versions"],
        })
    group_list.sort(key=lambda x: (-x["version_count"], x["name"]))

    rows.sort(key=lambda r: (r["produced_at"] or r["mtime"]), reverse=True)
    orphan = [r["file"] for r in rows if r["category"] == "交付物" and not r["produced_by"]]

    return {
        "project_id": project_id,
        "project_dir": str(project_dir) if project_dir else "",
        "project_dir_exists": dir_exists,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "rows": rows,
        "groups": group_list,
        "qa_unlinked": qa_by_target.get("__unlinked__", []),
        "stats": {
            "files": len(rows),
            "deliverables": len(deliverable_names),
            "groups": len(group_list),
            "with_provenance": sum(1 for r in rows if r["category"] == "交付物" and r["produced_by"]),
            "orphans": orphan,
        },
    }


_QA_ID_PREFIXES = ("qa", "sec", "sre")        # KNOWN_ROLES 里担裁判角色的前缀
_QA_ROLE_HINTS = ("质检", "测试", "验收", "审校")


def is_qa_report(agent_id: str, role: str) -> bool:
    """
    这份报告出自质检岗之手吗？判据只走**结构**，不读正文：
    · agent_id 前缀 ∈ 裁判角色前缀表（tools_knowe.KNOWN_ROLES 的同一套钥匙）；
    · 或花名册职能标签带质检/测试/验收。

    ★ 故意不做「正文里有结论行就当它是质检」这种兜底——那等于让作者
      自己写一行「结论：通过」就能给自己的交付盖通过章。裁决权在岗位，不在文案。
    """
    head = (agent_id or "").split("_")[0].lower()
    if head in _QA_ID_PREFIXES:
        return True
    return any(h in (role or "") for h in _QA_ROLE_HINTS)
