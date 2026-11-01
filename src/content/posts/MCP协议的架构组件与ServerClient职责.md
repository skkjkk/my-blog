---
title: MCP 协议的架构包含哪些核心组件？Server 和 Client 分别负责什么？
published: 2026-10-23
description: "MCP 用 Host、Client、Server 三层分工：Client 只做协议适配，Server 把真实系统包装成 Tools、Resources、Prompts 对外暴露。"
tags: [面试]
category: Agent与LLM应用
section: note
draft: false
---
MCP 采用 **Host–Client–Server** 三层架构，规范建立在 **JSON-RPC 2.0** 之上。Host 是用户交互的应用，负责承载对话与编排；Client 运行在 Host 内部，与某一个 Server 一对一通信，只做协议适配；Server 把真实系统包装成 **Tools、Resources、Prompts** 三类原语并承担业务、鉴权与错误处理。三者再靠能力协商与反向通道（Sampling、Roots）补上双向性。

## 三层分工一览

一句话分工：**Host 决定用什么，Client 负责怎么连，Server 负责真正干活。**

| 层 | 是什么 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| Host | 用户实际交互的应用 | 承载对话、管理多个 Client、决定何时用哪个 Server 的能力、输出前做安全过滤 | 不直接处理协议细节，交给 Client |
| Client | Host 内部与某一个 Server 一对一通信的组件 | 建立会话、能力协商、发起 `tools/call` 与 `resources/read`、处理服务端反向请求 | 不包含业务逻辑 |
| Server | 暴露具体能力的独立进程或服务 | 把真实系统封装成三类原语，做业务逻辑、鉴权与错误处理，清洗裁剪数据 | 不管界面，也不管模型 |

## Host：用户的界面，也是编排者

Host 是用户实际交互的应用，比如 Claude Desktop、Cursor、IDE 插件、企业内部 Agent 平台。它是整个体系的"用户界面 + 编排者"：承载对话、管理多个 Client、决定何时使用哪个 Server 的能力，并在最终输出时做安全过滤。

一个容易漏掉的实现细节是：**Host 内部通常为每个 Server 创建一个独立的 Client 实例**。所以"一个 Host 接了多个 Server"，落地形态其实是"N 个 Client 各连一个 Server"，Host 只是它们的统一入口与调度者。

## Client：一对一通信，只做协议适配

Client 运行在 Host 内部，与某一个 Server 一对一通信，它负责**协议层面的全部工作**：

- 建立会话，初始化时完成**能力协商**；
- 发起 `tools/call`、`resources/read` 等调用；
- 处理服务端发来的**反向请求**（如 Sampling、Roots）；
- 把结果转交 Host。

关键约束是：**Client 不包含业务逻辑，只做协议适配**。业务判断留在两端——要不要调、调到什么程度由 Host 与模型决定，调下去之后怎么执行由 Server 决定，Client 只保证消息按 JSON-RPC 格式正确收发。

## Server：把真实系统包装成能力

Server 是暴露具体能力的独立进程或服务。它负责**把真实系统包装成 MCP 能力**：把外部 API、数据库、文件系统、内部服务封装成 Tools / Resources / Prompts，处理实际的业务逻辑、鉴权与错误，并把外部世界的原始数据**清洗、裁剪成适合模型消费的形式**。Server 是"脏活"的主要承担者。

三类核心原语的分工：

| 原语 | 含义 | 谁触发 |
| --- | --- | --- |
| Tools | 可执行动作 | 模型可主动调用 |
| Resources | 可读取的上下文数据，通过 URI 标识 | 按 URI 定位读取 |
| Prompts | 可复用的提示模板 | 通常由用户显式触发 |

Server 有两种部署形态：

- **本地 Server**：通过 stdio 与 Client 通信，随宿主启动，适合本地文件、代码分析类工具。
- **远程 Server**：通过 SSE 或 Streamable HTTP 提供服务，可被多个 Host 共享，适合团队级与生产级服务。

## 反向通道与能力协商

协议里有两条**反向通道**，方向都是 Server 发给 Client 的请求：

- **Sampling**：允许 Server 请求 Client 代为调用 LLM，使 Server 无需自带模型即可实现"智能"能力。
- **Roots**：允许 Server 请求 Client 暴露文件系统等上下文根目录。

**这两者体现了 MCP 的双向性**，也是它比单纯的"工具协议"更完整的原因——如果只有 Tools / Resources / Prompts，Server 就永远是被动被调用的一方。

另一块前提机制是**能力协商**：Client 连接时声明自己支持的协议版本与特性，Server 返回自己支持的能力集，后续所有可用方法都由这份能力集决定。这让**协议可以向前兼容地演进**，而不破坏老客户端。

## 一次调用的完整链路

把各组件串起来，一次典型调用是这样走的：

1. Host 决定使用某个 Server。
2. Client 初始化会话并协商能力。
3. Client 请求 `tools/list` 拿到工具目录。
4. 工具目录回传 Host，由 Host 放进上下文交给模型。
5. 模型返回 `tool_call`。
6. Client 经 JSON-RPC 把请求发给 Server。
7. Server 真正执行并返回结果。
8. Client 回传 Host 追加到消息列表，模型继续推理。

```
Host    → Client   : 选定 Server，发起连接
Client  → Server   : initialize（声明协议版本与特性）
Server  → Client   : 返回支持的能力集
Client  → Server   : tools/list
Server  → Client   : 工具目录 → Host → 模型上下文
模型    → Host     : tool_call → Client
Client  → Server   : tools/call（JSON-RPC）
Server  → Client   : 执行结果 → Host → 消息列表 → 模型继续推理
Client ⇄ Server   : 反向请求 sampling / roots（由 Client 侧处理）
```

## 架构取舍：一个 Server 一个进程

**每个 Server 独立成进程、独立会话**，这是架构上最关键的一处取舍。好处有三条：权限边界清晰（一个 Server 被攻破不等于全家失守）、故障隔离好（单个 Server 崩了不带走整个会话）、易于按需启停。

代价是**跨 Server 的能力组合与统一鉴权需要 Host 层额外设计**：协议本身不负责把多个 Server 的工具拼成一条流水线，也不提供跨 Server 的统一身份，这些都得由 Host 来编排。

## 常见追问

Q：Client 和 Server 是不是就是普通 RPC 的客户端和服务端？
A：是 JSON-RPC 意义上的两个对端，但不是"用户到服务"的边界。Client 嵌在 Host 里做协议适配，它背后真正的使用方是 Host；Server 背后才是真实系统。

Q：能力协商为什么不能省？
A：后续可用方法由双方声明的能力集决定。省掉协商就只能假设两端版本一致，任一端升级后互相发对方不认识的方法，会话立刻失效。

Q：Sampling 到底解决什么问题？
A：让 Server 不必自带模型。需要模型能力时它反向请求 Client，由 Client 侧代为调用 LLM，模型选择与密钥都留在 Host 那一侧。

Q：多个 Server 的能力怎么组合？
A：协议层不提供跨 Server 组合，只有 Host 能做编排：汇总各自的工具目录、处理命名冲突，并统一鉴权。

## 易错点

- 把 Client 当成"用户的客户端"：它只是 Host 内部与某一个 Server 一对一的协议适配层，本身不含业务逻辑。
- 以为 Server 把原始数据直接丢给模型：清洗与裁剪是 Server 的职责，噪声必须挡在模型之外。
- 只记三类原语、漏掉反向通道：那样 MCP 就被说成了纯工具协议，Sampling 与 Roots 才是双向性的证据。
- 以为能力协商只是换个版本号：它直接决定后续有哪些方法可用，是向前兼容的前提。

## 一句话记住

:::tip
Host 编排、Client 中转协议、Server 干活，三层靠 JSON-RPC 2.0 双向通话。
:::
