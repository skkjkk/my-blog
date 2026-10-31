---
title: MCP 的工作流程是什么？
published: 2026-10-24
description: "MCP 的工作流程可以按\"一次工具调用\"和\"一次完整会话\"两个尺度来看。 1) 连接与初始化阶段"
tags: [面试]
category: Agent与LLM应用
draft: false
---
MCP 的工作流程可以按"**一次工具调用**"和"**一次完整会话**"两个尺度来看。

1) **连接与初始化阶段**。Client 启动后与 Server 建立传输通道（本地用 **stdio**，远程用 **SSE / Streamable HTTP**），然后发起 `initialize` 请求，双方交换**协议版本**与**能力声明**（Client 声明自己支持哪些特性，Server 返回自己支持哪些），完成**能力协商**。协商结果决定了后续哪些方法可用 —— 这是协议能向前兼容演进的关键。

2) **能力发现阶段**。Client 调用 `tools/list` 拿到工具目录（含名称、描述、参数 JSON Schema）、`resources/list` 拿到可读资源、`prompts/list` 拿到提示模板。**工具是动态发现的** —— Server 侧新增工具，客户端无需改代码。

3) **宿主与模型交互**。Host（用户实际交互的应用）把工具目录整理成模型能理解的格式，随请求一起发给模型。**这一步是 MCP 与 Function Calling 的结合点** —— MCP 提供工具定义，模型接口负责结构化表达调用意图。

4) **模型决策**。模型判断需要调用工具，返回**结构化的 tool_call**（工具名 + JSON 参数）。**模型不执行任何动作**。

5) **调用执行阶段**。Client 收到 tool_call 后，**先做本地校验**（参数是否符合 schema），再通过 JSON-RPC 向 Server 发送 `tools/call` 请求。Server **真正执行**这个动作 —— 访问数据库、调外部 API、读写文件。

6) **结果返回阶段**。Server 返回执行结果（成功数据或错误信息），Client 把它按 `tool_call_id` 组织成 tool 消息，追加进消息列表，回传给 Host。**关键做法：失败也要把可诊断的错误回传**，让模型能自我纠正。

7) **继续迭代**。模型基于结果继续推理，可能再调工具（多轮），也可能给出最终答案。**当模型不再返回 tool_call 时，一轮工具调用结束。**

8) **反向通道（可选但重要）**。**Sampling** —— Server 反过来请求 Client 代为调用 LLM（Server 无需自带模型即可获得智能能力）；**Roots** —— Server 请求 Client 暴露文件系统等上下文根目录。**这两者体现了 MCP 的双向性。**

9) **会话与资源释放**。会话结束要显式关闭；Server 侧的临时状态（订阅、缓存）随之清理。

10) **一个完整的时序总结**：

```
Host 决定使用某 Server
  → Client 建立连接 + initialize（能力协商）
  → Client tools/list（动态发现）
  → Host 组装提示（工具目录 + 用户输入）→ 模型
  → 模型返回 tool_call
  → Client 校验参数 → JSON-RPC tools/call → Server
  → Server 真正执行 → 返回结果
  → Client 回填 tool 消息 → 模型
  → 模型给出最终答案（循环结束）
```

11) **工程上要注意的三点**。**① Server 侧要做数据清洗** —— 把原始数据裁剪成适合模型消费的形式，这是 MCP Server 的核心价值之一。**② 认证只在远程部署时需要**（本地 stdio 靠进程边界隔离）。**③ 错误语义要标准化** —— 不同 Server 的错误表达方式不同，Client 侧要有归一化层，否则模型无法从错误中学习。
