---
title: volatile 关键字的作用和使用场景？
published: 2026-10-29
description: "volatile 是 Java 中用于保证可见性和有序性的关键字。它解决的是\"一个线程修改了共享变量，其他线程何时能看到\"的问题，但不保证原子性 —— 这…"
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
`volatile` 是 Java 中用于保证**可见性**和**有序性**的关键字。它解决的是"一个线程修改了共享变量，其他线程何时能看到"的问题，**但不保证原子性** —— 这是最需要分清的一点。

1) **核心作用一：保证可见性**。当一个线程修改了 `volatile` 变量，**其他线程能立即看到最新值**。原理是：`volatile` 修饰的字段在 JVM 中**被标记为 volatile**，读写时会插入**内存屏障（Memory Barrier）** —— 写操作后**立即刷新到主内存**，读操作前**从主内存重新读取**，绕过 CPU 的本地缓存（行缓存）。
> **通俗理解：普通变量是"各自缓存、可能互相看不见"，volatile 是"改完立刻广播"。**

2) **核心作用二：禁止指令重排序**。`volatile` 写操作前后会插入内存屏障，**禁止编译器与 CPU 对 volatile 读写进行重排序**，从而保证**"写-写"、"写-读"、"读-读"的顺序性**。**这一点是 DCL 单例能成立的基础**。

3) **⚠️ 不保证原子性**（最关键的边界）
`volatile int count; count++;` **依然是错的**。`count++` 实际是**读-改-写三步**（读 count → 加 1 → 写回），线程可能在"读"与"写"之间被切换，导致**更新丢失**。
> **正确做法**：用 **原子类**（`AtomicInteger`、`AtomicLong`、`LongAdder`）或加锁。

4) **使用场景一：状态标志位（最典型）**
一个线程修改标志位、其他线程轮询退出循环或切换分支。**只要是"一个线程写、多个线程读"的单个布尔/标志位，且不涉及"读-改-写"，用 volatile 就够了。**
```java
private volatile boolean running = true;
// 线程A: running = false;
// 线程B: while (running) { ... }   // 能及时退出
```

5) **使用场景二：Double-Checked Locking 单例** ⭐
```java
private static volatile Instance instance;
public static Instance getInstance() {
    if (instance == null) {                    // 第一次检查（无锁，快路径）
        synchronized (Instance.class) {
            if (instance == null) {            // 第二次检查
                instance = new Instance();
            }
        }
    }
    return instance;
}
```
**为什么必须加 volatile**：没有它时，`instance = new Instance()` 会被编译为"**分配内存 → 创建对象 → 把引用赋给变量**"三步，**JIT/CPU 可能重排为"分配内存 → 把引用赋给变量 → 创建对象"**。另一个线程在第一次检查时看到 `instance != null` 但**对象尚未初始化完成**（字段还是默认值），拿到一个"半成品"单例。
> **volatile 禁止了这个重排** —— 保证引用赋值一定发生在对象构造完成之后。

6) **使用场景三：独立多线程写、互不依赖的变量**
多个线程各自写自己的槽位（如 `ConcurrentHashMap` 的 `volatile` 节点引用、`ArrayBlockingQueue` 的 `count`、`ThreadLocal` 之外的简单状态）。**只要不共享同一变量的读-改-写，volatile 足够。**

7) **使用场景四：一次性状态发布**
如 `AtomicBoolean` 替代 `volatile boolean` 做 CAS；或用 volatile 引用指向**不可变对象** —— **"volatile + 不可变对象"是 Java 里发布对象的安全模式之一**。

8) **使用场景五：作为"读写锁"的轻量替代（有限场景）**
一个线程写、另一个线程读同一个值的场景（生产者-消费者传"最新值"），volatile 能保证读到最新值。**但若需要"读到一致的一组相关状态"，volatile 不够** —— 此时应换 `AtomicReference` 持有不可变对象，或用锁。

9) **使用场景六：JVM 内部与框架中的用法**
**`Thread.interrupted()`/`isInterrupted()` 的中断标志**是 volatile 的｜**线程池的 `Worker` 状态与 `ctl`** 是 volatile + CAS ｜ **`ConcurrentHashMap` 的 `table`、`baseCount`、`sizeCtl`** ｜ **`CopyOnWriteArrayList` 的 `array`** ｜ **`AtomicInteger` 的 `value`**（CAS + volatile）。**理解 JUC 必须先理解 volatile。**

10) **为什么不能给 count++ 用 volatile**
- `count++` = 读 → 加 → 写，**三步之间存在窗口**
- 线程 A 读到 5，线程 B 也读到 5，两者都写回 6 → **一次更新丢失**
- **volatile 只保证"每次读写都见最新值"，不保证"这一串操作不可分割"**
- **解法**：`AtomicInteger.incrementAndGet()`（**CAS 循环**）、`LongAdder`（**分散热点，高竞争下优于 AtomicLong**）、或 `synchronized`/`ReentrantLock`。

11) **volatile 与锁的对比**

| | `volatile` | `synchronized` / `ReentrantLock` |
|---|---|---|
| 保证可见性 | ✅ | ✅ |
| 保证有序性 | ✅ | ✅ |
| **保证原子性** | ❌ | ✅ |
| 是否阻塞 | **不阻塞**（无竞争时极轻量） | 会阻塞、线程切换 |
| 适用 | 单个标志位、单写多读 | 复合操作、读-改-写 |

12) **volatile 与 Atomic 类的对比**
`AtomicInteger` 等**内部就是 volatile 字段 + CAS 循环**，在 volatile 之上补齐了**原子性**。**能用 Atomic 类就用 Atomic 类** —— 语义更准确、意图更清晰。
> **例外**：如果只是**传递引用、传递不可变对象**、或**做状态标志**，volatile 已足够，不需要引入 Atomic。

13) **三个必须知道的细节**
- **volatile 修饰的引用，其"引用"是 volatile 的，但引用指向的对象内部状态不受影响** —— `volatile User user` 只保证**读到的 user 引用是最新的**，不保证 `user.name` 的可见性。**要保证对象内容可见，对象本身应不可变。**
- **volatile 字段的读写是"原子"的**（指引用或基本类型的单次读写不会撕裂），但**不是"复合操作原子"**。
- **`volatile` 不能用于 64 位非原子操作的前提已不存在** —— JMM 规定**对 `long`/`double` 的 volatile 读写是原子的**（JDK 5 起）。

14) **面试答法建议**。三点：**① 两个作用（可见性 + 禁止重排序），靠内存屏障实现；② 明确"不保证原子性"，`count++` 是反例，解法是 Atomic 类或锁；③ 典型场景（状态标志位、DCL 单例加 volatile 的原因——禁止 new 的重排导致半成品对象、并发容器内部）。** 第三点里能讲清"DCL 为什么必须加 volatile"是最能拉开差距的地方 —— 多数人只会说"用 volatile 保证可见性"，说不出重排这一层。
