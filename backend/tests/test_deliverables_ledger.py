"""[v1.0.40] 交付台账单元测试。

台账的全部风险都在「认领」——把一份质检裁决安到错误的文件上，比缺一列更糟。
所以这里测的不是格式，是**归属判据**：
  1) 版本归组：_r1/_r2 归同一个东西；
  2) 出处：靠 sha256 认领，不靠文件名先后；
  3) 裁决：只认菜谱规定的末行「结论：通过/打回」，格式不对就不给结论；
  4) 被检文件：先用「被检」标注行，撞车时才比提及次数；
  5) 查不到出处就明说查不到，绝不借用别人的出处。
"""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from backend.deliverables import base_name, build_ledger


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class LedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="knowe-ledger-"))
        self.work = self.root / "工作目录"
        self.work.mkdir()
        self.runtime = self.root / "runtime"
        (self.runtime / "task-envelopes").mkdir(parents=True)

    # ── 工具 ────────────────────────────────────────────────
    def _file(self, name: str, content: str) -> str:
        p = self.work / name
        p.write_text(content, encoding="utf-8")
        return _sha(p.read_bytes())

    def _deliver(self, task_id: str, order: int, agent_id: str) -> None:
        env = self.runtime / "task-envelopes" / task_id
        env.mkdir(exist_ok=True)
        (env / "attempt_1.json").write_text(json.dumps({
            "instruction_ref": f"handoffs/01-起步/instruction-{order:02d}-{agent_id}-任务.md",
            "goal": "造一个文件",
        }, ensure_ascii=False), encoding="utf-8")

    def _event(self, order: int, task_id: str, agent_id: str, artifacts: list[dict],
               status: str = "SUCCEEDED") -> dict:
        return {
            "type": "completion_view_v1", "seq": order * 100, "ts": f"2026-10-20T0{order}:00:00Z",
            "agent_id": agent_id, "status": status, "task_id": task_id,
            "completion_id": f"cmp_{order}",
            "user_visible": {"summary": "交回", "artifacts": artifacts},
        }

    def _build(self, events: list[dict], roster: dict[str, str] | None = None) -> dict:
        return build_ledger(
            project_id="p1", project_dir=self.work, runtime_dir=self.runtime,
            events=events, roster=roster or {"writer_1": "技术写作 1", "qa_1": "测试 1"},
        )

    def _row(self, out: dict, name: str) -> dict:
        return next(r for r in out["rows"] if r["file"] == name)

    # ── 1) 版本归组 ────────────────────────────────────────
    def test_versions_group_into_one_thing(self) -> None:
        sha1 = self._file("季度复盘_r1.pptx", "第一版")
        sha2 = self._file("季度复盘_r2.pptx", "第二版")
        self._deliver("t1", 1, "writer_1")
        self._deliver("t2", 2, "writer_1")
        events = [
            self._event(1, "t1", "writer_1", [{"path": "季度复盘_r1.pptx", "sha256": sha1}]),
            self._event(2, "t2", "writer_1", [{"path": "季度复盘_r2.pptx", "sha256": sha2}]),
        ]
        out = self._build(events)
        self.assertEqual(base_name("季度复盘_r2"), "季度复盘")
        g = next(x for x in out["groups"] if x["name"] == "季度复盘")
        self.assertEqual(g["version_count"], 2)
        self.assertEqual(g["rework_rounds"], 1)
        self.assertEqual(g["latest_file"], "季度复盘_r2.pptx")

    # ── 2) + 5) 出处靠哈希；对不上就明说 ────────────────────
    def test_provenance_matches_by_hash_not_name(self) -> None:
        sha = self._file("报告.pptx", "现在盘上的这份")
        self._deliver("t1", 1, "writer_1")
        # 事件里声明的是**旧哈希**（文件后来被改过）→ 哈希不命中
        events = [self._event(1, "t1", "writer_1", [{"path": "报告.pptx", "sha256": "deadbeef"}])]
        out = self._build(events)
        r = self._row(out, "报告.pptx")
        # 名字兜底仍然认领，但必须是同一次交付的 agent，不许凭空造出处
        self.assertEqual(r["produced_by"], "writer_1")
        self.assertEqual(out["stats"]["orphans"], [])

        # 盘上一个从没被任何交付声明过的文件 → 未认领，且不算任何人做的
        self._file("野生.xlsx", "不是我产的")
        out2 = self._build(events)
        r2 = self._row(out2, "野生.xlsx")
        self.assertEqual(r2["produced_by"], "")
        self.assertEqual(r2["role"], "")
        self.assertIn("野生.xlsx", out2["stats"]["orphans"])

    # ── 3) 裁决只认菜谱规定的末行 ──────────────────────────
    def test_verdict_requires_recipe_last_line(self) -> None:
        sha = self._file("A.pptx", "内容A")
        sha_b = self._file("B.pptx", "内容B")
        self._deliver("t1", 1, "writer_1")
        events = [self._event(1, "t1", "writer_1", [{"path": "A.pptx", "sha256": sha}])]

        # 合规的打回报告：末行 = 结论：打回（…）
        (self.work / "report-02-qa_1-质检A.md").write_text(
            "# 质检\n- 被检文件：`A.pptx`，实测不合格 3 条\n\n## 六、结论\n"
            "结论：打回（3 条不合格：页数、字号、英文词）\n", encoding="utf-8")
        out = self._build(events)
        ra = self._row(out, "A.pptx")
        self.assertEqual(ra["qa_verdict"], "打回")
        self.assertIn("页数", ra["qa_detail"])

        # 不合规的质检报告：结论写在开头、结尾是别的话 → 不许猜
        (self.work / "report-03-qa_1-质检B.md").write_text(
            "结论：通过\n" + "\n".join(f"- 复核项 {i}：无异常" for i in range(12))
            + "\n被检文件：B.pptx\n\n以上，供参考。\n", encoding="utf-8")
        out2 = self._build(events)
        rb = self._row(out2, "B.pptx")
        self.assertIsNone(rb["qa_verdict"], "末行不合规就不给结论")

    # ── 3b) 作者自判不算通过：裁决权在岗位，不在文案 ────────
    def test_author_cannot_self_certify(self) -> None:
        sha = self._file("C.pptx", "内容C")
        self._deliver("t1", 1, "writer_1")
        events = [self._event(1, "t1", "writer_1", [{"path": "C.pptx", "sha256": sha}])]
        # 技术写作岗自己的留档报告，末行规规矩矩写着「结论：通过」
        (self.work / "report-05-writer_1-自检留档.md").write_text(
            "- 被检文件：`C.pptx`\n\n## 六、结论\n结论：通过\n", encoding="utf-8")
        out = self._build(events)
        self.assertIsNone(self._row(out, "C.pptx")["qa_verdict"], "作者自检不能当质检裁决")
        self.assertIsNone(self._row(out, "report-05-writer_1-自检留档.md")["qa_verdict"])

    # ── 4) 多点名时用「被检」标注 / 提及次数消歧 ────────────
    def test_ambiguous_report_does_not_overwrite_clean_link(self) -> None:
        sha_old = self._file("竞品分析.pptx", "原稿")
        sha_new = self._file("竞品分析_返工.pptx", "返工件")
        self._deliver("t1", 1, "writer_1")
        self._deliver("t2", 11, "writer_1")
        events = [
            self._event(3, "t1", "writer_1", [{"path": "竞品分析.pptx", "sha256": sha_old}]),
            self._event(11, "t2", "writer_1", [{"path": "竞品分析_返工.pptx", "sha256": sha_new}]),
        ]
        # 首轮质检：只点名原稿 → 原稿判打回
        (self.work / "report-09-qa_1-质检.md").write_text(
            "- 被检文件：`/x/竞品分析.pptx`，44475 字节\n\n## 六、结论\n结论：打回（3 条不合格）\n",
            encoding="utf-8")
        # 复测：两个文件都提到（返工件 16 次，原稿 5 次）→ 应归返工件，不许回头改判原稿
        (self.work / "report-12-qa_1-复测.md").write_text(
            "| `竞品分析_返工.pptx`（被检件） | 42362 |\n"
            "- `竞品分析_返工.pptx` 15 条全 PASS\n- 原稿 `竞品分析.pptx` 未变\n"
            "- `竞品分析_返工.pptx` 内容复核\n- `竞品分析_返工.pptx` 字号\n"
            "- `竞品分析_返工.pptx` 页数\n- `竞品分析_返工.pptx` 英文词\n\n"
            "## 六、结论\n结论：通过\n", encoding="utf-8")

        out = self._build(events)
        old = self._row(out, "竞品分析.pptx")
        new = self._row(out, "竞品分析_返工.pptx")
        self.assertEqual(old["qa_verdict"], "打回", "原稿不能被复测报告改判")
        self.assertEqual(old["qa_link"], "被检标注")
        self.assertEqual(new["qa_verdict"], "通过", "复测裁决应归给被提及最多的那一份")
        self.assertEqual(out["stats"]["orphans"], [])


if __name__ == "__main__":
    unittest.main()
