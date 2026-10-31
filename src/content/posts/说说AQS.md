---
title: 说说 AQS 吧？
published: 2026-10-23
description: AQS（AbstractQueuedSynchronizer）是 java.util.concurrent.locks 下的同步器框架，JUC 中几乎所有…
tags: [并发编程, 面试]
category: Java
draft: false
---
AQS（AbstractQueuedSynchronizer）是 `java.util.concurrent.locks` 下的**同步器框架**，JUC 中几乎所有锁和同步器（`ReentrantLock`、`ReentrantReadWriteLock`、`Semaphore`、`CountDownLatch`）都基于它实现。它的核心是"**把同步状态的管理与线程的排队阻塞分离**"：子类只管定义"什么时候可以获取/释放"，排队、阻塞、唤醒由框架统一完成。

1) **核心是一个 volatile int state**，表示同步状态。`ReentrantLock` 用它表示**重入次数**（0 表示未加锁），`Semaphore` 用它表示**剩余许可数**，`CountDownLatch` 用它表示**剩余计数**。状态的修改都通过 CAS 完成。

2) **独占模式与共享模式**。独占模式同一时刻只允许一个线程获取，适合 `ReentrantLock`；共享模式允许多个线程同时获取，适合 `Semaphore`、`CountDownLatch`（多个线程可以同时 `await` 到期）。

3) **独占获取的流程是三步**：第一步 `tryAcquire` 尝试直接获取状态，成功则返回；第二步失败则 `addWaiters` 把当前线程包装成 Node 加入**CLH 变体的双向等待队列**；第三步调用 `acquireQueued` 反复自旋尝试获取，失败则 `park` 阻塞自己。释放时调用 `release` 改状态并 `unpark` 后继节点。

4) **等待队列是 CLH 变体的双向链表**。每个 Node 持有自己的前驱和后继引用，`prev` 指针用于判断自己是队首节点。**入队后线程立即被挂起，不会空转**（JDK 6 后去掉了无条件自旋），避免了无效的 CPU 消耗。

5) **Condition 支持**。每个 `Condition` 对应一个**独立的条件队列**，线程通过 `await()` 进入该队列并释放锁，被 `signal()` 时重新回到同步队列竞争锁。相比 `synchronized` 只能有一个等待集，`ReentrantLock` 可以精确唤醒满足特定条件的线程。

6) **共享模式的传播机制**。当一个线程释放共享资源时，如果状态变成 0，会**依次唤醒后继节点**，后继再判断自己能否继续获取——这正是 `CountDownLatch` 计数归零后能一次性唤醒所有等待者的原理。

7) **可重入的实现靠状态值**。`tryAcquire` 中判断 `state > 0 && owner == currentThread` 则把状态加一，`release` 时减一，降到 0 才真正释放锁并唤醒后继。

8) **AQS 本身是抽象框架而非具体锁**。要使用它，需要继承并实现 `tryAcquire`、`tryRelease`、`tryAcquireShared`、`tryReleaseShared` 这几个方法，具体的获取释放逻辑交给子类，排队与阻塞由 AQS 保证。

9) **公平与非公平由子类决定**。`ReentrantLock` 的非公平模式在 `tryAcquire` 里直接抢锁成功即返回；公平模式则会先检查队列中是否有更早的等待者，有则排队，保证按 FIFO 获取。

10) **实践意义**。理解 AQS 是理解整个 JUC 的钥匙 —— 线程池的工作线程复用、锁的公平性、Condition 的精准唤醒、读写锁的共享获取，追到底层都是同一套状态机加等待队列的机制在支撑。
