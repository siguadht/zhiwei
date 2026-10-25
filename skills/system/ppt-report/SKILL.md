---
name: 中文演示文稿交付规格（PPT / pptx）
description: 用户要 PPT、幻灯片、演示稿、汇报材料、deck、pptx 文件时调用。规定 8 页结构、中文排版硬指标、python-pptx 生成约束，以及交付前必须跑通并附在报告里的自检清单。
source_kind: system_builtin
tags: ppt,pptx,幻灯片,演示,汇报,deck
---

# 中文演示文稿交付规格

## 何时调用

用户要的是**一份能直接拿去讲的 .pptx 文件**，不是 PPT 的文字大纲、不是图片、不是 markdown 草稿。
出现以下任一说法即适用：PPT、幻灯片、演示稿、汇报材料、路演、deck、产品介绍页、周报/月会 PPT。

## 一、什么算合格（硬指标，一条不过就不许交付）

### 结构

1. 页数 6–10 页；第 1 页是封面（主标题 + 一句话副标题），最后 1 页是收尾页（结论 + 下一步）。
2. 每页 **1 个标题 + 3–5 条要点**。超过 5 条必须拆页，不许缩小字号硬塞。
3. 每条要点是一个**完整句子或短语，8–28 个汉字**，讲一件独立的事。不许出现 "……"、"等等"、"略" 这类省略式收尾。
4. 页序必须构成论证：是什么 → 为什么 → 怎么做 → 值多少 → 下一步。不许章节乱序。
5. 每页页脚放「产品/项目名 —— 一句话定位」和「NN / 总页数」页码。

### 内容

6. **正文简体中文**。`README`、`API`、`Agent` 这类专名可以留英文，但每页英文词不超过 2 个。
7. 不许出现占位符残留：`lorem`、`ipsum`、`TODO`、`TBD`、`占位`、`XXX`、`待补充`、模板自带的 "Click to add text"。
8. 不许把同一句话在标题和要点里重复一遍。
9. 数字、名称、日期必须来自用户给的材料；材料里没有的就不写，**不许编**。

### 文件本身

10. 真 OOXML `.pptx`，能在 PowerPoint / Keynote / WPS 里打开并**逐个文本框选中改字**。
11. **禁止**把整页渲染成图片贴进去（那是"看起来像 PPT 的图"，不是 PPT）。
12. 16:9（宽 12191695 EMU × 高 6858000 EMU）。
13. 文件留在项目目录里，不许生成后又删掉；同时保留生成脚本，让用户能重跑复现。

## 二、生成约束（python-pptx）

- 库没装就 `pip3 install python-pptx`，装完 `import pptx` 确认版本再用。
- **中文字体必须同时设 `latin` 和 `ea` 两个 typeface**，否则中文会回退成难看的默认字体：

  ```python
  from pptx.oxml.ns import qn
  def set_cn(run, name="思源黑体 CN", size=18, bold=False, color=None):
      run.font.size = Pt(size); run.font.bold = bold
      run.font.name = name                      # 只管 latin，中文不吃这条
      rPr = run._r.get_or_add_rPr()
      ea = rPr.find(qn("a:ea"))
      if ea is None:
          ea = rPr.makeelement(qn("a:ea"), {}); rPr.append(ea)
      ea.set("typeface", name)                  # 中文真正生效的是这条
  ```

- 标题 ≥ 28pt，正文 ≥ 16pt，页脚 ≥ 10pt。同一份稿子里字号只用这几档。
- 项目符号用**真 bullet**（`a:buChar`），不要手打 "• " 前缀——手打的在改字时会变成文本的一部分。
- 版式一律 `add_textbox` 自己排版，**不要留 PowerPoint 的空占位符**（`is_placeholder` 必须为 0），否则打开时满屏"单击此处添加文本"。
- 配色：一个主色 + 一个深色 + 灰阶，最多三个。不许渐变、不许阴影、不许花哨背景。
- 文本框宽度按 16:9 页面留左右各 ≥ 1.2 英寸边距；正文末行估算位置不得超过页脚线。

## 三、交付前必须自检（跑完，把结果贴进报告）

写一个 `verify_ppt.py` 放在项目目录里，逐条断言并打印：

```
页数在 6–10                        assert 6 <= len(prs.slides) <= 10
每页标题非空                        逐页打印标题文本
每页要点 3–5 条                     逐页计数
无占位符残留                        正则扫 lorem|ipsum|TODO|TBD|占位|待补充|XXX
无空占位形状                        sum(sh.is_placeholder for sh in slide.shapes) == 0
16:9 尺寸                           prs.slide_width / slide_height 等于 12196800/6858000 量级
zip 完整                            unzip -t 无错
文件大小 > 15KB                     太小通常意味着没有真内容
```

再加一条肉眼验证：`qlmanage -t -s 1600 -o /tmp 文件.pptx` 出封面图，确认版式不是空白页、文字没压到页脚。

**报告里必须写清**：实际执行的命令、每条断言的结果、文件绝对路径、字节数、SHA-256。做不到的一律如实写"没做/没验"，不许含糊带过。

## 四、多轮改稿

用户说"第 3 页改成……"时：改生成脚本重跑，**不要**手工去动已有的 .pptx（会把版式改坏且无法复现）。
交付时说明这次相对上一版改了什么，其余页保持不动。
