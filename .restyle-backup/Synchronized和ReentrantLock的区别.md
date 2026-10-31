---
title: Synchronized 和 ReentrantLock 有什么区别？
published: 2026-10-23
description: 两者都是 Java 的互斥锁，都保证同一时刻只有一个线程能进入临界区，区别主要在实现机制、灵活性与能力边界上
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
两者都是 Java 的互斥锁，都保证同一时刻只有一个线程能进入临界区，区别主要在实现机制、灵活性与能力边界上。

1) **实现机制不同**。`synchronized` 是 JVM 层面的关键字，锁的获取与释放由字节码指令控制，线程退出同步块时自动释放；`ReentrantLock` 是 `java.util.concurrent.locks` 下的类，依赖 AQS 实现，需要显式调用 `lock()` 和 `unlock()`，通常要放在 `finally` 块中。

2) **是否可中断不同**。`synchronized` 的线程在等待锁时无法被中断，也不支持超时获取锁；`ReentrantLock` 提供 `lockInterruptibly()` 和 `tryLock(timeout)`，可以响应中断并支持限时等待，避免线程无限期挂起。

3) **是否公平不同**。`synchronized` 是非公平的，线程竞争时顺序不确定；`ReentrantLock` 构造时可指定公平策略，公平锁按等待队列的先后顺序获取，牺牲吞吐量换取更可预期的行为。默认仍是非公平，因为非公平锁的实际吞吐通常更高。

4) **能否多条件等待不同**。`synchronized` 配合 `wait`/`notify` 只能操作一个等待集，多个条件要靠额外判断区分，容易出错；`ReentrantLock` 通过 `newCondition()` 创建多个 `Condition`，每个条件有独立的等待队列，能精确唤醒满足特定条件的线程。

5) **是否可中断响应等待不同**。在 `synchronized` 中调用 `wait()` 期间线程无法被中断；`ReentrantLock` 的 `Condition.await()` 可响应中断。

6) **锁的类型不同**。`synchronized` 只有独占锁这一种；`ReentrantLock` 还提供读锁和写锁（`ReentrantReadWriteLock`），读读并发、读写互斥，适合读多写少的场景。

7) **性能差异有条件**。低竞争下两者接近；高竞争时 `synchronized` 曾有较大开销，但 JDK 6 引入偏向锁、后续又用自适应自旋和锁消除优化，两者差距已大幅缩小。`ReentrantLock` 的优势更多来自它提供的**额外能力**而非单纯的性能。

8) **使用约束**。`synchronized` 天然不会忘记释放；`ReentrantLock` 手写 `unlock()` 时若漏写或异常路径未覆盖，会造成死锁，这是它的主要风险点。

**实践建议**：能用 `synchronized` 就用 `synchronized`，代码更简洁且不易出错；只有在需要超时获取、可中断、公平性、多条件队列或读写锁这些能力时，才引入 `ReentrantLock`。
