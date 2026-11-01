---
title: volatile 关键字的作用和使用场景？
published: 2026-10-29
description: "volatile 靠内存屏障保证共享变量的可见性与有序性，但不保证原子性。它适合状态标志位和 DCL 单例，涉及读-改-写时必须换原子类或加锁。"
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
`volatile` 是 Java 里最轻量的可见性工具：它保证一个线程写入的共享变量能被其他线程立刻读到，并禁止编译器与 CPU 对它重排序，但**不保证原子性** —— `count++` 这种读-改-写操作即使加了 `volatile` 依然会丢更新。它的底层实现是 JVM 在 volatile 读写前后插入内存屏障。判断标准只有一条：**单写多读、且不涉及复合操作**时用 volatile 就够，否则必须换原子类或加锁。

## 可见性：改完的值，别的线程立刻能看到

当一个线程修改了 `volatile` 变量，其他线程能立即看到最新值。JVM 把被修饰的字段标记为 `ACC_VOLATILE`，读写时在前后插入**内存屏障（Memory Barrier）**：写操作后**立即刷新到主内存**，读操作前**从主内存重新读取**，绕过 CPU 的本地缓存（行缓存）。屏障一共四类 —— `LoadLoad`、`StoreLoad`、`LoadStore`、`StoreStore`，volatile 写前面插 `StoreStore`、后面插 `StoreLoad`，volatile 读后面插 `LoadLoad` 和 `LoadStore`，合起来的效果就是"别人写得进去，我读得到"。

用 JMM 的说法：主内存由所有线程共享，每个线程另有自己的工作内存（大致对应 CPU 缓存与寄存器）。普通变量的读写可能一直停在自己的工作内存里，别人改了也不知道；`volatile` 强制读写穿透到主内存，相当于把"各自缓存、可能互相看不见"改成"改完立刻广播"。

## 有序性：禁止编译器和 CPU 重排序

`volatile` 写操作前后、读操作前后都会插入内存屏障，**禁止编译器与 CPU 对 volatile 读写进行重排序**，从而保证**写-写、读-读、写-读的顺序性**。JMM 把它表述为 happens-before 规则：对一个 volatile 变量的写，happens-before 后续对同一个变量的读。

这条性质在单线程里看不出区别 —— 重排本来就要保证单线程结果不变 —— 它的价值在**跨线程的时序约定**：屏障同时把前后的普通读写"夹住"，使它们不会跑到 volatile 访问的另一侧去。**DCL 单例之所以能成立，靠的就是这一点。**

## 边界：volatile 不保证原子性

`volatile int count; count++;` **依然是错的**。`count++` 实际是**读-改-写三步**（读 count → 加 1 → 写回），线程可能在"读"与"写"之间被切换：线程 A 读到 5，线程 B 也读到 5，两者都写回 6，**一次更新丢失**。volatile 只保证"每次读写都见最新值"，不保证"这一串操作不可分割"。

```java
private volatile int count = 0;

// 反例：volatile 治不了这一步
count++;                          // 读 → 加一 → 写回，三步之间有窗口

// 正解：整步原子的自增
private final AtomicInteger atomicCount = new AtomicInteger();
atomicCount.incrementAndGet();    // CAS 循环
```

**解法**：`AtomicInteger` / `AtomicLong` 的 CAS 循环、`LongAdder`（分散热点，高竞争下优于 `AtomicLong`），或者直接 `synchronized` / `ReentrantLock`。

除原子性之外，还有三条容易被说错的语义细节：

- **被修饰的引用，只有"引用"是 volatile 的**：`volatile User user` 只保证读到的 `user` 引用是最新的，不保证 `user.name` 的可见性；要保证对象内容可见，对象本身应当不可变。
- **单次读写原子，复合操作不原子**：引用与基本类型的单次读写不会撕裂，但"读-改-写"依然不是不可分割的整体。
- **64 位变量不再是例外**：对 `volatile` 修饰的 `long` / `double`，读写一定是原子的（JDK 5 起 JMM 明确），不能把早年"64 位写可能被拆成两次 32 位写"的印象套到 volatile 上。

## 典型使用场景

判断标准只有一条：**单写多读、且不涉及读-改-写**。满足它，volatile 就够了，不必上锁。

- **状态标志位（最典型）**：一个线程改标志，其他线程轮询退出循环或切换分支。单个布尔位、一写多读，是最干净的 volatile 用法。
- **DCL 单例的实例引用**：禁止 `new` 的三步重排，避免别人拿到半成品，详见下一节。
- **多线程各写各的槽位**：互不依赖的独立变量，比如并发容器里的节点引用（`ConcurrentHashMap` 的节点）、`ArrayBlockingQueue` 的 `count`。没人对同一个变量做读-改-写，volatile 就足够。至于 `ThreadLocal`，每个线程独占自己的副本，本来就不存在可见性问题，用不上 volatile。
- **一次性状态发布**：用 volatile 引用指向一个**不可变对象**，"volatile + 不可变对象"是 Java 里发布对象的安全模式之一；单次布尔状态需要 CAS 判断时，改用 `AtomicBoolean`。
- **轻量替代读写锁（有限场景）**：一个线程写、另一个线程读同一个值（生产者向消费者传"最新值"），volatile 能保证读到最新值；但若需要"一组相关状态同时一致"，volatile 就不够了，应换 `AtomicReference` 持有不可变对象，或用锁。

```java
private volatile boolean running = true;

// 线程 A：发出停止信号
running = false;

// 线程 B：轮询标志位，能及时看到并退出
while (running) {
    doWork();
}
```

## DCL 单例为什么必须加 volatile

```java
public class Singleton {
    private static volatile Singleton instance;   // 少了 volatile 就是错的

    public static Singleton getInstance() {
        if (instance == null) {                   // 第一次检查，无锁快路径
            synchronized (Singleton.class) {
                if (instance == null) {           // 第二次检查
                    instance = new Singleton();
                }
            }
        }
        return instance;
    }
}
```

`instance = new Singleton()` 在指令层面是三步：**分配内存 → 创建对象（执行构造）→ 把引用赋给变量**。JIT 与 CPU 可能把它重排成**分配内存 → 把引用赋给变量 → 创建对象**。此时另一个线程走到第一次检查，看到 `instance != null` 就直接返回，而它指向的对象**字段还是默认值**，于是拿到一个"半成品"单例，后续可能莫名其妙地读到 0 或者空指针。

`volatile` 禁止的就是这个重排 —— **引用的赋值一定发生在对象构造完成之后**。这也是面试里最能拉开差距的地方：多数人只会说"用 volatile 保证可见性"，讲不出重排这一层。

## 和锁、原子类怎么选

| 能力 | `volatile` | `synchronized` / `ReentrantLock` | `AtomicInteger` 等原子类 |
| --- | --- | --- | --- |
| 保证可见性 | 是 | 是 | 是 |
| 保证有序性 | 是 | 是 | 是 |
| 保证原子性 | **否** | 是 | 是（仅单个变量） |
| 是否阻塞 | **不阻塞**，无竞争时极轻量 | 会阻塞、有线程切换成本 | 不阻塞，高竞争下靠自旋重试 |
| 适合 | 单个标志位、单写多读 | 复合操作、多个变量要一起改 | 计数器、单变量的读-改-写 |

`AtomicInteger` 这些类**内部就是 volatile 字段 + CAS 循环**，在 volatile 之上补齐了原子性，所以"能用原子类就用原子类"通常更省心 —— 语义更准确，意图也更清楚。例外是只传递引用、传递不可变对象或做状态标志：这些场景 volatile 已经足够，不必引入原子类。

## JDK 与 JUC 里的 volatile 足迹

翻 JUC 源码会发现 volatile 无处不在，**理解 JUC 必须先理解 volatile**：

- **线程中断标记**：`Thread` 内部的标志字段由 `interrupt()` 写入、`isInterrupted()` / `interrupted()` 读取。
- **线程池**：`Worker` 的状态字段与 `ctl`，用 volatile 加 CAS 同时维护运行状态和线程数。
- **`ConcurrentHashMap`**：`table`、`baseCount`、`sizeCtl` 都是 volatile，扩容与计数靠 volatile 读配合 CAS 写。
- **`CopyOnWriteArrayList`**：内部的 `array` 引用是 volatile，写时整体替换数组，读线程永远看到完整快照。
- **`AtomicInteger`**：内部的 `value` 字段是 volatile，原子性由 CAS 保证。

共同套路是"**volatile 保证可见，CAS 保证原子**"，两者合起来才构成无锁并发的基础。

## 常见追问

**Q：volatile 能替代 `synchronized` 吗？**
A：不能。volatile 只管可见性和有序性，管不了互斥，也管不了复合操作的原子性。它只在"单写多读、不涉及读-改-写"时才是锁的替代品；一旦有多个线程同时改、或者多个字段必须一起保持一致，就得上锁或原子类。

**Q：`volatile` 和 `AtomicInteger` 都有可见性，该用哪个？**
A：看有没有读-改-写。只是标志位、只是传递引用，volatile 更轻、意图更清楚；要做计数、累加、状态机推进这类复合操作，`AtomicInteger` / `LongAdder` 才正确。原子类的可见性本来就来自内部的 volatile 字段，属于"顺手带到"的能力。

**Q：volatile 是不是强制每次都读主内存、禁用 CPU 缓存？**
A：这是对实现的误读。JMM 的"主内存 / 工作内存"是抽象模型，硬件上依靠缓存一致性协议和内存屏障实现可见性，并不是把缓存关掉。准确说法是：volatile 的读写建立了线程间的 happens-before 关系，读线程一定能看到写线程在此之前完成的写入。

**Q：DCL 里只给 `instance` 加 volatile 就够了吗？**
A：对这个单例的"安全发布"是够的 —— 它切断了 new 的三步重排。但它不负责初始化的互斥与只执行一次，那部分仍然靠 `synchronized` 的双重检查；两次 `null` 判断也都不能省，少一次就退化成每次调用都抢锁。

## 易错点

- **以为加了 volatile 就线程安全**：它只补可见性和有序性，原子性完全不管，`count++`、`check-then-act` 这类写法照样出错。
- **用 `volatile` 修饰数组或集合就以为元素安全**：`volatile int[] arr` 只有"引用"是 volatile 的，`arr[0] = 1` 依然是普通写；`volatile List list` 同理，`list.add()` 与列表内部状态都不受保护。
- **以为 volatile 引用可见，对象内部字段就可见**：字段的可见性不由引用传递，发布的对象应当是不可变对象，或者内部字段同样用 volatile / final 保护。
- **把 volatile 当成轻量锁来"保护一段逻辑"**：屏障没有互斥语义，两个线程同时写同一个 volatile 变量，最终值依然是后写的那个，逻辑上的"检查再执行"完全不成立。

## 一句话记住

:::tip
**volatile 管看得见、管排好队，管不了原子；遇到读-改-写，换原子类或锁。**
:::
