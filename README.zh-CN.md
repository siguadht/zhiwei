<div align="center">
  <img src="./public/brand/app-icon.png" alt="知微" width="120" />
</div>

# 知微 Zhiwei — 用群聊的方式，指挥你的 Agent 团队

[简体中文](README.zh-CN.md) | [English](README.md)

知微用你最熟悉的聊天软件界面，把 Agent 变成一支团队。你可以给每个项目建立自己的专属群聊、定制专属 Agent 团队。

---

## 组建你的 Agent 团队

把不同的 Agent 拉进同一个群聊，共同为一个项目服务。团队按项目组织，每个项目都有自己的专属群。

<p align="center">
  <video src="https://github.com/user-attachments/assets/4c223c55-42f4-4c47-9c36-c14676afff50" width="80%" controls autoplay loop muted playsinline></video>
</p>

## 定制你的团队成员

每个 Agent 都是独立的实例——身份与记忆独立，可根据需求自由选配大模型服务。给不同的成员换上不同的「大脑」，让擅长的事交给擅长的成员。

<p align="center">
  <video src="https://github.com/user-attachments/assets/994cc11b-793e-4ae8-ae65-4850bf257143" width="80%" controls autoplay loop muted playsinline></video>
</p>

## 一句话派活，团队自动干活

你不需要学习怎么写提示词、怎么拆任务。项目经理（Coordinator）会自动把任务拆成小任务，分派给合适的员工（Worker）执行，并把结果汇总给你。需要你决定的事，会弹卡问你，你点一下就行。

<p align="center">
  <video src="https://github.com/user-attachments/assets/e73a3a42-1089-47bc-a584-92939b9b1dee" width="80%" controls autoplay loop muted playsinline></video>
</p>

## 还有这些

- **记忆与知识库**：友好的聊天记录、收藏、知识库功能，可跨群聊转发消息、项目内经验共享。
- **安全边界**：Agent 们只能在各自所属的项目目录内活动，碰不到你电脑上其他任何文件。

---

## 关于本分支

**知微是开源骨架 [Knowe](https://github.com/HirezmingD/Knowe-agent-groupchat)（MIT）的一条分支。**
上游已经把难的部分解决了，那些代码留着、著作权也归上游：Agent 循环、项目群聊、项目经理拆单、
权限与审批闸门、记忆、上下文压缩、技能加载、MCP 挂载。

这条分支加的是让它从"聊天 Agent"变成"办公 Agent"的那部分：

1. **它交回来的是一个真文件。** 丢材料 + 说一句话 → 拿到能在 Office 里选中改字的
   `.pptx` / `.docx` / `.xlsx`，全中文，不是糊一张图。成员在沙箱里自装生成库，
   产出一个交付物不依赖任何外部 Office 二进制。
2. **一套写死的"什么算合格"。** 7 份内置 SKILL.md：3 份写作规格（各文件类型的结构与排版硬指标）、
   3 份质检规格（**每份内置 15 条可运行断言**）、1 份项目经理必须走的验收纪律。
3. **一个真会打回的质检环节。** 骨架把"交付审阅"这一环整个删过——界面上的"接受 / 拒绝"背后没有实现。
   这条分支把它补回来：交付 → 派质检单给测试岗 → 沙箱里跑 15 条断言 → 不合格就下发返工单。
   全程没改状态机。
4. **审批卡不再背刺。** 原来 5 分钟静默过期，现在会等你。
5. **本地账户与密钥收口。** 真登录页（PBKDF2，只存哈希），并堵掉一处 `GET /settings` 把 API Key
   明文吐给渲染进程的泄露。
6. **台账 / 版本 / 看板，数字全是真的。** 也明确没有：不接支付、不做服务端账号、不造字段
   （台账里没有"客户签收"这一列，因为那条路径没有实现）。
7. **整套前端重做**：白 + 黑、零渐变零阴影、一屏一处强调、尺寸按真实产品量；外加成员自主命名的三档规则。

完整改动清单：[CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md) · [CHANGELOG.md](./CHANGELOG.md)

---

## 快速上手

1. 本地构建安装包（`npm run dist:win` / `npm run dist:mac`）
2. 安装并打开知微，配置你的模型服务（API Key）
3. 创建项目群聊，开始组建你的 Agent 团队

## 了解更多

- 📄 快速技术文档 [TECH.md](./TECH.md) · [简体中文版](./TECH.zh-CN.md)
- 📚 完整用户手册 [Docs 简体中文](./docs/CN/00-概述.md) · [Docs English](./docs/EN/00-Overview.md)

## License

本项目采用 [MIT](./LICENSE) 协议。

本项目基于上游 Knowe 骨架（同为 MIT 协议）二次开发，上游作者保留其原始代码的著作权。

---

*知微是 AI 辅助工具，使用过程中产生的数据与结果由使用者自行负责。*
