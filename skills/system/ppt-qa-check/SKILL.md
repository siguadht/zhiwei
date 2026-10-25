---
name: 中文演示文稿质检规格（PPT / pptx 交付验收）
description: 需要对一份已交付的 pptx 做质检、复核、验收、检查合格不合格时调用。内置 15 条可运行断言脚本，只当裁判不当作者，结论只有「通过」或「打回」两种。
source_kind: system_builtin
tags: 演示文稿质检,pptx,幻灯片质检,PPT质检,中文演示文稿质检规格
---

# 中文演示文稿质检规格

## 何时调用

派工单让你对**一份已经存在的 .pptx 文件**下判定：合格还是不合格。
你是裁判，不是作者。这一单的目标不是"把稿子改好"，是"给出可复核的裁决"。

## 一、裁判纪律（这几条比结论本身重要）

1. **不许碰被检文件**：不修改、不补页、不重命名、不删除，连格式都不许顺手修。发现问题只写进报告。
2. **结论只有两种**：`通过` 或 `打回`。没有"基本合格""整体不错""建议微调"。
3. **任何一条不合格就是打回**。15 条里挂 1 条也写打回，不许按"严重程度"自行放行——那是作者的权限，不是裁判的。
4. **打回必须能定位**：每条不合格都写清「标准名 / 实测值 / 落在第几页」，让人拿着这句话就能改。
   写不出页码就别写这条，别用"排版欠佳"这类没法执行的话凑数。
5. **裁决必须来自脚本输出**，不许用肉眼判断代替。你"看着觉得字太多"不算证据，脚本说 28 条里越界 9 条才算。
6. **报告必须留可复现的痕迹**：实际跑过的命令原文、脚本完整输出、文件绝对路径、字节数、SHA-256。
   别人拿着这份报告能重跑出一模一样的结论，才算合格裁判。

## 二、检查脚本（整段落盘为 check_ppt.py，不要逐条重写）

下面这段是**已经在这两份真稿上跑通**的完整脚本：合格稿输出「结论：通过」退出码 0，
不合格稿输出「结论：打回（…）」退出码 1。把它原样写进项目目录再运行，
自己另写一份等于重新引入一遍 bug。

```python
#!/usr/bin/env python3
# 用法：python3 check_ppt.py 某份.pptx
# 退出码：0 = 通过，1 = 打回。任何一条 FAIL 都必须打回，不许"整体不错"放行。
import hashlib
import re
import sys

from pptx import Presentation
from pptx.oxml.ns import qn
from pptx.util import Emu

CJK = re.compile(r"[一-鿿]")
LATIN = re.compile(r"[A-Za-z]{2,}")
BADWORDS = re.compile(r"lorem|ipsum|TODO|TBD|占位|待补充|XXX", re.I)
PAGENUM = re.compile(r"\d+\s*/\s*\d+")

path = sys.argv[1]
prs = Presentation(path)
slides = list(prs.slides)
slide_h = Emu(int(prs.slide_height)).inches


def max_pt(shape):
    sizes = [r.font.size.pt for p in shape.text_frame.paragraphs
             for r in p.runs if r.font.size]
    return max(sizes) if sizes else 0.0


def top_in(shape):
    return Emu(int(shape.top or 0)).inches


def has_bullet(shape):
    for p in shape.text_frame.paragraphs:
        pPr = p._p.find(qn("a:pPr"))
        if pPr is not None and (pPr.find(qn("a:buChar")) is not None
                                or pPr.find(qn("a:buAutoNum")) is not None):
            return True
    return False


def has_ea_font(shape):
    for p in shape.text_frame.paragraphs:
        for r in p.runs:
            rPr = r._r.find(qn("a:rPr"))
            if rPr is not None:
                ea = rPr.find(qn("a:ea"))
                if ea is not None and ea.get("typeface"):
                    return True
    return False


counts, title_pts, titles, mid_lens = [], [], [], []
bullet_pages = ea_pages = pagenum_pages = footer_pages = ph_shapes = pic_shapes = 0
latin_max = 0
bad_found = []

for idx, sl in enumerate(slides, 1):
    boxes = []
    for sh in sl.shapes:
        if sh.has_text_frame:
            ps = [t.strip() for t in
                  (p.text for p in sh.text_frame.paragraphs) if t]
            if ps:
                boxes.append((sh, ps))
    ph_shapes += sum(1 for sh in sl.shapes if sh.is_placeholder)
    pic_shapes += len(sl._element.findall(".//" + qn("p:pic")))

    if not boxes:
        titles.append("")
        title_pts.append(0.0)
        counts.append((idx, 0))
        continue

    title_shape = max(boxes, key=lambda b: (max_pt(b[0]), -top_in(b[0])))[0]
    body = []
    page_pagenum = page_footer = False
    for sh, ps in boxes:
        all_text = " ".join(ps)
        if 0 < max_pt(sh) <= 12 or top_in(sh) >= slide_h * 0.85:
            page_footer = True
            if PAGENUM.search(all_text):
                page_pagenum = True
            continue
        rest = ps[1:] if sh is title_shape else ps
        body += [t for t in rest if not PAGENUM.fullmatch(t)]
    every = " ".join(t for _, ps in boxes for t in ps)
    bad_found += BADWORDS.findall(every)
    latin_max = max(latin_max, len(LATIN.findall(every)))

    title_txt = ""
    for sh, ps in boxes:
        if sh is title_shape:
            title_txt = ps[0]
            break
    titles.append(title_txt)
    title_pts.append(max_pt(title_shape))
    counts.append((idx, len(body)))
    if any(has_bullet(sh) for sh, _ in boxes):
        bullet_pages += 1
    if any(has_ea_font(sh) for sh, _ in boxes):
        ea_pages += 1
    if page_pagenum:
        pagenum_pages += 1
    if page_footer:
        footer_pages += 1
    if 1 < idx < len(slides):
        mid_lens += [len(CJK.findall(t)) or len(t.split()) for t in body]

n = len(slides)
mid_counts = [c for i, c in counts if 1 < i < n]
fails = []


def check(name, ok, detail):
    print("[%s] %s | %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        fails.append(name)


check("页数 6~10", 6 <= n <= 10, "%d 页" % n)
check("每页都有标题", all(titles), "缺标题页 %s" % ([i for i, t in enumerate(titles, 1) if not t] or "无"))
check("中间页正文 3~5 条", bool(mid_counts) and all(3 <= c <= 5 for c in mid_counts), str(mid_counts))
check("中间页每条 8~28 字", bool(mid_lens) and all(8 <= L <= 28 for L in mid_lens),
      "共 %d 条，越界 %d 条" % (len(mid_lens), sum(1 for L in mid_lens if not 8 <= L <= 28)))
check("封面页大标题 ≥40pt 且压过其它页",
      bool(title_pts) and title_pts[0] >= 40 and title_pts[0] > max(title_pts[1:] or [0]),
      "首页 %.1fpt / 其它页最高 %.1fpt" % (title_pts[0] if title_pts else 0,
                                        max(title_pts[1:] or [0])))
check("收尾页正文 ≤5 段", bool(counts) and counts[-1][1] <= 5, "末页 %d 段" % (counts[-1][1] if counts else 0))
check("每页有页码 NN/总", pagenum_pages >= n - 1, "%d/%d 页" % (pagenum_pages, n))
check("每页有页脚", footer_pages >= n - 1, "%d/%d 页" % (footer_pages, n))
check("用真项目符号而非手打圆点", bullet_pages >= max(1, n - 2), "%d/%d 中间页" % (bullet_pages, max(1, n - 2)))
check("中文设了东亚字体 a:ea", ea_pages >= n - 1, "%d/%d 页" % (ea_pages, n))
check("无占位词残留", not bad_found, sorted(set(x.lower() for x in bad_found)) or "无")
check("每页英文 ≤2 词", latin_max <= 2, "最多 %d 词" % latin_max)
w, h = int(prs.slide_width), int(prs.slide_height)
check("16:9 画布", abs(w / h - 16 / 9) < 0.01, "%dx%d EMU" % (w, h))
check("正文不放在占位框里", ph_shapes == 0, "%d 个 placeholder 形状" % ph_shapes)
check("没有用图片贴字", pic_shapes == 0, "%d 个图片形状" % pic_shapes)

raw = open(path, "rb").read()
print("---")
print("文件：%s" % path)
print("字节：%d" % len(raw))
print("SHA-256：%s" % hashlib.sha256(raw).hexdigest())
print("结论：%s" % ("通过" if not fails else "打回（%d 条不合格：%s）" % (len(fails), "、".join(fails))))
sys.exit(0 if not fails else 1)

```

它量的 15 条，对应交付规格：页数 6~10 / 每页都有标题 / 中间页正文 3~5 条 /
每条 8~28 字 / 封面页大标题压场 / 收尾页短正文 / 页码 / 页脚 /
真项目符号（不是手打「• 」）/ 中文东亚字体 a:ea / 无占位词 / 每页英文 ≤2 词 /
16:9 画布 / 正文不放占位框 / 没用图片贴字。

## 三、怎么跑

```bash
python3 check_ppt.py "<被检文件绝对路径>"
echo "退出码=$?"
```

`python-pptx` 装不上时（ModuleNotFoundError）：

```bash
pip3 install python-pptx --target ./_libs
PYTHONPATH=./_libs python3 check_ppt.py "<被检文件绝对路径>"
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
check_ppt.py（本单新写）；本次不产出交付物文件。

## 发现的问题
逐条列不合格项，格式：`<标准名> | 实测 <值> | 第 N 页`。全过就写"无"。

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
