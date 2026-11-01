---
title: Java 中 wait() 和 sleep() 的区别？
published: 2026-10-23
description: wait 释放所属对象的监视器锁并等待被 notify 唤醒，sleep 不释放锁只让当前线程休眠；两者在所属类、线程状态、唤醒方式和适用场景上都不同。
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
`wait()` 和 `sleep()` 最核心的区别是**对锁的处理方式不同**：`wait()` 会释放所属对象的监视器锁，`sleep()` 不释放。其次是所属类与作用对象——`sleep()` 是 `Thread` 的静态方法，让当前线程休眠；`wait()` 是 `Object` 的实例方法，等的是某个对象上的通知。这也直接决定了 `wait()` 必须写在 `synchronized` 里，而 `sleep()` 随处可调。

## 所属类与作用对象不同

`sleep()` 是 `Thread` 的静态方法，作用于**当前正在执行的线程**，所以 `t.sleep(1000)` 里睡着的仍然是调用它的这个线程，而不是 `t` 这个对象。

`wait()` 是 `Object` 的实例方法，作用于**调用它的那个对象对应的监视器锁**。也就是说，`wait()` 等待的是某个特定对象：调用哪个对象的 `wait()`，就只能被那个对象的 `notify()` 唤醒。这一点在实际使用中经常被忽略——锁加在 A 对象上却去 B 对象上等，B 被唤醒了也唤不醒你。

## 最关键的差别：wait 放锁，sleep 不放锁

`sleep()` 在等待期间**不释放**已经持有的锁，线程醒来后继续持有这把锁并向下执行，别的线程在这段时间里进不来。

`wait()` 在进入等待状态时会**释放**所属对象的监视器锁，把锁让给其他线程争抢。正因为它要操作某个对象的监视器，所以 `wait()` 必须在 `synchronized` 同步块或同步方法中调用，否则直接抛 `IllegalMonitorStateException`；而 `sleep()` 在任何地方都可以调用。

一个容易漏掉的细节是：`wait()` 只释放它所属那一个对象的锁。如果当前线程还持有别的监视器，那些锁不会被一起放开。

## 线程状态不同

调用 `sleep()` 的线程进入 **TIMED_WAITING**（限时等待）；调用不带超时的 `wait()` 的线程进入 **WAITING**（无限等待）；带超时的 `wait(long)` 则进入 **TIMED_WAITING**。这三种状态下线程都不占用 CPU 时间片。

另外，两者被中断时都会抛出 `InterruptedException`，抛出时中断标志会被清除，所以捕获之后要么继续向上抛，要么恢复中断标记。

## 唤醒方式不同

`sleep()` 到时间就会自动醒来继续执行，属于「等时间」。

`wait()` 必须由其他线程在同一个对象上调用 `notify()` 或 `notifyAll()` 显式唤醒，或者等到超时，属于「等通知」。而且被唤醒的线程并不是立刻就拿到锁——它需要重新回到同步块里参与锁竞争，拿到锁之后才从 `wait()` 返回，继续执行后面的代码。

## wait 与 sleep 对比表

| 维度 | `wait()` | `sleep()` |
| --- | --- | --- |
| 所属类 | `Object` 的实例方法 | `Thread` 的静态方法 |
| 作用对象 | 该对象的监视器锁 | 当前执行的线程 |
| 是否释放锁 | **释放**所属对象的锁 | **不释放**，一直持有 |
| 调用约束 | 必须在 `synchronized` 内，否则抛 `IllegalMonitorStateException` | 任意位置可调 |
| 线程状态 | 无超时 WAITING，带超时 TIMED_WAITING | TIMED_WAITING |
| 唤醒方式 | `notify()` / `notifyAll()` 或超时 | 时间到自动醒 |
| 典型场景 | 线程间按条件协作 | 延迟、轮询间隔 |

## 代码：一个用 wait 写的等待-通知

下面是一个单槽共享容器的最小实现：`put` 放数据、`take` 取数据，两边都用 `while` 包住 `wait()`，条件不满足就挂起并交出锁，条件变化后由 `notifyAll()` 唤醒对方重新判断。

```java
class Box {
    private String item;

    synchronized void put(String v) throws InterruptedException {
        while (item != null) {
            wait();          // 必须用 while 判断，防止虚假唤醒
        }
        item = v;
        notifyAll();         // 通知等待取数据的线程
    }

    synchronized String take() throws InterruptedException {
        while (item == null) {
            wait();          // 条件不满足就继续等，而不是 if 只判断一次
        }
        String v = item;
        item = null;
        notifyAll();
        return v;
    }
}
```

同样一段逻辑如果写成 `sleep()`，拿到的就只是「等一会儿再看」，而不是「条件满足立刻被通知」：

```java
synchronized void lockDemo() throws InterruptedException {
    Thread.sleep(1000); // 睡 1 秒，锁一直在手里，别的线程进不来
}
```

## 使用场景

`sleep()` 适合做简单的延迟模拟、轮询的间隔、以及「先歇一下再试」这类不依赖别人通知的场景。需要说明的是，真正主动让出 CPU 执行权的是 `Thread.yield()`，`sleep()` 只是按时间休眠。

`wait()` 适合用于线程之间基于某个条件的协作，比如生产者消费者、手写一个阻塞队列的等待-通知。JDK 并发包里 `ReentrantLock` 配合 `Condition` 的 `await()` / `signal()` 是同一套语义的显式锁版本。

## 常见追问

**Q：`wait()` 为什么必须写在 `while` 循环里，不能写 `if`？**
A：因为存在虚假唤醒（spurious wakeup），线程可能在没有 `notify` 的情况下自己醒来；而且被 `notifyAll` 叫醒后，条件也可能已经被别的线程抢先用掉了。醒来后必须重新判断条件，`if` 只判断一次就会带着错误前提往下执行。

**Q：`notify()` 和 `notifyAll()` 怎么选？**
A：默认用 `notifyAll()`。`notify()` 只随机唤醒一个等待者，可能唤醒的是不满足条件的那个线程，信号就此丢失，其他线程一起饿死；只有能确定只有一个等待者、且它一定满足条件时才用 `notify()`。

**Q：`sleep()` 能用在非同步代码里，`wait()` 为什么不行？**
A：`sleep()` 只管当前线程的时间，不需要接触任何对象的监视器；`wait()` 的语义是「释放锁并挂起」，它必须先确认自己确实持有这把锁，否则无从释放，因此 JVM 强制要求它在 `synchronized` 里。

**Q：`wait()` 和 `sleep()` 都会抛 `InterruptedException`，处理上有什么讲究？**
A：两者都响应中断。区别在于 `wait()` 被中断后锁还在手里（它是先重新拿到锁才抛出），而 `sleep()` 本来就不持锁。捕获后不要吞掉异常，把中断标志恢复（`Thread.currentThread().interrupt()`）或继续向上抛。

## 易错点

- **以为 `sleep()` 会让出锁**。错。`sleep()` 期间锁仍然握在自己手里，写在 `synchronized` 里就是「抱着锁睡觉」，其他线程照样阻塞。
- **以为 `wait()` 醒来就直接拿到锁**。错。唤醒只是把线程从等待队列挪到锁竞争队列，真正返回还得先抢到锁。
- **用 `t.sleep()` 想睡 `t` 这个线程**。错。`sleep()` 是静态方法，写在哪个对象上都是睡当前线程。
- **在 A 对象上加锁，却调 B 对象的 `wait()`**。会抛 `IllegalMonitorStateException`，或者等不到本该来的通知——`wait` / `notify` 必须配对在同一个对象上。

:::tip
`wait` 放下锁并等通知，`sleep` 抱着锁只等时间。
:::
