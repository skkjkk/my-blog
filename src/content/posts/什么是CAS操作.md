---
title: 什么是 Java 的 CAS（Compare-And-Swap）操作？
published: 2026-10-23
description: "CAS 是一条 CPU 级别的原子指令，语义是\"比较并交换\"：比较内存中某个位置的值是否等于预期值，若相等则原子地把它改成新值并返回成功，否则不做任何修改…"
tags: [并发编程, 面试]
category: Java
draft: false
---
CAS 是**一条 CPU 级别的原子指令**，语义是"比较并交换"：比较内存中某个位置的值是否等于预期值，若相等则原子地把它改成新值并返回成功，否则不做任何修改并返回失败。整个"比较"和"交换"过程是原子的，不会被线程打断，因此它是实现无锁并发的基础。

1) **基本用法**。JDK 中通过 `Unsafe` 暴露的 `compareAndSwap` 方法实现，典型代码是读取当前值 `v`、期望更新为 `next` 时调用 CAS，若失败则重试。JUC 里的 `AtomicInteger` 内部就是用 CAS 循环来实现 `incrementAndGet` 这类原子操作的。

2) **为什么需要它**。在 `synchronized` 之前，多线程更新共享变量只能靠加锁，而锁会阻塞、存在线程切换开销。CAS 提供了**无锁**的替代路径，只在**真正有竞争时**才失败重试，无竞争时开销极小。

3) **典型实现是自旋**。CAS 操作通常写成循环：读取当前值 → 计算新值 → CAS → 失败则重试。这个"自旋"过程消耗的是 CPU 而不是让出线程，所以适合**竞争激烈但临界区极短**的场景。

4) **核心问题是 ABA**。CAS 只比较值，不关心这个值被改过几次。线程 A 读到 0，线程 B 把 0 改成 1 又改回 0，A 的 CAS 就会成功，但它读到的其实已经不是原来那个对象了。解决方案是给对象加上**版本号（version stamp）**，CAS 时同时比较值和版本，这就引出了 `AtomicStampedReference`。

5) **另一个问题是自旋浪费**。线程数超过 CPU 核数时，多个线程自旋等待同一个锁会互相抢 CPU，反而降低性能。JDK 8 后 `synchronized` 引入了自适应自旋来缓解这个问题。

6) **常见实现类**。`AtomicInteger`、`AtomicLong`、`AtomicBoolean`、`AtomicReference`、`AtomicIntegerArray`、以及 JDK 8 后的 `LongAdder` 和 `DoubleAdder` —— 后两者在高竞争下用**分散热点**的方式（多个 Cell 各自累加再求和）避免 CAS 争抢，是 `AtomicLong` 计数场景的更优选择。

7) **与锁的取舍**。CAS 适合**低竞争、临界区短、无需跨代码块加锁**的场景；`synchronized` 或 `ReentrantLock` 适合**临界区长、竞争激烈、需要公平性或多条件等待**的场景。实际中两者常常配合使用，比如 `LongAdder` 内部用 CAS 更新 `Cell`，而 Cell 数组的扩容仍用 synchronized。
