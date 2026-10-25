---
name: 中文 Word 文档交付规格（docx）
description: 用户要 Word 文档、产品说明、方案、说明书、长文正文、docx 文件时调用。规定标题层级与篇幅硬指标、python-docx 的三条中文机制（eastAsia 字体、真编号列表、页脚 PAGE 域），以及交付前必须跑通 check_docx.py 的自检要求。
source_kind: system_builtin
tags: 写文档,文档写作,Word文档,word文档,产品说明,说明书,说明文档,长文档,文档交付
---

# 中文 Word 文档交付规格

## 何时调用

用户要的是**一份能直接打开排版的真 .docx 文件**，不是 markdown 草稿、不是 PDF 截图、不是"文档大纲"。
出现以下任一说法即适用：Word、文档、产品说明、方案说明、说明书、白皮书、报告正文、周报月报文档。

## 一、什么算合格（硬指标，一条不过就不许交付）

### 标题与结构

1. **一级标题（Heading 1）有且只有一个**，就是文档主标题，不超过 20 个汉字。多个 H1 = 不合格。
2. 小标题（Heading 2 及以下）**至少 2 个**；只有一级标题、通篇平铺的散文不算交付物。
3. **标题不许跳级**：H1 之后直接出现 H3、或 H2 之后直接 H4，都不合格。缩进靠层级，不靠字号。
4. 章节顺序必须构成论证：是什么 → 为什么 → 怎么做 → 边界与代价。不许章节乱序。

### 篇幅与排版

5. 正文中文字数 **≥300 字**（不计标题）。达不到就是没写东西。
6. **中文占比 ≥60%**。`README`、`API`、`Agent` 这类专名可以留英文，但通篇英文单词不能压过中文。
7. 每段 **15~200 字**。超过 200 字必须拆段；不足 15 字的孤句必须并回上下文。
8. **连续空段 ≤2**。不许用空行凑版式，要留白就设段前段后间距。
9. 列表必须用**真编号列表**（段落带 `w:numPr`），**不许手打 `• `、`- ` 前缀**——手打的圆点是文本的一部分，用户改字时会跟着走。
10. 每个 run 必须设**东亚字体**（`w:rFonts` 的 `eastAsia`），否则中文回退成难看默认字体。
11. 正文字号 **≥10.5pt**（五号）。标题依次放大，字号档位一份稿子里不超过 4 档。

### 页脚与内容

12. 页脚两样都要：项目署名固定写 **「知微——各司其职的办公 Agent」**，外加**真 PAGE 页码域**（不是手打的"1"）。
13. 不许占位符残留：`lorem`、`ipsum`、`TODO`、`TBD`、`占位`、`待补充`、`XXX`。
14. 有表格时：表头那一行**每格非空、且不许两列同名**。表头不加"备注1/备注2"这种凑数名。
15. 数字、名称、日期一律来自用户给的材料；材料里没有的就不写，**不许编**。宁缺毋滥。

### 文件本身

16. 真 OOXML `.docx`，A4 纸，能在 Word / WPS / Pages 里打开并**逐段选中改字**。
17. **禁止**把页面渲染成图片贴进去冒充文档。
18. 文件留在项目目录里，不许生成后删掉；同时保留生成脚本，让用户能重跑复现。

## 二、生成约束（python-docx）

- 库没装先 `pip3 install python-docx`，装完 `import docx` 确认版本再用。
- 兜底字号先设上，否则正文继承模板的 11pt 但质检读不到显式字号：

  ```python
  doc.styles["Normal"].font.size = Pt(11)
  ```

- 标题一律 `doc.add_paragraph(text, style="Heading 1")` / `"Heading 2"`，**不要**用普通段落加大字号冒充标题。
- **中文东亚字体**（`run.font.name` 只管西文，中文靠 `eastAsia`）：

  ```python
  from docx.oxml import OxmlElement
  from docx.oxml.ns import qn
  def set_ea(run, ea="微软雅黑"):
      rPr = run._r.get_or_add_rPr()
      rfonts = rPr.find(qn("w:rFonts"))
      if rfonts is None:
          rfonts = OxmlElement("w:rFonts"); rPr.append(rfonts)
      rfonts.set(qn("w:eastAsia"), ea)     # 中文真正吃这条
      rfonts.set(qn("w:ascii"), "Arial")
  ```

- **真编号列表**：段落用 `List Number` 样式，再补 `w:numPr`，两者都要，只有样式不带 numPr 会被判成手打：

  ```python
  def add_numpr(par, num_id=1):
      pPr = par._p.get_or_add_pPr()
      numPr = OxmlElement("w:numPr")
      ilvl = OxmlElement("w:ilvl"); ilvl.set(qn("w:val"), "0")
      nid = OxmlElement("w:numId"); nid.set(qn("w:val"), str(num_id))
      numPr.append(ilvl); numPr.append(nid)
      pPr.append(numPr)
  ```

- **页码域**必须是域，不是文本；页脚必须断开与上一节的链接，否则是空的：

  ```python
  def add_page_field(par):
      fld = OxmlElement("w:fldSimple")
      fld.set(qn("w:instr"), " PAGE ")
      fld.append(OxmlElement("w:r"))
      par._p.append(fld)

  for sec in doc.sections:
      ft = sec.footer
      ft.is_linked_to_previous = False        # 少了这行，页脚全空
      p = ft.paragraphs[0]
      p.alignment = WD_ALIGN_PARAGRAPH.CENTER
      set_ea(p.add_run("知微——各司其职的办公 Agent　"))
      add_page_field(p)
  ```

- 表格：`table.style = "Table Grid"`，表头那一行每个 run `r.bold = True`；表头不许 `merge`。
- 别在开头 `doc.add_paragraph()` 凑空行；连续空段超过 2 条直接打回。

## 三、交付前必须自检（跑完，把结果贴进报告）

质检岗用的尺子就叫 `check_docx.py`，全文在「中文文档质检规格」这本菜谱里，**原样取出来跑，不要另写一套近似口径**。

```
python3 check_docx.py <绝对路径.docx>
```

要看到 15 行 `[PASS]`、最后一行 `结论：通过`、退出码 0。任何一条 `[FAIL]` 都先自己改脚本重跑，不许带着 FAIL 交出去。

**报告里必须写清**：实际执行的命令、15 行输出原样、文件绝对路径、字节数、SHA-256。做不到的一律如实写"没做/没验"，不许含糊带过。

## 四、多轮改稿

用户说"第 2 节改成……"时：改生成脚本重跑，**不要**手改已有的 .docx（样式会散架且无法复现）。
交付时说明这次相对上一版改了什么，其余章节保持不动。
