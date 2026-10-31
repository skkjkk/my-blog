---
title: MCP 协议的架构包含哪些核心组件？Server 和 Client 分别负责什么？
published: 2026-10-23
description: MCP 采用 Host–Client–Server 三层架构，规范建立在 JSON-RPC 2.0 之上
tags: [面试]
category: Agent与LLM应用
section: note
draft: false
---
MCP 采用 **Host–Client–Server** 三层架构，规范建立在 **JSON-RPC 2.0** 之上。

## Host（宿主）

—— 用户实际交互的应用，比如 Claude Desktop、Cursor、IDE 插件、企业内部 Agent 平台。它是整个体系的"用户界面 + 编排者"，负责承载对话、管理多个 Client、决定何时使用哪个 Server 的能力、并在最终输出时做安全过滤。Host 内部通常为每个 Server 创建一个独立的 Client 实例。

## Client（客户端）

—— 运行在 Host 内部、与某一个 Server 一对一通信的组件。它负责**协议层面的全部工作**：建立会话、初始化时进行**能力协商**、发起 `tools/call`、`resources/read` 等调用、处理服务端发来的**反向请求**（如 Sampling、Roots），并把结果转交 Host。Client **不包含业务逻辑**，只做协议适配。

## Server（服务器）

—— 暴露具体能力的独立进程或服务。它负责**把真实系统包装成 MCP 能力**：把外部 API、数据库、文件系统、内部服务封装成 Tools / Resources / Prompts，处理实际的业务逻辑、鉴权与错误，并把外部世界的原始数据**清洗、裁剪成适合模型消费的形式**。Server 是"脏活"的主要承担者。

## 两类 Server

。**本地 Server** 通过 stdio 与 Client 通信，随宿主启动，适合本地文件、代码分析类工具；**远程 Server** 通过 SSE 或 Streamable HTTP 提供服务，可被多个 Host 共享，适合团队级与生产级服务。

## 核心原语（Server 暴露的三类能力）

。**Tools** 是可执行动作，模型可主动调用；**Resources** 是可读取的上下文数据，通过 URI 标识；**Prompts** 是可复用的提示模板，通常由用户显式触发。

## 两种反向通道

。**Sampling** 允许 Server 请求 Client 代为调用 LLM，使 Server 无需自带模型即可实现"智能"能力；**Roots** 允许 Server 请求 Client 暴露文件系统等上下文根目录。**这两者体现了 MCP 的双向性**，也是它比单纯的"工具协议"更完整的原因。

## 能力协商机制

。Client 连接时声明自己支持的协议版本与特性，Server 返回自己支持的能力集，后续所有可用方法都由这份能力集决定。这让**协议可以向前兼容地演进**，而不破坏老客户端。

## 一次调用的完整链路

：Host 决定使用某 Server → Client 初始化会话并协商能力 → Client 请求 `tools/list` 拿到工具目录 → 交给 Host 放入上下文交给模型 → 模型返回 tool_call → Client 经 JSON-RPC 发给 Server → Server 真正执行并返回结果 → Client 回传 Host 追加到消息列表 → 模型继续推理。

## 架构上的关键设计取舍

。**每个 Server 独立成进程、独立会话**，使得权限边界清晰（一个 Server 被攻破不等于全家失守）、故障隔离好、且易于按需启停；代价是**跨 Server 的能力组合与统一鉴权需要 Host 层额外设计**。
