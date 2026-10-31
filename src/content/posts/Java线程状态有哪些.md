---
title: Java 线程有哪几种状态？
published: 2026-10-22
description: Java 线程在 java.lang.Thread.State 中被定义为六种状态，分别是 NEW、RUNNABLE、BLOCKED、WAITING、TI…
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
Java 线程在 `java.lang.Thread.State` 中被定义为六种状态，分别是 NEW、RUNNABLE、BLOCKED、WAITING、TIMED_WAITING 和 TERMINATED。

NEW 是初始状态，线程对象创建出来但还没有调用 start 方法。RUNNABLE 是运行状态，需要注意在 Java 层面它同时涵盖了操作系统层面的就绪和运行两种情况，因为线程拿到时间片在真正执行代码之前，会先进入由操作系统调度的就绪队列，所以在 Java 看来都统称 RUNNABLE；另外阻塞在 IO 上的线程在 Java 看来也是 RUNNABLE。

BLOCKED 是指线程因为想要进入同步代码块或者同步方法，但锁被其他线程占用而处于阻塞等待的状态。WAITING 是指线程进入了等待状态，需要等待其他线程显式唤醒才能继续，典型场景是调用 Object 的 wait 方法、Thread 的 join 方法或者 LockSupport 的 park 方法。TIMED_WAITING 和 WAITING 的区别在于它带有超时参数，时间一到就会自动回到 RUNNABLE，典型场景是 sleep、wait 带超时、join 带超时以及 parkNanos。TERMINATED 是线程执行完 run 方法之后的终止状态。

状态转换方面有一条重要规则：线程一旦进入 TERMINATED 就不能再变回其他状态，状态是单向流动的，而 BLOCKED、WAITING、TIMED_WAITING 之间可以相互转换，最终再回到 RUNNABLE。

面试中容易被追问的一个细节是，BLOCKED 状态是专门针对 synchronized 锁而言的，ReentrantLock 这类基于 AQS 的锁在竞争失败时，线程处于的是 WAITING 状态，而不是 BLOCKED。
