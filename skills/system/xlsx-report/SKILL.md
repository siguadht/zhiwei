---
name: 电子表格交付规格（xlsx）
description: 用户要 Excel、表格、台账、对比表、数据清单、xlsx 文件时调用。规定表头/数据区/列宽/冻结行硬指标、openpyxl 的中文与数字存储约束（数字存成数字、百分比带格式、真加粗表头），以及交付前必须跑通 check_xlsx.py 的自检要求。
source_kind: system_builtin
tags: 做表格,写表格,表格制作,Excel表格,excel表格,数据表,台账,对比表,表格交付
---

# 电子表格交付规格

## 何时调用

用户要的是**一份能直接算公式、排序、筛选的真 .xlsx 文件**，不是 markdown 表格、不是截图、不是 csv 冒充。
出现以下任一说法即适用：Excel、表格、清单、台账、对比表、赛道对比、排期表、预算表、数据表。

## 一、什么算合格（硬指标，一条不过就不许交付）

### 工作表与表头

1. **工作表名要有意义**：写「办公 Agent 赛道对比」这类，**不许留 `Sheet1` / `工作表1`**。
2. 第 1 行是表头，**每一格都有名字，不许空**；**两列不许同名**（"备注"出现两次就是不合格）。
3. 表头**全部加粗**，并水平居中。
4. **表头行不许合并单元格**。合并了就没法筛选排序，等于没表头。
5. 表头列数要和实际数据对齐：**不许有表头却没数据**（整列空），也不许数据写到表头列之外（越界）。

### 数据区

6. **数据行 ≥5 行**（不含表头）。三行就叫"示例"，不叫交付。
7. **数据区不许有整行全空**的行。
8. 数字必须存成**数字**（`int`/`float`），**不许存 `"1,234"`、`"12%"` 这种文本**。文本数字不能求和、不能排序，是表格最常见的一次性事故。
9. 百分比存**小数**（`0.42`）并设 `number_format = "0%"`，**不许写字符串 `"42%"`**。
10. 金额/数量如果需要单位，单位写进**表头**（"月费（元）"），不要塞进每个单元格里。
11. 单元格不许留 `TODO`、`占位`、`待补充`、`#N/A`、`nan`、`None` 这类残留。真的没有数据，就在表头层面删掉那一列，或者写"未披露"。

### 观感与内容

12. **逐列设置列宽**（`column_dimensions[...].width`），按内容长短给，不许全部默认宽把中文挤成竖排。
13. **冻结首行**：`freeze_panes = "A2"`，往下翻时表头一直看得见。
14. **中文占比 ≥60%**，专名可以留英文，但整表不能是英文表。
15. 每一行的"备注/说明"列必须是**一句完整的判断**（"绑定组织通讯录，个人用不起来"），不许空着或只写"-"。
16. 数字、名称、日期一律来自用户给的材料；材料里没有的就不写，**不许编**。

### 文件本身

17. 真 OOXML `.xlsx`，能在 Excel / WPS / Numbers 里打开并**逐个单元格改**。
18. 首行表头 + 数据从第 2 行开始，中间不加小标题行、不加空行分段。多张表就开多个工作表。
19. 文件留在项目目录里，不许生成后删掉；同时保留生成脚本，让用户能重跑复现。

## 二、生成约束（openpyxl）

- 库没装先 `pip3 install openpyxl`，装完 `import openpyxl` 确认版本再用。
- 骨架一次到位：

  ```python
  from openpyxl import Workbook
  from openpyxl.styles import Alignment, Font
  from openpyxl.utils import get_column_letter

  wb = Workbook()
  ws = wb.active
  ws.title = "办公 Agent 赛道对比"          # 一定改名，别留 Sheet1
  HEADER = ["产品", "形态", "主要交付物", "月费（元）", "付费占比", "备注"]
  WIDTHS = [16, 14, 24, 12, 12, 34]        # 与表头等长

  for j, name in enumerate(HEADER, 1):
      c = ws.cell(row=1, column=j, value=name)
      c.font = Font(bold=True)
      c.alignment = Alignment(horizontal="center")
      ws.column_dimensions[c.column_letter].width = WIDTHS[j - 1]

  for i, row in enumerate(ROWS, 2):        # 数据从第 2 行起
      for j, val in enumerate(row, 1):
          cell = ws.cell(row=i, column=j, value=val)   # val 直接给数字，别 str()
          if j == 5 and isinstance(val, float):
              cell.number_format = "0%"                 # 百分比：小数 + 格式

  ws.freeze_panes = "A2"
  wb.properties.creator = "知微"            # 不设就是 "openpyxl"，会被看文件属性的人看到
  wb.properties.title = "10 月经营分析"
  wb.save(path)
  ```

- **列宽那行必须用 `c.column_letter` 或 `get_column_letter(j)`**。合并过单元格之后再取 `.column_letter` 会 `AttributeError`（尺子就是这么被一份坏文件打崩的），别在表头行用 `merge_cells`。
- 数字写 `0`，不要写 `"0"` 或 `"—"`；空的可选数据写 `None`（留空），但**整列不许全空**。
- 别用 `merge_cells` 做"大标题"，那是把表头毁掉的最快方式。
- 多工作表时每个都要有意义名字，第一张放主表。

## 三、交付前必须自检（跑完，把结果贴进报告）

质检岗用的尺子叫 `check_xlsx.py`，全文在「电子表格质检规格」这本菜谱里，**原样取出来跑，不要另写一套近似口径**。

```
python3 check_xlsx.py <绝对路径.xlsx>
```

要看到 15 行 `[PASS]`、最后一行 `结论：通过`、退出码 0。任何一条 `[FAIL]` 都先自己改脚本重跑，不许带着 FAIL 交出去。

**报告里必须写清**：实际执行的命令、15 行输出原样、工作表名、行列规模、文件绝对路径、字节数、SHA-256。做不到的一律如实写"没做/没验"，不许含糊带过。

## 四、多轮改稿

用户说"加一列毛利"时：改生成脚本重跑，**不要**手改已有的 .xlsx。
新增列必须同时补表头、列宽和数据；只补表头不填数据会直接踩中"整列空"那条。
