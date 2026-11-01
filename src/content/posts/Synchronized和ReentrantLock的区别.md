---
title: Synchronized 和 ReentrantLock 有什么区别？
published: 2026-10-23
description: 两者都是 Java 的互斥锁且都可重入；synchronized 由 JVM 自动加解锁，ReentrantLock 手动加解锁，但多了超时、中断、公平与多条件队列能力
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
两者都是 Java 的互斥锁，都保证同一时刻只有一个线程进入临界区，而且都是可重入的，区别集中在实现机制、灵活性和能力边界上。一句话概括：`synchronized` 是 JVM 关键字，加锁解锁由字节码自动完成，绝不会忘记释放；`ReentrantLock` 是 `java.util.concurrent.locks` 下的类，基于 AQS 实现，需要手动 `lock()` 和 `unlock()`，代价是多写几行，换来的是可中断、可超时、可选公平、多条件队列以及读写锁这些能力。默认优先用 `synchronized`。

## 实现机制：一个交给 JVM，一个自己调

`synchronized` 是 JVM 层面的关键字，加锁和解锁对应字节码里的 `monitorenter` 与 `monitorexit` 指令，锁的获取与释放由 JVM 负责，线程退出同步块时自动释放，异常退出也一样；锁状态记录在对象头的 Mark Word 里，竞争激烈时会膨胀成重量级锁，交给 monitor 的等待队列管理。

`ReentrantLock` 是 `java.util.concurrent.locks` 下的一个普通类，依赖 AQS 实现：AQS 用一个 `volatile int state` 表示同步状态，用一条 CLH 变体的双向队列管理没抢到锁的线程，抢不到的线程会被 `park` 挂起。所以它的 `lock()` 和 `unlock()` 必须显式调用，`unlock()` 通常要放在 `finally` 块里，保证无论正常返回还是抛异常都能解锁。可重入两者都支持，`synchronized` 靠 monitor 的重入计数，`ReentrantLock` 靠 `state` 累加并记录当前持有线程。

## 能力差距：多出来的都是 synchronized 给不了的

`ReentrantLock` 真正的价值在这五条能力上，面试时把这五条说全，基本就答到位了。

- **可中断获取**：`lockInterruptibly()` 在等锁过程中能响应中断；`synchronized` 卡在等 monitor 锁的 BLOCKED 状态时无法被中断。
- **限时获取**：`tryLock(timeout, unit)` 拿不到锁就返回，避免线程无限期挂起；`synchronized` 没有任何超时机制。
- **公平性**：`ReentrantLock` 构造时可以指定公平策略，公平锁按等待队列的先后顺序获取，牺牲吞吐量换取更可预期的行为；`synchronized` 永远是非公平的。
- **多条件等待**：`newCondition()` 能创建多个 `Condition`，每个条件拥有独立的等待队列，可以精确唤醒满足特定条件的线程；`synchronized` 配 `wait`/`notify` 只有一个等待集。
- **锁的类型**：`synchronized` 只有独占锁一种；同族的 `ReentrantReadWriteLock` 还提供读锁和写锁，读读并发、读写互斥，适合读多写少的场景（`ReentrantLock` 本身仍然是独占锁）。

| 维度 | `synchronized` | `ReentrantLock` |
| --- | --- | --- |
| 实现层次 | JVM 关键字，字节码加解锁 | JUC 的类，基于 AQS |
| 释放方式 | 自动，异常也会释放 | 手动 `unlock()`，必须放 `finally` |
| 可重入 | 支持 | 支持 |
| 等锁时能否中断 | 不能 | `lockInterruptibly()` 可以 |
| 超时获取 | 不支持 | `tryLock(timeout)` |
| 公平性 | 固定非公平 | 构造时可选，默认非公平 |
| 条件队列 | 单个等待集 `wait`/`notify` | 多个 `Condition` |
| 锁类型 | 仅独占 | 独占，同族另有读写锁 |
| 状态观测 | 无 | `isLocked()`、`getHoldCount()`、`isFair()` |

## 多条件等待与中断的真实差别

`synchronized` 配 `wait`/`notify` 时，整把锁只有一个等待集：线程 `wait()` 后进入该对象的等待队列，`notify` 只能随机唤醒其中一个，被唤醒的线程等的条件不一定已经满足，所以必须用 `while` 循环重新判断条件。多个业务条件混在同一个等待集里，就会出现漏唤醒和误唤醒，只能靠 `notifyAll` 兜底，把无关线程也一并叫醒。

这里要纠正一个很常见的错误说法：`Object.wait()` 本身是**可中断**的，被中断时抛 `InterruptedException`，它也会释放 monitor。真正不可中断的是「抢不到 monitor 锁、卡在 BLOCKED 状态」这一步。`Condition.await()` 同样响应中断，此外还提供不响应中断的 `awaitUninterruptibly()` 变体。

`ReentrantLock` 用 `newCondition()` 给每个条件建独立的等待队列，能只唤醒等某个条件的线程，`BlockingQueue` 内部就是用 `notFull` 和 `notEmpty` 两个 `Condition` 实现的。

```java
ReentrantLock lock = new ReentrantLock();        // 传 true 得到公平锁，默认非公平
Condition notFull = lock.newCondition();
Condition notEmpty = lock.newCondition();

lock.lock();
try {
    while (queue.size() == capacity) {
        notFull.await();          // 可响应中断；条件不满足就继续等
    }
    queue.add(item);
    notEmpty.signal();            // 只唤醒在等“非空”的线程
} finally {
    lock.unlock();                // 漏写这行就是死锁
}
```

## 性能差距是有条件的，别背结论

低竞争下两者接近；高竞争时 `synchronized` 早期确实开销较大，但 JDK 6 引入了偏向锁，后续又加入自适应自旋和锁消除，两者差距已经大幅缩小。偏向锁在新版本 JDK 里已经被废弃，今天谈优化主要提自适应自旋和锁消除更稳妥。

反过来说，`ReentrantLock` 每次加锁都要走 AQS 的尝试获取，失败还要包装成节点入队并 `park`，对象和状态更新比 `synchronized` 从偏向到轻量级的快速路径更多。所以「`ReentrantLock` 更快」是过时认知，它的优势更多来自前面那些**额外能力**，而不是单纯的吞吐量。

## 写法差异与死锁风险

`synchronized` 天然不会忘记释放，异常路径也由 JVM 兜底，只要锁的范围划对就没有泄漏问题。`ReentrantLock` 靠手写 `unlock()`，一旦漏写，或者在 `unlock()` 之前 return、抛异常而没被 `finally` 覆盖到，锁就会永久停在持有者手上，后续线程全部阻塞。这是它的主要风险点，所以写法上要求 `lock()` 紧随其后就是 `try`，`unlock()` 放在 `finally` 的第一行。

## 选型的实践建议

能用 `synchronized` 就用 `synchronized`，代码更简洁、不易出错，也不需要考虑中断、超时这些分支。只有在需要超时获取、可中断、公平性、多条件队列或读写锁这几种能力时，才引入 `ReentrantLock`。如果只是担心 `synchronized` 慢而换锁，多半是白折腾，因为它慢的假设在现代 JVM 上基本不成立。

## 常见追问

**问：`synchronized` 底层到底怎么实现的？**

答：字节码层面是 `monitorenter`/`monitorexit`，运行时靠对象头 Mark Word 标记锁状态，无竞争走偏向或轻量级锁的 CAS 路径，竞争激烈才膨胀成重量级锁并进入 monitor 的等待队列。

**问：公平锁一定比非公平锁好吗？**

答：不是。公平锁按 FIFO 排队，行为可预期但吞吐更低；非公平锁允许刚释放锁的线程继续抢，减少了唤醒开销，实际吞吐通常更高，所以 `ReentrantLock` 默认也是非公平。

**问：`synchronized` 能替代 `ReentrantLock` 的所有场景吗？**

答：不能。只要需要超时、可中断、公平、多条件队列或读写锁，就必须用 JUC 的锁，`synchronized` 这五样一个都不提供。

## 易错点

- **说 `wait()` 不响应中断、不释放锁**：两处都错。`wait()` 会释放 monitor 并抛 `InterruptedException`；真正不可中断的是等锁的 BLOCKED 状态。
- **说 `ReentrantLock` 一定更快**：过时结论。现代 JVM 低竞争下 `synchronized` 往往更省，选 `ReentrantLock` 的理由是能力而不是速度。
- **裸写 `lock()` 不配 `try`/`finally`**：一旦中间抛异常，锁永不释放，线程全部卡死。
- **以为 `synchronized` 也能设公平锁或用 `tryLock`**：都不能，这两项是 `ReentrantLock` 独有的。

## 一句话记住

:::tip[一句话记住]
默认用 `synchronized`；要超时、中断、公平、多条件、读写锁才换 `ReentrantLock`。
:::
