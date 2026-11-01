---
title: 说说 AQS 吧？
published: 2026-10-23
description: AQS 是 JUC 的同步器框架：一个 volatile int state 表示同步状态，一条 CLH 变体队列管理线程排队与阻塞。
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
AQS（`AbstractQueuedSynchronizer`）是 `java.util.concurrent.locks` 的**同步器框架**，`ReentrantLock`、`Semaphore`、`CountDownLatch` 等 JUC 同步器都基于它。核心是"**把状态管理与线程排队阻塞分离**"：一个 `volatile int state` 承载状态，一条 CLH 变体双向队列负责排队与唤醒，子类只定义"何时可获取/释放"，其余交给框架。

## 核心是一个 volatile int state

整个 AQS 的同步语义都压在一个字段上：`volatile int state`。对外只暴露三个方法——`getState()` 读、`setState()` 写、`compareAndSetState()` 用 CAS 原子改；状态的修改**必须走 CAS**（或者在这些方法之上封装），否则队列里的线程看不到正确的最新状态。同一个 `state` 在不同子类里含义完全不同，这正是 AQS 只当"状态容器"的原因：

| 实现类 | `state` 的含义 | 模式 |
| --- | --- | --- |
| `ReentrantLock` | 重入次数，0 表示未加锁 | 独占 |
| `Semaphore` | 剩余许可数 | 共享 |
| `CountDownLatch` | 剩余计数 | 共享 |
| `ReentrantReadWriteLock` | 高 16 位读锁计数，低 16 位写锁重入次数 | 独占 + 共享 |

## 独占模式与共享模式

获取资源只有两种模式。**独占模式**同一时刻只允许一个线程拿到资源，适合 `ReentrantLock` 这类互斥锁，队列节点用 `Node.EXCLUSIVE` 标记。**共享模式**允许多个线程同时获取，适合 `Semaphore`（多个线程各占一个许可）和 `CountDownLatch`（计数归零后所有 `await` 的线程同时被放行），节点用 `Node.SHARED` 标记。两种模式共用同一条队列，只是唤醒时"叫醒一个"还是"继续往后传播"的区别。

## 独占获取分三步

`acquire(1)` 的结构就一句 `if`，但拆开是三步：

```java
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                          // 第一步：子类先试着拿
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg)) // 第二步入队，第三步排队等
        selfInterrupt();
}
```

第一步 `tryAcquire` 由子类实现，尝试直接把 `state` 从 0 改成 1，成功就返回。第二步失败，`addWaiter(Node.EXCLUSIVE)` 把当前线程包装成 `Node` 挂到队列尾部。第三步 `acquireQueued` 里循环判断：**只有前驱是 `head` 时才有资格再试一次 `tryAcquire`**（此时没有别人和它竞争），还不行就 `park` 挂起自己。释放走 `release`：先 `tryRelease` 改状态，成功后 `unparkSuccessor` 唤醒后继节点。

## 等待队列是 CLH 变体的双向链表

队列里每个 `Node` 持有 `prev`、`next` 两个引用，以及一个 `waitStatus`（`SIGNAL`、`CANCELLED`、`CONDITION`、`PROPAGATE`）。`prev` 的作用不是"记录前驱"这么简单：节点靠 `prev == head` 判断自己是不是队首、有没有资格直接去抢锁，这也是 `next` 可能为 `null` 却依然能正确唤醒后继的原因（`unparkSuccessor` 会从队尾往前找）。**入队后线程不会一直空转**——JDK 6 之后取消了无条件自旋，改成"试一次 + 挂起"：`shouldParkAfterFailedAcquire` 检查前驱状态，必要时把前驱标成 `SIGNAL`，然后才 `LockSupport.park`，避免了无效的 CPU 消耗。

## 可重入与公平性都由子类决定

**可重入靠 `state` 计数**：`tryAcquire` 里判断 `state > 0` 且 `getExclusiveOwnerThread() == Thread.currentThread()` 就把状态加一，`release` 时减一，降到 0 才真正释放锁并唤醒后继；非重入实现则只做 `compareAndSetState(0, 1)`。**公平与非公平的差别也只在 `tryAcquire` 里**：非公平模式的 `tryAcquire` 直接抢锁，抢到就返回；公平模式会先调 `hasQueuedPredecessors()` 检查队列里有没有更早的等待者，有则老实排队，保证按 FIFO 获取。

```java
class Mutex extends AbstractQueuedSynchronizer {
    protected boolean tryAcquire(int arg) { return compareAndSetState(0, 1); } // 不重入版本
    protected boolean tryRelease(int arg) { setState(0); return true; }
    void lock() { acquire(1); }
    void unlock() { release(1); }
}
```

## Condition 支持

每个 `Condition` 对应一个**独立的条件队列**（单向链表，用 `nextWaiter` 串联）。线程调 `await()` 时先 `fullyRelease` 把锁完全释放，再把自己挂进条件队列并 `park`；别的线程 `signal()` 时，把条件队列里的节点 `transferForSignal` 搬回同步队列，让它重新去竞争锁。相比 `synchronized` 只能有一个等待集、`notify` 可能唤醒条件不符的线程，`ReentrantLock` 可以按条件精确唤醒，`BlockingQueue` 里就是用 `notFull` 和 `notEmpty` 两个 Condition 分工的。

## 共享模式的传播机制

共享模式下释放不是"叫醒一个"，而是**向后传播**：`releaseShared` 调 `doReleaseShared`，把 `head` 的 `waitStatus` 置为 `PROPAGATE` 并唤醒后继，后继醒来发现自己也能拿（`tryAcquireShared` 返回值 ≥ 0），就继续往后唤醒。`CountDownLatch` 的 `tryAcquireShared` 在 `state == 0` 时返回 1，否则返回 -1，所以计数归零那一刻，队首之后的等待者会被依次唤醒——这就是它能"一次性放行所有等待线程"的原理。

## 常见追问

**Q：AQS 为什么要把排队阻塞收进框架，而不是让子类自己实现？**
A：同步器真正难的从来不是"能不能拿"，而是入队、挂起、唤醒、取消、中断这一堆状态管理。把这部分统一掉，子类只需回答"什么时候可获取"这一个问题，既避免每个同步器都重写一遍队列，也保证了可见性和唤醒的正确性。

**Q：`state` 为什么用 `int` 而不是 `boolean`？**
A：因为需要承载计数语义——重入次数、剩余许可数、剩余计数都是数字。真要表达两种状态时，`int` 还能拆位复用，读写锁就是高 16 位放读锁计数、低 16 位放写锁重入次数。

**Q：公平锁为什么吞吐更低？**
A：每次获取都要先看 `hasQueuedPredecessors()`，并且严格 FIFO 意味着频繁的线程切换与唤醒；非公平锁允许刚释放锁的线程再次抢到，减少了切换成本。所以 `ReentrantLock` 默认仍是非公平。

**Q：学 AQS 对日常开发有什么用？**
A：它是理解整个 JUC 的钥匙——线程池的工作线程复用、锁的公平性、Condition 的精准唤醒、读写锁的共享获取，追到底层都是同一套"状态机 + 等待队列"在支撑。

## 易错点

- **入队方法是 `addWaiter`，不是 `addWaiters`**：单数形式，独占传 `Node.EXCLUSIVE`、共享传 `Node.SHARED`，名字记错在源码层面就说不通了。
- **AQS 自身不是一把锁**：它是抽象框架，不能直接当锁用，必须继承并实现 `tryAcquire`、`tryRelease`、`tryAcquireShared`、`tryReleaseShared` 中的一组。
- **入队后不是一直自旋空转**：JDK 6 之后是先试一次、再用 `shouldParkAfterFailedAcquire` 判断该不该挂起，宣称"一直在 CAS 自旋"是过时说法。
- **`await()` 会释放锁**：它先 `fullyRelease` 才进入条件队列，和 `wait()` 一样会放开锁；反过来说，无参 `tryLock()` 即使公平锁也是直接抢，不受公平策略约束。

## 一句话记住

:::tip
AQS 就是 state + CLH 变体队列：子类定规则，框架管排队。
:::
