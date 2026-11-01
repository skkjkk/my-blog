---
title: Java 中 wait、notify、notifyAll 方法有什么用？
published: 2026-10-23
description: wait 让线程在同步块内交出监视器锁并挂起，notify 唤醒等待集里的一个线程，notifyAll 唤醒全部，醒来还要重新抢锁并复查条件。
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
wait、notify、notifyAll 是 Object 类提供的线程协作原语，三者合起来构成一套等待通知机制：wait 让当前线程在 synchronized 内交出该对象的监视器锁并进入等待集，notify 从等待集里叫醒一个线程，notifyAll 叫醒全部线程，被叫醒的线程必须重新抢到锁才能从 wait 返回。它真正解决的问题，是让条件不满足的线程挂起而不是空转。

## wait 做的就是交锁并挂起

wait 只能在已经持有该对象监视器锁的代码里调用，也就是 synchronized 块或 synchronized 方法内部，否则直接抛 IllegalMonitorStateException。调用之后当前线程做三件事：释放该对象的监视器锁、把自己挂到该对象的等待集上、进入等待状态。能把它从等待里带回来的路径只有三条，被同一对象的 notify 或 notifyAll 唤醒、等待超时（用的是带超时的重载 wait(long) 或 wait(long, int)）、被其它线程中断。无论走哪条路，返回前都必须重新竞争这把锁，抢到了才会真正从 wait 那一行往下执行。还需要记住一点，wait 的返回类型是 void，它不返回任何值。

## notify 与 notifyAll 只差在唤醒几个线程

notify 从该对象的等待集中挑一个线程唤醒，挑谁由虚拟机决定，调用方既不能指定也无法保证公平；notifyAll 则把等待集里的线程全部唤醒。被唤醒只是从等待状态变成就绪状态，它们仍然要去竞争那把监视器锁，抢到的那个继续执行，其余的在锁上继续排队。两者同样是 Object 的方法，同样要求在持有该对象监视器锁时调用，没持锁一样抛 IllegalMonitorStateException。

| 对比项 | wait | notify | notifyAll |
| --- | --- | --- | --- |
| 作用 | 挂起当前线程 | 唤醒等待集里的一个线程 | 唤醒等待集里的全部线程 |
| 是否释放监视器锁 | **释放** | 不释放 | 不释放 |
| 是否要求先持锁 | 要求 | 要求 | 要求 |
| 调用之后的去向 | 重新抢到锁才返回 | 立刻返回，锁仍在手里 | 立刻返回，锁仍在手里 |
| 典型风险 | 用 if 检查条件会跑错 | 唤醒错线程，信号丢失 | 唤醒过多，多余的再 wait 回去 |

## 为什么需要它：把忙等换成挂起

只有 synchronized 的话，线程进不了临界区只能在外面干等，而一旦进了临界区又发现条件不满足，它没有别的选择：要么占着锁空转轮询，白烧 CPU，还让真正能改变条件的线程进不来；要么提前退出同步块，过一会儿再来碰运气。wait 补上的正是这块空白，它在持锁状态下主动把锁交出去并挂起，让能改变状态的线程顺利进入临界区修改数据，改完再把它叫回来。所以这套机制的核心不是「等待」，而是「要等的时候把锁交出去」。

## 标准写法：共享条件标志、while 循环与 notifyAll

正确的协作方式是选一个共享变量当条件标志，等待方在同步块里用 while 循环检查它，条件不满足就 wait；通知方在修改这个共享状态之后、并且仍然在同步块内调用 notify 或 notifyAll。

```java
public class OneSlotBox {
    private final Object lock = new Object();
    private String data;                 // 共享条件：null 表示还没有数据

    public void put(String value) {
        synchronized (lock) {
            data = value;
            lock.notifyAll();            // 先改状态，再在持锁状态下通知
        }
    }

    public String take() throws InterruptedException {
        synchronized (lock) {
            while (data == null) {       // 必须用 while，醒来后重新检查条件
                lock.wait();             // 交出 lock 并挂起，被唤醒后重新竞争 lock
            }
            String value = data;
            data = null;
            return value;
        }
    }
}
```

流程是这样的：take 发现 data 为 null 就 wait，同时把 lock 交出去；put 拿到 lock 写入 data、调用 notifyAll，等它退出同步块，锁才真正释放；take 被唤醒后重新抢到 lock，再判断一次 data 不为 null，才把数据取走。如果把 while 写成 if，一旦发生虚假唤醒，或者被唤醒的线程等的是另一个条件，它就会带着不成立的条件继续往下跑。

## 关键要点

- **wait 会释放监视器锁**：这是它和其它挂起手段最根本的区别，正因为把锁让了出来，别的线程才有机会改变条件。
- **三个方法都在 Object 上，不在 Thread 上**：调用时必须持有该对象的监视器锁，否则抛 IllegalMonitorStateException。
- **醒来不等于条件成立**：wait 返回只说明「可能有机会了」，条件要用 while 重新检查，不满足就继续 wait。
- **等待与通知必须作用于同一个对象**：wait 挂在哪个对象上，就得由同一个对象 notify，否则通知永远送不到。
- **默认选 notifyAll**：notify 只叫一个线程，叫醒的可能不是真正该跑的那个，信号就此丢失。

## 常见追问

**Q：为什么 wait 一定要写在 synchronized 里？**
A：因为 wait 的语义是「原子地释放锁并挂起」，这一步必须和条件检查构成不可分割的整体。如果检查完条件到真正挂起之间能被别的线程插进来，通知就可能在你睡下去之前发出，你随后睡下再也等不到，这就是丢失唤醒。

**Q：notify 调用完是不是立刻把锁交给被唤醒的线程？**
A：不是。notify 只是把等待集里的线程变成可竞争锁的状态，调用方仍然握着监视器锁，一路执行到退出同步块才释放，被唤醒的线程这时才可能抢到锁继续往下跑。

**Q：既然 notifyAll 更安全，为什么还留着 notify？**
A：当等待集里确实只有一个等待者，或者所有等待者关心的是同一个条件、谁被唤醒都能推进时，notify 叫一个就够，还能少一点无谓的锁竞争。一旦多种条件共用同一个对象锁，就必须用 notifyAll，否则被叫醒的线程发现自己的条件不成立又回去 wait，真正该跑的那位还在睡。

**Q：wait 和 sleep 有什么区别？**
A：wait 是 Object 的方法，只能在持锁时调用，调用后释放监视器锁并进入该对象的等待集，要靠通知、超时或中断才能返回；sleep 是 Thread 的方法，不需要持锁，睡眠期间锁一直握在手里，只按时间醒来。

## 易错点

- **以为 wait 有返回值**：错，`public final void wait()` 的返回类型就是 void，想用布尔值区分「正常唤醒」和「超时返回」的写法根本编译不过。要区分，只能在 wait 返回后自己复查条件标志，或者用时间戳判断是否已经超时。
- **用 if 代替 while 检查条件**：if 只判断一次，碰上虚假唤醒、或者 notify 叫醒的是等另一个条件的线程，就会在条件不成立时继续往下执行，读到还没准备好的数据。
- **在没持锁的地方调用**：把 wait 写在 synchronized 外面，运行时是直接抛 IllegalMonitorStateException，而不是「调了没效果」。
- **改完状态不通知，或者通知发在改状态之前**：前者让等待方永久挂起，后者让等待方醒来看到旧状态又睡回去，两种都表现为程序卡住不动。

## 一句话记住

:::tip
**wait 交出锁并挂起，醒后必须 while 复查条件，唤醒优先用 notifyAll。**
:::
