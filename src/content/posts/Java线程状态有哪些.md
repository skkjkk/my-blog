---
title: Java 线程有哪几种状态？
published: 2026-10-22
description: Java 线程只有六种状态，关键区分是 BLOCKED 专指等 synchronized 锁，AQS 锁竞争失败落在 WAITING。
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
Java 线程在 `java.lang.Thread.State` 中被定义为六种状态：NEW、RUNNABLE、BLOCKED、WAITING、TIMED_WAITING、TERMINATED。真正要讲清的是三件事：RUNNABLE 同时涵盖了操作系统层面的就绪、运行，以及阻塞在 IO 上的线程；BLOCKED 只表示在等 `synchronized` 的 monitor 锁；基于 AQS 的 `ReentrantLock` 这类锁竞争失败时，线程并不进入 BLOCKED，而是进入 WAITING。

## 六种状态各自在什么条件下出现

状态是一个瞬时快照，用 `Thread.getState()` 拿到，编码时不要拿它当同步手段。六种状态的触发条件和出口可以对照下表：

| 状态 | 触发条件 | 怎么离开 |
| --- | --- | --- |
| NEW | 线程对象已创建，但还没调用 `start()` | 调用 `start()` 进入 RUNNABLE |
| RUNNABLE | 已启动，正在运行、就绪等 CPU，或阻塞在 IO 上 | 被调度、被阻塞或被 park 后转入其他状态 |
| BLOCKED | 想进 `synchronized` 代码块或方法，但 monitor 锁被别的线程占着 | 拿到锁后回到 RUNNABLE |
| WAITING | 调用了不带超时的 `Object.wait()`、`Thread.join()`、`LockSupport.park()` | 被 notify/notifyAll 唤醒、等待的目标线程结束，或被 unpark |
| TIMED_WAITING | 带超时的等待：`Thread.sleep(ms)`、`wait(ms)`、`join(ms)`、`parkNanos` | 超时自动醒，或被提前唤醒 |
| TERMINATED | `run()` 执行结束，正常返回或抛异常都算 | 不可再回到其他状态 |

## RUNNABLE 为什么把就绪、运行和 IO 阻塞都算进去

Java 的线程状态是 JVM 层面的抽象，不是操作系统线程状态的照搬。线程拿到时间片才算真正执行，在这之前它待在操作系统的就绪队列里排队，Java 这边没有单独的「就绪」状态，统一记作 RUNNABLE。同理，阻塞式读写 socket、读文件时，线程在操作系统里确实被挂起了，但 JVM 没有为它定义第七种状态，于是它在 Java 看来仍然是 RUNNABLE。

这条结论的实用价值是：看到 RUNNABLE 不代表线程在烧 CPU。排查 CPU 飙高时不能只数 RUNNABLE 的线程个数，要看线程栈里谁在跑业务逻辑、看各线程的 CPU 时间占比。

## BLOCKED 和 WAITING 的边界在哪

BLOCKED 的语义非常窄，只针对 `synchronized` 的 monitor 进入竞争：进同步块、进同步方法，以及被 notify 唤醒后重新抢 monitor 的那一下，都会显示 BLOCKED。

显式锁走的是另一条路。`ReentrantLock.lock()` 竞争失败时，AQS 把线程挂到同步队列里并调用 `LockSupport.park()`，此时状态是 WAITING；用 `tryLock(timeout)` 这类带超时的接口才是 TIMED_WAITING。所以拿 BLOCKED 判断「线上有没有锁竞争」会漏掉绝大多数显式锁场景，这是面试里区分「背过」和「真看过」的地方。

## 状态怎么流转，哪一步不可逆

- `NEW → RUNNABLE`：调用 `start()`，而且只能调一次。
- `RUNNABLE → BLOCKED / WAITING / TIMED_WAITING → RUNNABLE`：等待条件满足或者被唤醒后回到 RUNNABLE，继续排队等 CPU。
- `RUNNABLE → TERMINATED`：`run()` 结束，进入终态。

BLOCKED、WAITING、TIMED_WAITING 三者之间也可以互相转换，例如持有 monitor 后调 `wait()`、被唤醒后又要重新抢 monitor。唯一不可逆的是 TERMINATED：线程一旦终止就再也回不到其他状态，想让同样的逻辑再跑一遍只能新建线程对象。

## 用代码观察一次完整流转

```java
Object lock = new Object();
Thread t = new Thread(() -> {
    try {
        Thread.sleep(200);                // 进 TIMED_WAITING
        synchronized (lock) {             // lock 被占用时会先 BLOCKED
            // 干活
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    }
});

System.out.println(t.getState());         // NEW
t.start();
Thread.sleep(50);
System.out.println(t.getState());         // TIMED_WAITING
t.join();
System.out.println(t.getState());         // TERMINATED
```

三个输出分别落在 NEW、TIMED_WAITING、TERMINATED。想看 BLOCKED，就让主线程先 `synchronized (lock)` 占住锁再 `start()`。`jstack` 打印的线程栈是同一份信息的展开版本：BLOCKED 的线程会带一行 waiting to lock，指向它想拿的那个对象；WAITING 则标注 on object monitor 或 parking，配合栈顶方法就能看出它在等 `wait()` 还是 `park()`。

## 常见追问

**问：sleep 和 wait 有什么区别？**
答：`Thread.sleep` 是 Thread 的方法，时间到自动醒，状态是 TIMED_WAITING，期间不释放任何锁；`Object.wait` 必须在 `synchronized` 里调用，会释放 monitor 并进入 WAITING，不带超时时必须靠 notify/notifyAll 唤醒。

**问：BLOCKED 会不会出现在 ReentrantLock 上？**
答：不会。`ReentrantLock` 的竞争走 AQS，排队线程被 park，状态是 WAITING，带超时的 `tryLock` 是 TIMED_WAITING。jstack 里看不到 BLOCKED，不等于没有锁竞争。

**问：线程处于 WAITING 会不会占 CPU？**
答：不会。BLOCKED、WAITING、TIMED_WAITING 都是被挂起的，不占 CPU；被唤醒后回到 RUNNABLE 重新排队等时间片。

**问：线程池里的空闲线程通常是什么状态？**
答：核心线程从阻塞队列取任务时阻塞在 `take()` 上，状态是 WAITING；非核心线程或开启了核心线程超时的线程用 `poll(keepAlive)` 等任务，状态是 TIMED_WAITING。

## 易错点

- 把 RUNNABLE 当成「正在跑」：它还包含就绪和阻塞在 IO 上的线程，判断 CPU 热点要看线程栈而不是数状态。
- 以为等待一定释放锁：只有 `wait()` 会释放 monitor，`sleep`、`park`、`join` 都不释放调用者已持有的锁，在同步块里 sleep 会让别的线程一直 BLOCKED。
- 拿 BLOCKED 判断锁竞争：这只对 `synchronized` 成立，基于 AQS 的锁在竞争失败时表现为 WAITING。
- 以为线程可以复用：TERMINATED 是终态，重复调用 `start()` 直接抛 `IllegalThreadStateException`，要重跑只能新建线程。

## 一句话记住

:::tip
六种状态里，BLOCKED 专等 monitor 锁，AQS 锁竞争落在 WAITING。
:::
