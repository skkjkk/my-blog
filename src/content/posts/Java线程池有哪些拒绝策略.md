---
title: Java 线程池有哪些拒绝策略？
published: 2026-10-23
description: "拒绝策略是 ThreadPoolExecutor 接收不了新任务时的兜底行为，四种内置实现分别抛异常、回退给提交线程或丢弃任务。"
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
拒绝策略是 `ThreadPoolExecutor` 无法接收新任务时的兜底行为，内置四种：`AbortPolicy` 默认直接抛异常，`CallerRunsPolicy` 让提交线程自己执行形成反压，`DiscardPolicy` 静默丢弃新任务，`DiscardOldestPolicy` 丢掉最旧的任务后重试。选哪个取决于任务能不能丢、提交方能不能被阻塞。

## 到底什么时候才走到拒绝策略

拒绝不是"线程数满了"就触发，`execute()` 的判定顺序是这样：

- 线程池状态不是 `RUNNING`（已 `shutdown` / `shutdownNow`）时，新提交的任务直接进入拒绝流程；
- 核心线程未满时先创建核心线程执行，满了才入队列；
- 队列满时尝试把线程扩到 `maximumPoolSize`，扩容也失败（已达上限）才拒绝。

所以真正的触发条件是两部分：**线程池已不再接收任务，或者队列已满且线程数已达 `maximumPoolSize`**。拒绝动作发生在 `execute()` 内部：`reject(command)` 会调用 `handler.rejectedExecution(command, this)`，把任务和线程池本身一起交给策略处理，而 `handler` 就是构造线程池时传入的 `RejectedExecutionHandler`。

有一个必须一起记住的前提：如果用的是**无界队列**（比如 `Executors.newFixedThreadPool` 里的 `LinkedBlockingQueue`），队列永远排不满，`maximumPoolSize` 形同摆设，拒绝策略也永远不会被触发。想让拒绝策略真正起作用，队列必须是有界队列。

## 四种内置实现的对比

四种策略都是 `ThreadPoolExecutor` 的静态内部类，无状态、可复用同一个实例。

| 策略 | 被拒绝的任务去哪了 | 是否抛异常 | 调用方能否感知 | 适用场景 |
| --- | --- | --- | --- | --- |
| `AbortPolicy`（默认） | 直接不执行 | 抛 `RejectedExecutionException` | 立刻感知 | 任务不能丢，且调用方能重试或降级 |
| `CallerRunsPolicy` | 由提交任务的线程执行 | 不抛 | 能感知（自己被执行逻辑占了时间） | 任务不能丢，且能接受提交方被短暂阻塞 |
| `DiscardPolicy` | 静默丢弃 | 不抛 | 完全无感知 | 任务本身可丢弃，或有其他补偿机制 |
| `DiscardOldestPolicy` | 丢队列里最旧的一个，新任务重新入队 | 不抛 | 完全无感知 | 只关心最新数据，允许旧数据被丢 |

## AbortPolicy：默认策略，让调用方立刻知道失败

拒绝时直接抛出 `RejectedExecutionException`，任务不入队也不执行。好处是**失败暴露得最快**：提交线程当场拿到异常，可以自行重试、降级或返回错误给上游。代价是这个异常是 `RuntimeException`，不是受检异常，编译器不会提醒你处理，漏了 `catch` 就会一路冒到最外层。

它适合**任务不能丢、且调用方有能力自行重试或降级**的场景，也是 JDK 在没显式指定策略时的默认选择。

## CallerRunsPolicy：让提交线程自己跑，用阻塞换反压

它不丢弃任务，而是让**提交任务的线程自己执行**这个任务。提交方在被占用的这段时间里无法继续提交，于是提交速度被自然压下来，队列也就有时间消化积压——这就是一种**反压机制**。代价是提交线程被阻塞，如果提交方是 Web 容器的工作线程，压得久了会连带影响其他请求的响应。

源码里它还带一个保护判断：只有线程池没关闭时才执行，`isShutdown()` 为真时任务同样被直接丢掉。

适合**不能让任务丢失、且能接受提交方被短暂阻塞**的场景。配合有界队列，它是生产环境里最常见的反压组合。

## DiscardPolicy 与 DiscardOldestPolicy：都不抛异常，但丢的东西不同

`DiscardPolicy` 的实现是**什么都不做**：新任务既不抛异常也不执行，调用方完全无感知，任务就这样消失了。

`DiscardOldestPolicy` 则先从队列头 `poll()` 出**最旧**的那一个任务丢掉，再把新任务重新 `execute()` 入队。它适合**希望始终处理最新数据、且允许旧数据被丢弃**的场景，比如实时行情刷新、滑动窗口统计——旧快照本来就会被新快照取代。它同样会先检查线程池是否已关闭，关闭状态下新任务直接丢弃、不再入队。

两者的共同点是**静默**：没有任何异常、没有任何日志，任务丢失不会留下痕迹。区别只在于丢的是新任务还是旧任务。

## 自定义策略：把任务转存到可靠通道

四种都不满足时，实现 `RejectedExecutionHandler` 接口自定义行为即可，只有 `rejectedExecution(Runnable r, ThreadPoolExecutor executor)` 一个方法。常见做法是把任务持久化到消息队列或数据库、转入补偿流程，或者降级为记录日志后丢弃。适合**对任务可靠性要求高、且已有下游兜底通道**的系统。

要注意这段逻辑跑在**提交任务的线程**里，所以必须足够快：一旦里面做了写库、发消息这类耗时操作，阻塞的就不只是被拒绝的任务，而是整个提交方。

## 代码示例：指定策略与自定义策略

构造线程池时把策略作为最后一个参数传进去即可，前面依次是核心线程数、最大线程数、空闲线程存活时间、工作队列。下面这个池子有 4 个核心线程、最多扩到 8 个线程、队列容量 100，队列塞满且线程已到上限后，新任务交给提交线程自己执行。

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    4,                              // corePoolSize
    8,                              // maximumPoolSize
    60L, TimeUnit.SECONDS,          // 空闲线程存活时间
    new ArrayBlockingQueue<>(100),  // 有界队列，满了才会触发拒绝
    new ThreadPoolExecutor.CallerRunsPolicy()
);
pool.execute(() -> System.out.println("task"));
```

换成自定义策略，把被拒绝的任务转存到可靠通道：

```java
RejectedExecutionHandler handler = (r, executor) -> {
    // 这里跑在提交任务的线程里，动作必须快
    log.warn("任务被拒绝，转入补偿通道，当前线程数 {}", executor.getPoolSize());
    mqProducer.send("task-retry", r);
};
```

## 常见追问

**Q：默认是哪个策略？线上为什么常把它换掉？**
A：默认是 `AbortPolicy`，抛 `RejectedExecutionException`。它是运行时异常，会直接冒到提交方；很多业务不接受"提交即失败"，于是换成 `CallerRunsPolicy` 做反压，或自定义转存到 MQ。

**Q：`CallerRunsPolicy` 用的是哪个线程？会不会把系统拖死？**
A：就是提交任务的那个线程，比如 Tomcat 的工作线程。它执行期间该线程腾不出来，天然限速。风险不在"死锁"，而在**慢任务占住了提交方**——如果任务本身很慢，提交线程会被长时间占用。

**Q：`DiscardOldestPolicy` 丢的是最旧的还是最新的？**
A：丢队列头，也就是排队最久、最"老"的那个，然后新任务重新入队。适合只关心最新快照的刷新类场景。

**Q：拒绝策略能实现"等一会儿再试"吗？**
A：内置四种都没有等待重试语义。要排队重试得自己写：在自定义策略里转入 MQ、写入本地缓冲队列，或按退避节奏重投。

## 易错点

- **以为"线程数满了就拒绝"**：真正的条件是队列已满且线程数达 `maximumPoolSize`，或者线程池已关闭；配无界队列时，拒绝策略永远不会被触发，`maximumPoolSize` 也等于没写。
- **以为 `DiscardPolicy` 会留日志**：它什么都不做，任务凭空消失且无告警，这是生产上最常见的静默丢任务来源。
- **以为 `CallerRunsPolicy` 一定能兜住**：线程池已 `shutdown` 时它同样直接丢弃任务，不会执行。
- **把自定义策略写成重逻辑**：它跑在提交线程里，写库、发消息一旦变慢，拖慢的是整条提交链路。

:::tip
能丢才 Discard，不能丢用 CallerRuns 反压，默认 Abort 抛异常。
:::
