---
title: Thread 中 start() 和 run() 方法有什么区别？
published: 2026-10-22
description: start() 和 run() 最核心的区别在于是否创建新线程。start() 会向 JVM 申请创建一个新线程，由这个新线程去执行 run()，调用之后…
tags: [并发编程, 面试]
category: Java
section: note
draft: false
---
`start()` 和 `run()` 最核心的区别在于是否创建新线程。`start()` 会向 JVM 申请创建一个新线程，由这个新线程去执行 `run()`，调用之后立即返回，主线程继续往下走；而 `run()` 只是一个普通实例方法，谁调用它就在谁的线程里同步执行，不产生任何新线程，也不会有异步效果。

所以可以这样理解：`run()` 定义的是任务内容，调用 `start()` 才是真正开启并发。如果只调用 `run()` 而不调用 `start()`，代码虽然照样执行，但全程都在当前线程内完成，完全没有并发效果，这是初学者最常见的错误。另一个区别是 `start()` 只能调用一次，重复调用会抛出 `IllegalThreadStateException`，因为线程状态已经不是 NEW；而 `run()` 可以被任意次调用，每次都只是当前线程的一次普通方法调用。此外 `start()` 是 final 方法不能重写，`run()` 则是设计出来给子类重写的。

:::tip
一句话总结：`start()` 是异步的，`run()` 是同步的；`run()` 是任务，`start()` 是开关。
:::
