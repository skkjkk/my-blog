---
title: Java 并发库中提供了哪些线程池实现？它们有什么区别？
published: 2026-10-23
description: 线程池分两支：ThreadPoolExecutor 及其定时子类，和 ForkJoinPool 工作窃取池；Executors 只是参数预设。
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
并发库的线程池实现分两类：一类是 `ThreadPoolExecutor` 这条底座，以及继承它的 `ScheduledThreadPoolExecutor`；另一类是 `ForkJoinPool` 这条工作窃取分支。`Executors` 提供的几种开箱配置都只是它们的参数组合，差别集中在核心线程数、最大线程数、队列类型和是否支持定时，所以真正的区别不在类名，而在这几个参数怎么配。

## 一条底座，一条分支：实现谱系先分清

`ThreadPoolExecutor` 是唯一把参数全部暴露出来的实现，核心线程数、最大线程数、空闲回收时间、工作队列、线程工厂、拒绝策略六项都由调用方给定，`Executors` 里的固定形态都只是它的预设组合。`ScheduledThreadPoolExecutor` 继承它，把队列换成按到期时间排序的实现，并增加 `schedule`、`scheduleAtFixedRate`、`scheduleWithFixedDelay` 三个方法，从而支持延迟与周期执行。

`ForkJoinPool` 走的是另一条谱系：它同样实现了 `ExecutorService`，但直接继承 `AbstractExecutorService`，不是 `ThreadPoolExecutor` 的子类。两者最本质的差别在排队模型，前者是“一个共享队列、多个线程抢”，后者是“每个工作线程一个双端队列、空闲线程去别人的队尾偷”。排队模型不同，适用场景就完全不同。

## 固定与缓存：一个无界排队，一个无界扩容

`newFixedThreadPool(n)` 让核心线程数和最大线程数相等，队列用无界 `LinkedBlockingQueue`。线程数固定，多出来的任务只能在队列里排队，适合负载稳定、任务量可预估的场景，比如后台批量数据处理。

`newCachedThreadPool()` 是反向的极端：核心线程数为 0，最大线程数为 `Integer.MAX_VALUE`，队列用 `SynchronousQueue`。来一个任务就创建一个线程，空闲线程 60 秒后被回收，适合突发性短任务，比如 HTTP 异步回调处理。

这两个配置恰好是两个极端：一个固定线程数、放任队列变长；另一个固定队列长度、放任线程变多。

## 单线程与定时：顺序性和周期性

`newSingleThreadExecutor()` 只有 1 个线程，队列同样是无界 `LinkedBlockingQueue`，任务严格按提交顺序执行，任意时刻都不会有两个任务并发。它适合必须保证顺序性的场景，比如日志写入、消息顺序消费；单线程意外终止时实现里会补建一个线程继续消费队列，比手写一个死循环线程更稳。

`newScheduledThreadPool(n)` 的核心线程数由参数指定，队列换成无界的 `DelayedWorkQueue`，任务按到期时间被取走，因此支持延迟执行和周期执行，适合心跳检测、定时报表生成这类场景。它的最大线程数在实现里被设成 `Integer.MAX_VALUE`，而队列又是无界的，所以扩容这条路同样走不通，实际并发度由核心线程数决定。

## 工作窃取池：把任务拆小再抢着做

`newWorkStealingPool()` 底层是 `ForkJoinPool`，默认线程数等于 CPU 核心数。每个工作线程维护自己的双端队列，拆分出来的子任务压进自己的队列，线程空闲时会去其他线程的队列尾部偷任务执行。

这种设计的收益是负载不均时不会有人干等，代价是任务必须能拆，而且拆得太细时调度开销会盖过并行收益。它适合大量可拆分的小任务，比如递归计算、并行流处理；如果任务本身串行，或者每个任务都阻塞在 IO 上，工作窃取帮不上忙。

## 五种实现的对比

| 实现 | 核心 / 最大线程数 | 队列 | 关键行为 | 典型场景 |
|---|---|---|---|---|
| FixedThreadPool | n / n | 无界 LinkedBlockingQueue | 线程数固定，多余任务排队 | 后台批量处理 |
| CachedThreadPool | 0 / Integer.MAX_VALUE | SynchronousQueue | 有任务就建线程，空闲 60 秒回收 | 突发短任务、异步回调 |
| SingleThreadExecutor | 1 / 1 | 无界 LinkedBlockingQueue | 严格按提交顺序执行 | 日志写入、顺序消费 |
| ScheduledThreadPool | n / Integer.MAX_VALUE | DelayedWorkQueue | 延迟执行与周期执行 | 心跳检测、定时报表 |
| WorkStealingPool | CPU 核心数 / 同左，阻塞时补偿 | 每线程一个双端队列 | 空闲线程窃取他人任务 | 递归计算、并行流 |

表格里最该盯的是“无界”两个字：三个实现配的是无界队列，两个把最大线程数设成了近乎无上限，而“最大线程数”这个保护要靠入队失败才触发，队列无界就等于把它关掉。

## 生产上为什么不要直接用 Executors

- FixedThreadPool 与 SingleThreadExecutor 用无界队列，任务积压时队列会一直膨胀，最终撑爆内存。
- CachedThreadPool 的最大线程数是 `Integer.MAX_VALUE`，突发流量下会创建海量线程，把线程数和栈内存一起耗光。
- ScheduledThreadPool 同样是队列无界、最大线程数无效，任务堆积时和 FixedThreadPool 一样危险。
- 默认线程工厂产出的线程名是 `pool-N-thread-M` 这种无业务含义的编号，线上打印线程栈时判断不出是哪个业务在跑。

所以生产上更稳妥的做法是自己 `new ThreadPoolExecutor`：队列设为有界，拒绝策略显式指定，线程工厂带上可读的业务前缀。这三样都写出来，池子出问题时才有据可查。

## 一个可以直接抄的构造

把六个参数从上往下读一遍，正好能对上前面说的任务分配顺序：先占满核心线程，任务再进队列排队，队列满了才扩到最大线程数，还不行就交给拒绝策略。按这组数字，前 4 个任务直接起线程，接下来 200 个在有界队列里排队，第 205 个任务起才扩到 8 个线程，再满就由提交线程自己执行。线程工厂和拒绝策略是最容易被省掉的两项，也正是线上排障和限流时最需要的两项。

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    4,                                      // corePoolSize：常驻线程数
    8,                                      // maximumPoolSize：队列满了才用得上
    60L, TimeUnit.SECONDS,                  // keepAliveTime：非核心线程空闲多久退出
    new ArrayBlockingQueue<>(200),          // 有界队列，容量就是积压的容忍上限
    r -> new Thread(r, "report-job-" + r.hashCode()),  // 线程名带业务前缀，便于排查
    new ThreadPoolExecutor.CallerRunsPolicy()          // 拒绝时交给提交线程执行，形成反压
);

pool.execute(() -> generateReport());  // 单个任务抛异常只会结束这条线程，池子照常服务
pool.shutdown();                       // 不再接新任务，队列里的任务跑完再退出
```

需要定时能力时换调度池，参数同样显式写出来：

```java
ScheduledExecutorService scheduler = new ScheduledThreadPoolExecutor(2);
scheduler.scheduleAtFixedRate(() -> heartbeat(), 0, 30, TimeUnit.SECONDS);
```

## 常见追问

**Q：`ForkJoinPool` 和 `ThreadPoolExecutor` 是什么关系？**
A：两者都实现 `ExecutorService`，但属于两条独立谱系，`ForkJoinPool` 直接继承 `AbstractExecutorService`；它靠每个线程一个双端队列加任务窃取工作，而不是共享队列。

**Q：`newFixedThreadPool(4)` 和手写 `new ThreadPoolExecutor(4, 4, ...)` 有区别吗？**
A：本质相同，工厂方法就是把参数固定好再返回；差别在工厂方法没给你调整队列容量、拒绝策略和线程工厂的机会。

**Q：`newScheduledThreadPool` 的最大线程数有用吗？**
A：基本没用。它用的 `DelayedWorkQueue` 无界，任务不会入队失败，扩容路径走不到，实际并发度由核心线程数决定。

**Q：什么时候该用工作窃取池？**
A：任务能拆成大量独立子任务、且子任务之间负载不均时，比如递归分治和并行流。任务串行或阻塞在 IO 上时，窃取机制没有收益。

## 易错点

- **以为 `ForkJoinPool` 不实现 `ExecutorService`**：它实现了，只是不走 `ThreadPoolExecutor` 这条继承链，所以不能用“是不是它的子类”来判断一个类是不是线程池。
- **以为线程会先扩到最大再进队列**：顺序是先占满核心线程、再进队列，队列满了才扩到最大线程数，无界队列会让最后一步彻底失效。
- **以为 `newCachedThreadPool` 很省资源**：它缓存的是线程而不是任务，任务一来就建线程，突发流量下线程数能涨到系统扛不住。
- **以为单线程池不会出事**：任务抛异常会让唯一线程退出，实现里会补建一个继续消费队列，于是池还在跑、任务却已经丢了，问题更隐蔽。

## 一句话记住

:::tip
两种底座、五种配置，差别只在队列有没有界、线程数有没有上限。
:::
