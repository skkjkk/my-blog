---
title: A2A 协议的工作流程是怎样的？
published: 2026-10-24
description: "A2A 的工作流程可以分成六个阶段，核心是\"发现 → 匹配 → 委托 → 跟进 → 交付\""
tags: [面试]
category: Agent与LLM应用
section: note
draft: false
---
A2A 的工作流程可以分成六个阶段，核心是"**发现 → 匹配 → 委托 → 跟进 → 交付**"。

## 阶段一：发现（Discovery）

。编排方拿到候选 Agent 列表后，**逐个拉取其 Agent Card**。Card 是一份机器可读的 JSON，包含名称、描述、技能列表、输入输出模式、交互模式支持情况、端点地址与认证方式。**这一阶段的目的就是把"谁有什么能力"变成结构化的、可供检索的数据。**

## 阶段二：匹配与选择（Selection）

。依据 Card 的**自然语言描述**与**结构化能力**筛选出最合适的执行方。匹配可以由**规则**（技能标签精确匹配）做，也可以由**模型**做（语义匹配 + 权衡成本、延迟、负载）。**这一阶段是 A2A 最有价值的部分** —— 协作方是运行时决定的。

## 阶段三：建立连接与委派（Delegation）

。Client 按 Card 声明的 schema 构造任务请求，**携带自己的身份凭证**（而非对方的），向 Server 端点发起调用。Server 创建 Task、分配 id、进入 `submitted`，随后转 `working`。**客户端可以立即拿到 task id 并异步跟进。**

## 阶段四：流式跟进（Streaming）

。通过 Server-Sent Events 或等价的流式通道，**持续接收状态更新与中间产物**。状态流转为 `submitted → working → (input-required) → completed / failed / canceled`。若进入 **`input-required`**，说明对方需要补充信息 —— 客户端应回复消息并继续。

## 阶段五：多轮消息（Multi-turn）

。双方通过 Message 交换结构化内容（文本、文件、数据部件），完成澄清、补充材料、协商调整。**这一步是 A2A 区别于"一次调用"的关键** —— 长程协作往往需要多轮。

## 阶段六：交付与收尾（Delivery）

。任务完成后，成果以 **Artifact** 形式交付。客户端获取 Artifact（可能是文件引用或结构化数据），**整合进自己的流程**。若状态为 `failed`，则获取失败原因并决定**重试、换执行方还是降级**；整个任务可被**取消**。

## 完整时序图

```
编排方  →  发现: GET /.well-known/agent-card.json
编排方  →  匹配: 依据 Card 选择执行方
编排方  →  委派: POST /tasks  (携带自身凭证, 符合 schema)
Server  →  返回: task id, status=submitted → working
Server  →  推送: 流式状态更新 + 中间产物 (SSE)
编排方  →  补充: 收到 input-required 时回复 Message
Server  →  推送: status=completed + Artifact
编排方  →  收尾: 取回 Artifact 并整合

```

## 工程要点

。**① 认证在发起时完成**，不是靠 Card 里的明文密钥（Card 只声明**认证方式**，不携带凭据）；**② 长任务必须异步化**，客户端要有断线重连与状态补查能力；**③ 产物要能外置引用**（大文件不直接塞进消息）；**④ 失败要可归因**（区分对方能力不足、参数错误、超时、鉴权失败）；**⑤ 全链路要有统一 trace id**，否则跨 Agent 排障极其困难。

## 与单 Agent 内部循环的差别

。单 Agent 内部循环是"**同一进程内的同步调用**"，A2A 是"**跨进程的异步委托**"—— 因此必须处理**超时、重试、幂等、对方不可用、对方拒绝**这些分布式问题。
