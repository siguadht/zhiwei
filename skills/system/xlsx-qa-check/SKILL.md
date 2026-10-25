---
name: 电子表格质检规格（Excel / xlsx 交付验收）
description: 需要对一份已交付的 xlsx 表格做质检、复核、验收、判合格不合格时调用。内置 15 条可运行断言脚本，只当裁判不当作者，结论只有「通过」或「打回」两种。
source_kind: system_builtin
tags: 表格质检,xlsx,Excel质检,电子表格质检规格,工作簿质检
---

# 电子表格质检规格

## 何时调用

派工单让你对**一份已经存在的 .xlsx 文件**下判定：合格还是不合格。
你是裁判，不是作者。你的活是裁，不是写。

## 一、裁判纪律（这几条比结论本身重要）

1. **不许碰被检文件**：不修改、不补行、不重命名、不删除，连格式都不许顺手修。发现问题只写进报告。
2. **结论只有两种**：`通过` 或 `打回`。没有"基本合格""整体不错""建议微调"。
3. **任何一条不合格就是打回**。15 条里挂 1 条也写打回，不许按"严重程度"自行放行——那是作者的权限，不是裁判的。
4. **打回必须能定位**：每条不合格都写清「标准名 / 实测值 / 落在哪一段或哪一列」，让人拿着这句话就能改。
   写不出位置就别写这条，别用"排版欠佳"这类没法执行的话凑数。
5. **裁决必须来自脚本输出**，不许用肉眼判断代替。你"看着觉得乱"不算证据，脚本说 8 条越界才算。
6. **报告必须留可复现的痕迹**：实际跑过的命令原文、脚本完整输出、文件绝对路径、字节数、SHA-256。
   别人拿着这份报告能重跑出一模一样的结论，才算合格裁判。

## 二、检查脚本（整段落盘为 check_xlsx.py，不要逐条重写）

下面这段是**已经在合格稿与不合格稿上双向跑通**的完整脚本：合格稿输出「结论：通过」退出码 0，
不合格稿输出「结论：打回（…）」退出码 1。把它原样写进项目目录再运行，
自己另写一份等于重新引入一遍 bug。

```python
#!/usr/bin/env python3
# 用法：python3 check_xlsx.py 某份.xlsx
# 退出码：0 = 通过，1 = 打回。任何一条 FAIL 都必须打回，不许"整体不错"放行。
import hashlib
import re
import sys

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

CJK = re.compile(r"[一-鿿]")
LATIN = re.compile(r"[A-Za-z]{2,}")
NUMISH = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$|^-?\d+(\.\d+)?%$")
BADWORDS = re.compile(r"lorem|ipsum|TODO|TBD|占位|待补充|XXX|#N/A|nan|None", re.I)
DEFAULT_SHEET = re.compile(r"^(sheet\d+|工作表\d*)$", re.I)

path = sys.argv[1]
wb = load_workbook(path)
ws = wb.active
rows = list(ws.iter_rows())
n_rows = ws.max_row or 0
n_cols = ws.max_column or 0

header = [c.value for c in rows[0]] if rows else []
header_txt = [("" if v is None else str(v)).strip() for v in header]
data = rows[1:] if len(rows) > 1 else []

col_has_value = []
for j in range(n_cols):
    vals = [r[j].value for r in data if j < len(r)]
    col_has_value.append(any(v not in (None, "") for v in vals))

empty_rows = [i + 2 for i, r in enumerate(data)
              if all(c.value in (None, "") for c in r)]
overflow = []
for row in data:
    for i in range(len(header_txt), len(row)):
        if row[i].value not in (None, ""):
            overflow.append(row[i].row)

text_cells, latin_words, cjk_chars = 0, 0, 0
string_numbers = []
percent_strings = []
bad_found = []
for row in rows:
    for c in row:
        v = c.value
        if v is None:
            continue
        s = str(v).strip()
        if not s:
            continue
        if isinstance(v, str):
            if NUMISH.match(s):
                (percent_strings if s.endswith("%") else string_numbers).append(s)
            if BADWORDS.search(s):
                bad_found += BADWORDS.findall(s)
            if CJK.search(s) or LATIN.search(s):
                text_cells += 1
                cjk_chars += len(CJK.findall(s))
                latin_words += len(LATIN.findall(s))

header_bold = [bool(c.font.bold) for c in rows[0]] if rows else []
merged_first = [str(rng) for rng in ws.merged_cells.ranges
                if rng.min_row == 1]
widths = [ws.column_dimensions[get_column_letter(j)].width
          for j in range(1, n_cols + 1)]
width_set = sum(1 for w in widths if w)

fails = []


def check(name, ok, detail):
    print("[%s] %s | %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        fails.append(name)


check("表名有意义", not DEFAULT_SHEET.match(ws.title or ""), "工作表名「%s」" % ws.title)
check("数据行 ≥5", len(data) >= 5, "%d 行数据" % len(data))
check("表头全非空", bool(header_txt) and all(header_txt),
      "表头 %s" % (header_txt or "空"))
check("表头不重名", len(header_txt) == len(set(header_txt)),
      "重复项 %s" % (sorted({h for h in header_txt if header_txt.count(h) > 1}) or "无"))
check("表头加粗", bool(header_bold) and all(header_bold),
      "%d/%d 个表头单元格加粗" % (sum(1 for b in header_bold if b), len(header_bold)))
check("表头行不许合并单元格", not merged_first, "合并区 %s" % (merged_first[:3] or "无"))
check("冻结首行", (ws.freeze_panes or "") == "A2",
      "freeze_panes=%s" % (ws.freeze_panes or "未设"))
check("没有整列空的表头", all(col_has_value[:len(header_txt)]),
      "空列 %s" % ([header_txt[j] for j, ok in enumerate(col_has_value) if not ok] or "无"))
check("数字存成数字而非文本", not string_numbers,
      "文本型数字 %s" % (string_numbers[:3] or "无"))
check("百分比存成数字带格式", not percent_strings,
      "文本型百分比 %s" % (percent_strings[:3] or "无"))
check("列宽已设置", width_set >= max(1, len(header_txt) - 1),
      "%d/%d 列设了宽度" % (width_set, len(header_txt)))
check("中文占比 ≥60%", text_cells == 0 or cjk_chars / float(cjk_chars + latin_words * 2) >= 0.6,
      "中文 %d 字 / 英文 %d 词" % (cjk_chars, latin_words))
check("无占位词与错误值", not bad_found, sorted(set(bad_found))[:5] or "无")
check("数据不越界（值不许落在表头列之外）", not overflow,
      "越界行 %s" % (sorted(set(overflow))[:3] or "无"))
check("数据区无整行空", not empty_rows, "整行空 %s" % (empty_rows[:3] or "无"))

raw = open(path, "rb").read()
print("---")
print("文件：%s" % path)
print("工作表：%s（共 %d 张：%s）" % (ws.title, len(wb.sheetnames), "、".join(wb.sheetnames)))
print("规模：%d 行 x %d 列" % (n_rows, n_cols))
print("字节：%d" % len(raw))
print("SHA-256：%s" % hashlib.sha256(raw).hexdigest())
print("结论：%s" % ("通过" if not fails else "打回（%d 条不合格：%s）" % (len(fails), "、".join(fails))))
sys.exit(0 if not fails else 1)
```

它量的 15 条，对应交付规格：表名有意义（不是 Sheet1）/ 数据行 ≥5 /
表头全非空 / 表头不重名 / 表头加粗 / 表头行不许合并 / 冻结首行 /
没有整列空的表头 / 数字存成数字而非文本 / 百分比存成数字带格式 /
列宽已设置 / 中文占比 ≥60% / 无占位词与错误值 / 数据不越界 / 数据区无整行空。

**位置写法**：用「<列名> 列 / 第 N 行」，例如「付费占比 列 | 实测 42% 是文本 | 第 3 行」。

## 三、怎么跑

```bash
python3 check_xlsx.py "<被检文件绝对路径>"
echo "退出码=$?"
```

`openpyxl` 装不上时（ModuleNotFoundError）：

```bash
pip3 install openpyxl --target ./_libs
PYTHONPATH=./_libs python3 check_xlsx.py "<被检文件绝对路径>"
```

⚠️ 装依赖**一律装进项目目录**（`--target ./_libs`），别装 `/tmp`：macOS 会清 `/tmp`，
上一单还能跑、这一单就 ImportError 了，那种失败看起来像你的错。

## 四、报告怎么写（六节，顺序不要改）

```
## 完成了什么
跑了一次机器质检，被检文件 <绝对路径>，SHA-256 <值>。

## 是否符合指令
不符合 / 符合 —— 一句话，紧跟结论行。

## 产出清单
check_xlsx.py（本单新写）；本次不产出交付物文件。

## 发现的问题
逐条列不合格项，格式：`<标准名> | 实测 <值> | <位置>`。全过就写"无"。

## 自检
原样贴出 15 行 [PASS]/[FAIL] 输出 + 退出码 + 实际执行命令。

## 结论
**结论：通过** 或 **结论：打回（<k> 条不合格：<标准名>、<标准名>）**
```

最后一行必须原样出现「结论：通过」或「结论：打回（）」开头，
项目经理靠这句话决定签收还是返工，写成别的样子它接不上。

## 五、返工复测

返工件重新跑一遍脚本，**不许沿用上一次结果**。
比对两次 SHA-256：一样说明根本没改，直接打回并在报告里写"文件未变动"。

## 六、边界

- 脚本没覆盖的问题（内容空洞、逻辑不通、数据没根据）你照样可以写在"发现的问题"里，
  但**不能据此判打回**——只有 15 条断言能。主观意见标"（不计入裁决）"。
- 拿不到文件、跑不动脚本、依赖装不上：**如实报告失败**，绝不许凭想象给结论。
  裁判缺席时比赛不算赢，也不算输，就是没打。
