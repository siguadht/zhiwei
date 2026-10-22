"""形象自主命名（v1.0.43）的三档优先级。

规则（用户原话：客户要求加一个「雷军」，派发的形象就叫雷军；没要求就按任务性质叫）：
  ① 用户亲口点的名字（name + user_named=true）→ 原样照抄
  ② 花名册里有这个人（哪怕已归档）→ 旧名拿回来，他回来了还是他
  ③ 都没有 → 按职能给确定性称呼（「前端 1」），绝不掷人名

这里守的是「模型传上来的 name 到底算什么」：带旗标是新人的名字，不带旗标是查花名册的线索。
"""

from __future__ import annotations

import pytest

from backend import runtime_settings
from backend.engine import ProjectEngine
from backend.tools_knowe import KNOWN_ROLES, _parse_agents

FE = KNOWN_ROLES["fe"]


class _FakeStore:
    def __init__(self, rows: dict) -> None:
        self.rows = rows

    def load_roster_full(self, _project_id: str) -> dict:
        return self.rows


def _engine(rows: dict | None = None) -> ProjectEngine:
    eng = object.__new__(ProjectEngine)
    eng._names = {}
    eng._roster = {}
    eng.project_id = "p1"
    eng._store = _FakeStore(rows) if rows is not None else None
    return eng


@pytest.fixture(autouse=True)
def _zh(monkeypatch):
    monkeypatch.setattr(runtime_settings, "language", lambda: "zh")


def test_spoken_name_is_used_verbatim_for_new_member():
    members = _parse_agents(
        [{"role": FE, "name": "雷军", "user_named": True}], _engine()
    )
    assert members[0]["name"] == "雷军"


def test_spoken_name_is_sanitized_not_beautified():
    """只压空白、限长度；不改写成「更合适的称呼」——那是用户的用词。"""
    members = _parse_agents(
        [{"role": FE, "name": "  雷   军  ", "user_named": True}], _engine()
    )
    assert members[0]["name"] == "雷 军"


def test_no_name_falls_back_to_functional_label():
    members = _parse_agents([{"role": FE}], _engine())
    assert members[0]["name"] == f"{FE} 1"


def test_name_without_flag_is_a_lookup_not_a_rename():
    """少了 user_named → name 只是查花名册的线索；查无此人必须打回，不能凭空造人。"""
    with pytest.raises(ValueError):
        _parse_agents([{"role": FE, "name": "雷军"}], _engine())


def test_archived_member_keeps_his_old_name():
    old = f"{FE} 1"
    eng = _engine({"fe_1": {"role": FE, "name": old, "status": "removed"}})
    members = _parse_agents([{"id": "fe_1", "role": FE}], eng)
    assert members[0]["name"] == old


def test_spoken_name_cannot_rename_an_existing_member():
    """给在册（含归档）的人另起名字走资料页，不走拉人这条路——否则历史消息会对不上人。"""
    eng = _engine({"fe_1": {"role": FE, "name": f"{FE} 1", "status": "removed"}})
    with pytest.raises(ValueError):
        _parse_agents(
            [{"id": "fe_1", "role": FE, "name": "雷军", "user_named": True}], eng
        )


def test_stored_roster_name_outranks_spoken_name():
    old = f"{FE} 1"
    eng = _engine({"fe_1": {"role": FE, "name": old, "status": "active"}})
    assert eng.reserve_name("fe_1", FE, spoken_name="雷军") == old


def test_approval_card_and_roster_share_one_name():
    """审批卡上写的名字，必须就是进队后群里的名字（同一个 id 两次调用要一致）。"""
    eng = _engine()
    first = eng.reserve_name("fe_9", FE, spoken_name="雷军")
    assert first == "雷军"
    assert eng.reserve_name("fe_9", FE, spoken_name="雷军") == first
    assert eng.member_name("fe_9") == "雷军"
