---
name: 中文文档质检规格（Word / docx 交付验收）
description: 需要对一份已交付的 docx 文档做质检、复核、验收、判合格不合格时调用。内置 15 条可运行断言脚本，只当裁判不当作者，结论只有「通过」或「打回」两种。
source_kind: system_builtin
tags: 文档质检,docx,Word质检,中文文档质检规格,word文档
---

# 中文文档质检规格

## 何时调用

派工单让你对**一份已经存在的 .docx 文件**下判定：合格还是不合格。
你是裁判，不是作者。这一单的目标不是"把稿子改好"，是"给出可复核的裁决"。

## 一、裁判纪律（这几条比结论本身重要）

1. **不许碰被检文件**：不修改、不补行、不重命名、不删除，连格式都不许顺手修。发现问题只写进报告。
2. **结论只有两种**：`通过` 或 `打回`。没有"基本合格""整体不错""建议微调"。
3. **任何一条不合格就是打回**。15 条里挂 1 条也写打回，不许按"严重程度"自行放行——那是作者的权限，不是裁判的。
4. **打回必须能定位**：每条不合格都写清「标准名 / 实测值 / 落在哪一段或哪一列」，让人拿着这句话就能改。
   写不出位置就别写这条，别用"排版欠佳"这类没法执行的话凑数。
5. **裁决必须来自脚本输出**，不许用肉眼判断代替。你"看着觉得乱"不算证据，脚本说 8 条越界才算。
6. **报告必须留可复现的痕迹**：实际跑过的命令原文、脚本完整输出、文件绝对路径、字节数、SHA-256。
   别人拿着这份报告能重跑出一模一样的结论，才算合格裁判。

## 二、检查脚本（整段落盘为 check_docx.py，不要逐条重写）

下面这段是**已经在合格稿与不合格稿上双向跑通**的完整脚本：合格稿输出「结论：通过」退出码 0，
不合格稿输出「结论：打回（…）」退出码 1。把它原样写进项目目录再运行，
自己另写一份等于重新引入一遍 bug。

```python
#!/usr/bin/env python3
# 用法：python3 check_docx.py 某份.docx
# 退出码：0 = 通过，1 = 打回。任何一条 FAIL 都必须打回，不许"整体不错"放行。
import hashlib
import re
import sys

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Emu

CJK = re.compile(r"[一-鿿]")
LATIN = re.compile(r"[A-Za-z]{2,}")
BADWORDS = re.compile(r"lorem|ipsum|TODO|TBD|占位|待补充|XXX", re.I)
MANUAL_BULLET = re.compile(r"^\s*[•·・*\-—]\s*")
PAGE_FIELD = re.compile(r"\bPAGE\b")

path = sys.argv[1]
doc = Document(path)
paras = list(doc.paragraphs)


def style_key(p):
    st = p.style
    return "%s|%s" % (getattr(st, "style_id", "") or "", getattr(st, "name", "") or "")


def is_heading(p):
    k = style_key(p).lower()
    if "heading" in k or "标题" in k:
        return True
    pr = p._p.find(qn("w:pPr"))
    return pr is not None and pr.find(qn("w:outlineLvl")) is not None


def heading_level(p):
    pr = p._p.find(qn("w:pPr"))
    if pr is not None:
        lv = pr.find(qn("w:outlineLvl"))
        if lv is not None:
            try:
                return int(lv.get(qn("w:val"))) + 1
            except (TypeError, ValueError):
                pass
    k = style_key(p)
    m = re.search(r"(\d)", k)
    return int(m.group(1)) if m else 1


def runs_of(p):
    return p.runs


def cjk_len(text):
    return len(CJK.findall(text))


def has_ea(p):
    for r in runs_of(p):
        rPr = r._r.find(qn("w:rPr"))
        if rPr is None:
            continue
        rfonts = rPr.find(qn("w:rFonts"))
        if rfonts is not None and (rfonts.get(qn("w:eastAsia"))
                                   or rfonts.get(qn("w:ascii"))):
            return True
    return False


def run_pt(p):
    pts = [r.font.size.pt for r in runs_of(p) if r.font.size]
    return max(pts) if pts else None


body = [p for p in paras if p.text.strip() and not is_heading(p)]
heads = [(heading_level(p), p.text.strip()) for p in paras if p.text.strip() and is_heading(p)]
h1 = [t for lv, t in heads if lv == 1]
h2plus = [t for lv, t in heads if lv >= 2]

body_text = "\n".join(p.text for p in body)
n_cjk = cjk_len(body_text)
n_latin = len(LATIN.findall(body_text))
cjk_ratio = n_cjk / float(n_cjk + n_latin * 2) if (n_cjk + n_latin) else 0.0

para_lens = [cjk_len(p.text) or len(p.text.split()) for p in body]
long_ones = [x for x in para_lens if x > 200]
short_ones = [x for x in para_lens if 0 < x < 15]

blank_run = worst_blank = 0
for p in paras:
    blank_run = blank_run + 1 if not p.text.strip() else 0
    worst_blank = max(worst_blank, blank_run)

numbered = sum(1 for p in body if p._p.find(qn("w:pPr")) is not None
               and p._p.find(qn("w:pPr")).find(qn("w:numPr")) is not None)
manual = sum(1 for p in body if MANUAL_BULLET.match(p.text.strip()))

ea_ok = sum(1 for p in body if has_ea(p))
# 正文常常不给每个 run 单独设字号，靠 Normal 样式兜着；两级都要看，否则真稿一律误判。
sizes = [s for s in (run_pt(p) for p in body) if s]
normal = doc.styles["Normal"].font.size
fallback = normal.pt if normal else None
size_min = min(sizes) if sizes else fallback

footer_text, footer_field = [], False
for sec in doc.sections:
    for p in sec.footer.paragraphs:
        if p.text.strip():
            footer_text.append(p.text.strip())
    footer_field = footer_field or bool(
        PAGE_FIELD.search(sec.footer._element.xml))

sect = doc.sections[0]
page_w_mm = Emu(int(sect.page_width)).mm if sect.page_width else 0
page_h_mm = Emu(int(sect.page_height)).mm if sect.page_height else 0

tables = doc.tables
bad_found = BADWORDS.findall(body_text + "\n".join(t for _, t in heads))
levels = [lv for lv, _ in heads]
jumps = [i for i in range(1, len(levels)) if levels[i] - levels[i - 1] > 1]

fails = []


def check(name, ok, detail):
    print("[%s] %s | %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        fails.append(name)


check("一级标题唯一", len(h1) == 1, "H1 %d 个：%s" % (len(h1), h1[:3]))
check("主标题 ≤20 字", bool(h1) and cjk_len(h1[0]) <= 20,
      "%d 字" % (cjk_len(h1[0]) if h1 else 0))
check("小标题 ≥2 个", len(h2plus) >= 2, "%d 个" % len(h2plus))
check("标题不跳级", not jumps, "跳级位置 %s" % (jumps or "无"))
check("正文中文字数 ≥300", n_cjk >= 300, "%d 字" % n_cjk)
check("中文占比 ≥60%", cjk_ratio >= 0.6, "%.0f%%（中文 %d / 英文词 %d）"
      % (cjk_ratio * 100, n_cjk, n_latin))
check("每段 15~200 字", bool(para_lens) and not long_ones and not short_ones,
      "共 %d 段，超长 %d 段，过短 %d 段" % (len(para_lens), len(long_ones), len(short_ones)))
check("连续空段 ≤2", worst_blank <= 2, "最多连续 %d 个空段" % worst_blank)
check("用真编号列表而非手打圆点", manual == 0 and numbered >= 1,
      "真列表段落 %d，手打圆点 %d" % (numbered, manual))
check("中文设了东亚字体", bool(body) and ea_ok >= max(1, len(body) // 2),
      "%d/%d 段设了 eastAsia" % (ea_ok, len(body)))
check("正文字号 ≥10.5pt", size_min is not None and size_min >= 10.5,
      "最小 %.1fpt（%s）" % (size_min, "run 显式字号" if sizes else "Normal 样式兜底")
      if size_min is not None else "未取到任何字号")
check("页脚有署名", any("知微" in t for t in footer_text),
      "页脚文本 %s" % (footer_text[:2] or "空"))
check("页脚有页码域", footer_field, "PAGE 域 %s" % ("有" if footer_field else "无"))
check("无占位词残留", not bad_found, sorted(set(x.lower() for x in bad_found)) or "无")
if tables:
    tb = tables[0]
    hdr = [c.text.strip() for c in tb.rows[0].cells]
    ok_hdr = all(hdr) and len(set(hdr)) == len(hdr)
    check("表格表头非空且不重名", ok_hdr, "表头 %s" % hdr[:6])
else:
    check("表格表头非空且不重名", True, "本次交付无表格，不适用")

raw = open(path, "rb").read()
print("---")
print("文件：%s" % path)
print("字节：%d" % len(raw))
print("SHA-256：%s" % hashlib.sha256(raw).hexdigest())
print("纸张：%.0fx%.0f mm" % (page_w_mm, page_h_mm))
print("结论：%s" % ("通过" if not fails else "打回（%d 条不合格：%s）" % (len(fails), "、".join(fails))))
sys.exit(0 if not fails else 1)
```

它量的 15 条，对应交付规格：一级标题唯一 / 主标题 ≤20 字 / 小标题 ≥2 个 /
标题不跳级 / 正文中文字数 ≥300 / 中文占比 ≥60% / 每段 15~200 字 / 连续空段 ≤2 /
真编号列表（不是手打「•」）/ 中文设了东亚字体 / 正文字号 ≥10.5pt /
页脚署名 / 页脚页码域 / 无占位词 / 表格表头非空且不重名。

**位置写法**：Word 用「第 N 段」或「<小标题名> 一节」，别写页码——页码是渲染出来的，
不同机器分页不一样，写了也对不上。

## 三、怎么跑

```bash
python3 check_docx.py "<被检文件绝对路径>"
echo "退出码=$?"
```

`python-docx` 装不上时（ModuleNotFoundError）：

```bash
pip3 install python-docx --target ./_libs
PYTHONPATH=./_libs python3 check_docx.py "<被检文件绝对路径>"
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
check_docx.py（本单新写）；本次不产出交付物文件。

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
