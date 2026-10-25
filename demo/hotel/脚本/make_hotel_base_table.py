"""生成《景岸·杭州钱江世纪城店 2026年10月经营数据底表》。

日明细是唯一真源：房价/入住率按天给定，其余所有表都由它派生，
这样任何一份交付物里的数字都能在这张表里找到出处。
"""
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

SELLABLE = 148          # 150 间客房，10 月封 2 间做卫生间返修
OUT_OF_ORDER = 2
NON_ROOM_REVENUE = 118_600
BREAKFAST_RATIO = 0.72

# 日期: (入住率, 平均房价, 当日说明)
DAILY = {
    date(2026, 10, 1):  (0.97, 588, "国庆假期首日，会议团队叠加"),
    date(2026, 10, 2):  (0.98, 618, "假期第二天，周边游客源为主"),
    date(2026, 10, 3):  (0.98, 638, "假期峰值，超额预订 3 间"),
    date(2026, 10, 4):  (0.97, 628, "假期第四天，价格开始回落"),
    date(2026, 10, 5):  (0.94, 568, "假期末段，家庭客群提前退房"),
    date(2026, 10, 6):  (0.90, 488, "假期倒数第二天，散客补量"),
    date(2026, 10, 7):  (0.85, 438, "假期最后一天，晚到客源偏少"),
    date(2026, 10, 8):  (0.79, 348, "工作日，商务客源回补"),
    date(2026, 10, 9):  (0.83, 368, "周五，商务加短途"),
    date(2026, 10, 10): (0.88, 408, "周六，市区展览带动"),
    date(2026, 10, 11): (0.76, 348, "周日，展会散场后回落"),
    date(2026, 10, 12): (0.74, 328, "周一，本月最低价位"),
    date(2026, 10, 13): (0.75, 332, "工作日，协议客户稳定"),
    date(2026, 10, 14): (0.78, 342, "工作日，两个长包房入住"),
    date(2026, 10, 15): (0.80, 348, "工作日，收益调价上调 6 元"),
    date(2026, 10, 16): (0.82, 358, "周四，商务需求走高"),
    date(2026, 10, 17): (0.87, 398, "周六，亲子客源集中"),
    date(2026, 10, 18): (0.75, 338, "周日，退房集中在上午"),
    date(2026, 10, 19): (0.73, 326, "周一，阴雨天到店偏少"),
    date(2026, 10, 20): (0.76, 334, "工作日，无大型活动"),
    date(2026, 10, 21): (0.78, 340, "工作日，协议客户放量"),
    date(2026, 10, 22): (0.79, 346, "周三，会议团 40 间"),
    date(2026, 10, 23): (0.81, 352, "周四，需求继续走高"),
    date(2026, 10, 24): (0.86, 388, "周六，马拉松赛事周边"),
    date(2026, 10, 25): (0.74, 332, "周日，赛事结束后回落"),
    date(2026, 10, 26): (0.72, 322, "周一，本月入住率最低"),
    date(2026, 10, 27): (0.75, 330, "工作日，长包房续住"),
    date(2026, 10, 28): (0.77, 338, "工作日，价格小幅回升"),
    date(2026, 10, 29): (0.79, 344, "周三，两个旅行团到店"),
    date(2026, 10, 30): (0.84, 372, "周五，月末商务冲刺"),
    date(2026, 10, 31): (0.89, 418, "周六，万圣节主题活动拉动"),
}

# 渠道占比按房晚给定，最后一个渠道吃差额，保证房晚与收入都精确闭合
CHANNELS = [
    ("集团直销（App 与会员）", 0.42, 428, 0.00, "会员权益带动复购，无佣金支出"),
    ("第三方平台（OTA）", 0.26, 402, 0.15, "佣金最高，占比每降 1 个点省约 1.6 万元"),
    ("协议客户（企业签约）", 0.18, 352, 0.08, "含居间服务费，价格低于散客但稳定"),
]

CONTRACT = [
    ("客房布草洗涤", "每房晚 18.0 元", 18.0, "按房晚计，随入住率同比例上升"),
    ("客房一次性耗材", "每房晚 11.5 元", 11.5, "含洗护、拖鞋、瓶装水"),
    ("早餐食材成本", f"每早市人数 {14.0} 元", 14.0, "按入住客数的 72% 折算"),
]

FIXED_COST = [
    ("人力成本（含社保）", 288_000, "26 人编制，国庆加班费 2.4 万元在内"),
    ("物业租金", 220_000, "月付，含公共区域能耗分摊"),
    ("水电气能耗", 96_500, "入住率抬升后比 9 月高 8 千元"),
    ("设备维保与保险", 55_000, "含电梯年检与财产保险摊销"),
    ("市场推广与本地渠道", 38_000, "展会合作与本地生活平台投放"),
]

BRAND_FEE_RATE = 0.045          # 集团品牌使用费，按总营收
LAST_YEAR = {"occ": 0.803, "adr": 368.0}
BUDGET = {"occ": 0.82, "adr": 365.0, "gop_rate": 0.42}
BUDGET["room_revenue"] = round(SELLABLE * 31 * BUDGET["occ"] * BUDGET["adr"])
PREV_MONTH = {"occ": 0.795, "adr": 341.0, "gop_rate": 0.384}
PREV_MONTH["room_revenue"] = round(SELLABLE * 30 * PREV_MONTH["occ"] * PREV_MONTH["adr"])

REVIEW = [
    ("卫生死角（浴缸与地漏）", 4, "浴缸边缘有霉点，地漏返味", "督办第 2 项"),
    ("隔音与邻里噪音", 2, "凌晨能听到走廊说话和临街车流", "督办第 7 项"),
    ("早餐品种与补餐不及时", 2, "八点半后热菜基本空了", "督办第 5 项"),
    ("前台办理效率", 1, "国庆入住排队超过十五分钟", "督办第 1 项"),
]


def build_rows():
    rows = []
    for d in sorted(DAILY):
        occ, adr, note = DAILY[d]
        sold = round(SELLABLE * occ)
        revenue = sold * adr
        wd = "一二三四五六日"[d.weekday()]
        rows.append({
            "date": d, "weekday": f"周{wd}", "sellable": SELLABLE, "sold": sold,
            "occ": sold / SELLABLE, "adr": float(adr), "revenue": revenue,
            "revpar": revenue / SELLABLE, "note": note,
            "is_weekend": d.weekday() >= 5,
        })
    return rows


def totals(rows):
    sellable = sum(r["sellable"] for r in rows)
    sold = sum(r["sold"] for r in rows)
    revenue = sum(r["revenue"] for r in rows)
    return {
        "sellable": sellable,
        "sold": sold,
        "revenue": revenue,
        "occ": sold / sellable,
        "adr": revenue / sold,
        "revpar": revenue / sellable,
        "total_revenue": revenue + NON_ROOM_REVENUE,
    }


def channel_rows(t):
    out = []
    rooms_left, rev_left = t["sold"], t["revenue"]
    for name, share, adr, rate, note in CHANNELS:
        rooms = round(t["sold"] * share)
        revenue = round(rooms * adr)
        rooms_left -= rooms
        rev_left -= revenue
        out.append((name, rooms, rooms / t["sold"], adr, revenue, rate,
                    round(revenue * rate), note))
    name = "上门散客（Walk-in）"
    note = "无签约无佣金，价格由前台按当日余房掌握，均价最高"
    walk_adr = round(rev_left / rooms_left, 2)
    out.append((name, rooms_left, rooms_left / t["sold"], walk_adr, rev_left,
                0.0, 0, note))
    assert sum(r[1] for r in out) == t["sold"], "渠道房晚未闭合"
    assert sum(r[4] for r in out) == t["revenue"], "渠道收入未闭合"
    return out, walk_adr


def cost_rows(t, channels):
    sold = t["sold"]
    variable = []
    for name, basis, unit, note in CONTRACT:
        base = sold if "房晚" in basis else round(sold * BREAKFAST_RATIO)
        variable.append((name, basis, round(base * unit), base, unit, note))
    ota_commission = sum(r[6] for r in channels)
    brand_fee = round(t["total_revenue"] * BRAND_FEE_RATE)
    rows = [
        *variable,
        ("第三方平台佣金", "按平台渠道收入 15%", ota_commission, None, None,
         "含协议客户居间费，占比最大的可变成本"),
        ("集团品牌使用费", f"按总营收 {BRAND_FEE_RATE:.1%}", brand_fee, None, None,
         "加盟费与中央预订服务费合并计收"),
        *[(name, "月度固定", amount, None, None, note) for name, amount, note in FIXED_COST],
    ]
    return rows


def gop(t, costs):
    total_cost = sum(r[2] for r in costs)
    profit = t["total_revenue"] - total_cost
    return total_cost, profit, profit / t["total_revenue"]


def style(ws, widths):
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    ws.freeze_panes = "A2"
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def main():
    rows = build_rows()
    t = totals(rows)
    channels, walk_adr = channel_rows(t)
    costs = cost_rows(t, channels)
    total_cost, profit, gop_rate = gop(t, costs)

    wb = Workbook()

    ws = wb.active
    ws.title = "日经营明细"
    ws.append(["日期", "星期", "可售房数（间）", "已售房数（间）", "入住率",
               "平均房价（元）", "客房收入（元）", "单房收益（元）", "当日说明"])
    for r in rows:
        ws.append([r["date"].strftime("%Y-%m-%d"), r["weekday"], r["sellable"], r["sold"],
                   round(r["occ"], 4), r["adr"], r["revenue"], round(r["revpar"], 2), r["note"]])
    ws.append(["合计", "—", t["sellable"], t["sold"], round(t["occ"], 4),
               round(t["adr"], 2), t["revenue"], round(t["revpar"], 2), "全月口径见本行"])
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row):
        row[4].number_format = "0%"
        row[5].number_format = "0.00"
        row[6].number_format = "#,##0"
        row[7].number_format = "0.00"
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)
    style(ws, [12, 7, 13, 15, 9, 14, 14, 14, 34])

    ws2 = wb.create_sheet("渠道与客源结构")
    ws2.append(["渠道", "房晚数（间夜）", "房晚占比", "平均房价（元）", "渠道收入（元）",
                "佣金率", "佣金成本（元）", "渠道说明"])
    for name, rooms, share, adr, revenue, rate, commission, note in channels:
        ws2.append([name, rooms, round(share, 4), adr, revenue, rate, commission, note])
    total_commission = sum(r[6] for r in channels)
    ws2.append(["合计", t["sold"], 1.0, round(t["adr"], 2), t["revenue"],
                round(total_commission / t["revenue"], 4), total_commission,
                "四档渠道覆盖全部房晚，佣金率为全渠道加权平均"])
    for row in ws2.iter_rows(min_row=2, max_row=ws2.max_row):
        row[2].number_format = "0%"
        row[3].number_format = "0.00"
        row[4].number_format = "#,##0"
        row[5].number_format = "0%"
        row[6].number_format = "#,##0"
    for cell in ws2[ws2.max_row]:
        cell.font = Font(bold=True)
    style(ws2, [24, 15, 11, 14, 14, 9, 14, 46])

    ws3 = wb.create_sheet("成本与GOP")
    ws3.append(["成本项", "计费口径", "金额（元）", "占总营收比", "成本说明"])
    for name, basis, amount, _base, _unit, note in costs:
        ws3.append([name, basis, amount, round(amount / t["total_revenue"], 4), note])
    ws3.append(["成本合计", "—", total_cost, round(total_cost / t["total_revenue"], 4),
                "含可变成本与固定成本"])
    ws3.append(["客房收入", "日明细汇总", t["revenue"], round(t["revenue"] / t["total_revenue"], 4),
                "占总营收主体"])
    ws3.append(["非客房收入", "餐饮、会议室、洗衣、小食", NON_ROOM_REVENUE,
                round(NON_ROOM_REVENUE / t["total_revenue"], 4), "会议室 11 场，自助洗衣 268 单"])
    ws3.append(["总营收", "客房 + 非客房", t["total_revenue"], 1.0, "GOP 计算基数"])
    ws3.append(["营业毛利 GOP", "总营收 − 成本合计", profit, round(gop_rate, 4),
                "对比预算 GOP 率的分子"])
    for row in ws3.iter_rows(min_row=2, max_row=ws3.max_row):
        row[2].number_format = "#,##0"
        row[3].number_format = "0.0%"
    for row in (ws3[ws3.max_row - 2], ws3[ws3.max_row], ws3[ws3.max_row - 1]):
        for cell in row:
            cell.font = Font(bold=True)
    style(ws3, [20, 26, 14, 11, 40])

    ws4 = wb.create_sheet("预算与同期对比")
    ws4.append(["指标", "9月实际", "10月预算", "10月实际", "环比9月",
                "对比去年10月", "预算达成率", "说明"])
    prev_revpar = PREV_MONTH["occ"] * PREV_MONTH["adr"]
    ly_revpar = LAST_YEAR["occ"] * LAST_YEAR["adr"]
    budget_revpar = BUDGET["occ"] * BUDGET["adr"]
    ws4.append(["入住率", PREV_MONTH["occ"], BUDGET["occ"], round(t["occ"], 4),
                round(t["occ"] - PREV_MONTH["occ"], 4),
                round(t["occ"] - LAST_YEAR["occ"], 4),
                round(t["occ"] / BUDGET["occ"], 4), "国庆 7 天贡献最大，月内最低 26 日 72%"])
    ws4.append(["平均房价（元）", PREV_MONTH["adr"], BUDGET["adr"], round(t["adr"], 2),
                round(t["adr"] - PREV_MONTH["adr"], 2),
                round(t["adr"] - LAST_YEAR["adr"], 2),
                round(t["adr"] / BUDGET["adr"], 4), "假期峰值 638 元拉高全月均价"])
    ws4.append(["单房收益（元）", round(prev_revpar, 2), round(budget_revpar, 2),
                round(t["revpar"], 2), round(t["revpar"] - prev_revpar, 2),
                round(t["revpar"] - ly_revpar, 2),
                round(t["revpar"] / budget_revpar, 4), "入住率与房价双高于预算"])
    ws4.append(["客房收入（元）", PREV_MONTH["room_revenue"], BUDGET["room_revenue"],
                t["revenue"], t["revenue"] - PREV_MONTH["room_revenue"],
                "未披露", round(t["revenue"] / BUDGET["room_revenue"], 4),
                "去年同期仅留存房价与入住率，房量口径变更故不做金额同比"])
    ws4.append(["营业毛利率 GOP", PREV_MONTH["gop_rate"], BUDGET["gop_rate"],
                round(gop_rate, 4), round(gop_rate - PREV_MONTH["gop_rate"], 4),
                "未披露", round(gop_rate / BUDGET["gop_rate"], 4),
                "未达预算，主因能耗与洗涤随入住率抬升"])
    for row in ws4.iter_rows(min_row=2, max_row=ws4.max_row):
        if row[0].value in ("入住率", "营业毛利率 GOP"):
            for cell in (row[1], row[2], row[3], row[4], row[5], row[6]):
                if cell.value is not None:
                    cell.number_format = "0.0%"
        elif row[0].value == "单房收益（元）":
            for cell in row[1:7]:
                if cell.value is not None:
                    cell.number_format = "0.00"
        else:
            for cell in row[1:7]:
                if cell.value is not None:
                    cell.number_format = "#,##0.00" if row[0].value == "平均房价（元）" else "#,##0"
        if row[0].value == "预算达成率":
            row[6].number_format = "0.0%"
    style(ws4, [18, 13, 13, 13, 12, 14, 12, 44])

    ws5 = wb.create_sheet("客评与品质")
    ws5.append(["问题类别", "差评条数", "占差评比", "客人原话摘录", "关联督办项"])
    bad_total = sum(c[1] for c in REVIEW)
    for name, count, quote, link in REVIEW:
        ws5.append([name, count, round(count / bad_total, 4), quote, link])
    ws5.append(["合计", bad_total, 1.0, "全月差评 9 条，综合评分 4.7 分", "对应督办整改清单"])
    for row in ws5.iter_rows(min_row=2, max_row=ws5.max_row):
        row[2].number_format = "0%"
    for cell in ws5[ws5.max_row]:
        cell.font = Font(bold=True)
    style(ws5, [22, 11, 10, 30, 44])

    out = Path(__file__).resolve().parent.parent / "素材" / "10月经营数据底表.xlsx"
    wb.save(out)

    print(f"文件 → {out}")
    print(f"可售房晚 {t['sellable']}｜已售房晚 {t['sold']}｜入住率 {t['occ']:.4f}")
    print(f"客房收入 {t['revenue']:,}｜ADR {t['adr']:.2f}｜RevPAR {t['revpar']:.2f}")
    print(f"总营收 {t['total_revenue']:,}｜成本合计 {total_cost:,}｜GOP {profit:,}｜GOP率 {gop_rate:.4f}")
    print(f"上门散客 ADR {walk_adr}｜渠道佣金合计 {sum(r[6] for r in channels):,}")
    for name, basis, amount, base, unit, note in costs:
        print(f"  {name}: {amount:,}（{basis}）")


if __name__ == "__main__":
    main()
