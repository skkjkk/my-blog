---
title: String、StringBuffer 和 StringBuilder 的区别是什么？
published: 2026-10-22
description: "这三个类最根本的区别在于可不可变以及线程安全性。 String 是不可变类，它的字符数据一旦创建就不能修改，任何所谓的\"修改\"操作，本质上都是返回了一个新…"
tags: [基础, 面试]
category: Java
draft: false
---
这三个类最根本的区别在于**可不可变**以及**线程安全性**。

String 是不可变类，它的字符数据一旦创建就不能修改，任何所谓的"修改"操作，本质上都是返回了一个新的 String 对象并把引用重新指向它。好处是天然线程安全、可以安全地作为共享常量，还能被 intern 池复用；代价是频繁拼接会产生大量临时对象，给 GC 带来压力。StringBuilder 是可变类，拼接和修改都直接在自身的字符数组上完成，不产生中间对象，因此效率远高于 String，但它是**非线程安全**的，多线程并发修改会破坏内部状态。StringBuilder 和 StringBuffer 都继承自同一个抽象父类，实现思路基本一致，区别只在 StringBuffer 的关键方法上加了 synchronized 锁，做到了线程安全，代价是每次操作都要加解锁，性能低于 StringBuilder。

实际选型上：常量、少量拼接、作为 Map 的键或者需要跨线程共享的场景，用 String；单线程环境下的高频字符串拼接，用 StringBuilder；确实存在多线程共享且需要频繁修改的场景，才用 StringBuffer，但这种场景更好的做法通常是自己加锁并使用 StringBuilder，避免不必要的锁开销。

还有一个常被问到的点：String 用 `+` 拼接时，编译期能确定的常量会被编译器直接折叠成常量；而运行期拼接，javac 会自动优化成 StringBuilder 的 append 调用。但在循环里反复用 `+` 拼接时，每次迭代都会新建一个 StringBuilder，依然很慢，此时应该显式地自己声明一个 StringBuilder 复用。
