---
title: Java 并发库中提供了哪些线程池实现？它们有什么区别？
published: 2026-10-23
description: 并发库中的实现分两类：核心类 ThreadPoolExecutor（通用底座，参数全暴露）、ScheduledThreadPoolExecutor（继承前…
tags: [并发编程, 面试]
category: Java
draft: false
---
并发库中的实现分两类：核心类 `ThreadPoolExecutor`（通用底座，参数全暴露）、`ScheduledThreadPoolExecutor`（继承前者，额外支持延迟与周期执行）、`ForkJoinPool`（工作窃取，不实现 `ExecutorService`）；以及 `Executors` 提供的 5 种开箱即用配置，本质上都是前两者的不同参数组合。

1) **FixedThreadPool**，核心线程数和最大线程数相等，队列用无界 `LinkedBlockingQueue`。线程数固定，多余任务在队列里排队。适合负载稳定、任务量可预估的场景，比如后台批量数据处理。

2) **CachedThreadPool**，核心线程数 0，最大线程数 `Integer.MAX_VALUE`，队列用 `SynchronousQueue`。来一个任务就创建一个线程，空闲 60 秒后回收。适合突发性短任务，比如 HTTP 异步回调处理。

3) **SingleThreadExecutor**，只有 1 个线程，队列无界 `LinkedBlockingQueue`。任务严格按提交顺序执行。适合需要保证顺序性的场景，比如日志写入、消息顺序消费。

4) **ScheduledThreadPool**，核心线程数由参数指定，最大线程数 `Integer.MAX_VALUE`，队列用 `DelayedWorkQueue`。支持延迟执行和周期执行。适合定时任务场景，比如心跳检测、定时报表生成。

5) **WorkStealingPool**，底层是 `ForkJoinPool`，默认线程数等于 CPU 核心数。每个线程有自己的任务队列，空闲时去其他线程的队列里偷任务。适合大量可拆分的小任务，比如递归计算、并行流处理。

**生产上不要直接用 `Executors`**：FixedThreadPool 与 SingleThreadExecutor 的无界队列会在任务积压时撑爆内存，CachedThreadPool 的无限扩容会创建海量线程。应自己 `new ThreadPoolExecutor`，队列设为有界、配置明确的拒绝策略、使用带可读线程名的自定义线程工厂。
