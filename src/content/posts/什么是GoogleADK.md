---
title: 什么是 Google ADK？
published: 2026-10-24
description: Google ADK（Agent Development Kit）是 Google 推出的开源 Agent 开发框架，2025 年发布，是 Google …
tags: [面试]
category: Agent与LLM应用
section: note
draft: false
---
Google ADK（Agent Development Kit）是 Google 推出的**开源 Agent 开发框架**，2025 年发布，是 Google Cloud 与 Gemini 生态中的 Agent 体系核心组件，也是 **A2A 协议的原生实现方**。

## 它的定位是"企业级、多语言、协议化"

。ADK 支持 **Python、Java、Go、TypeScript** 多语言实现（这一点在主流框架里比较少见），并且**原生支持 A2A 协议** —— 可以让 ADK 构建的 Agent 暴露为 A2A Server，与其他厂商的 Agent 协作。**它同时是 MCP 的支持方**（可作为 MCP Client 使用工具与数据）。**这使它天然处在"多 Agent 互操作"的枢纽位置。**

## 核心抽象有四个

。**Agent（智能体）** —— 具备身份、指令、可用工具与模型配置；**Runner（运行器）** —— 驱动 Agent 执行会话的运行时，管理事件流、状态与插件；**Session（会话）** —— 承载对话历史与状态；**Tool（工具）** —— 函数工具、Agent 工具（把另一个 Agent 当工具调用）、MCP 工具、内置工具。

## 多 Agent 体系是它的重点

。支持 **Sequential（顺序）、Parallel（并行）、Loop（循环）** 等工作流型 Agent，以及 **LlmAgent（模型驱动）、AutoFlow 等**多种形态，并能通过**自定义 Agent** 自由扩展。**"把 Agent 当工具来用"这个设计很关键** —— 它让不同角色的组合非常自然。

## 事件流与会话是它的工程底座

。Runner 以**事件（Event）**为单位对外流式输出（模型文本、工具调用、工具结果、状态变更、错误），这让**流式 UI、SSE 接口、审计、追踪**都能基于同一套事件模型实现，**不必为不同场景各写一套**。

## 开发体验（Developer UI）

。提供**可视化调试与回放**（能看到每一步的模型调用、提示、工具调用与结果），这在生产调优 Agent 时价值极高 —— **能看清"它当时为什么这么做"，比什么提示词技巧都管用**。

## 与 Google 生态的深度绑定

。深度集成 **Gemini 模型**（也支持其他模型与 Vertex AI）、**ADK 与 A2A 的组合**、以及向 Google Cloud 的部署链路。**代价是对 Google 生态有偏好**，但它本身是开源的、可自行部署的。

## 多语言策略的取舍

。多语言降低了框架的"深度" —— 各语言实现的功能深度并不完全一致。**选择时要确认目标语言那套实现的完整度**（尤其是插件、评估与可观测部分），这是选型中最容易踩的坑。

## 与其他框架的对比定位

。**LangGraph** 强在**图式状态机与复杂编排**；**AutoGen / CrewAI** 强在**多角色对话与分工**；**ADK** 强在**多语言覆盖 + A2A/MCP 协议支持 + 与 Google Cloud 的集成**。**如果你的系统需要跨厂商 Agent 互操作，ADK 的 A2A 支持是它最独特的优势。**

## 企业级考量

。ADK 定位为**企业级 Agent 框架**，关注**可观测性、评估、安全与部署**（与 Google Cloud 的 Trace、评测服务、Agent Engine 打通）。**这也是它与"轻量个人项目型框架"最大的区别。**

## 面试怎么答

1. 定位（Google 官方、企业级、多语言、原生 A2A + MCP）
2. 核心抽象（Agent / Runner / Session / Tool，事件流驱动）
3. 多 Agent 编排（工作流型 + Agent-as-Tool）
4. 开发者 UI 与 Google Cloud 生态的评估/部署链路
