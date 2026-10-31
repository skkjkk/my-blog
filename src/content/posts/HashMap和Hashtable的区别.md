---
title: HashMap 和 Hashtable 的区别是什么？
published: 2026-10-22
description: HashMap 和 Hashtable 最主要的区别是线程安全性和对 null 的支持
tags: [集合, 面试]
category: Java
section: note
draft: false
---
HashMap 和 Hashtable 最主要的区别是**线程安全性**和**对 null 的支持**。

Hashtable 是遗留的老类，所有方法都用 synchronized 修饰，是**线程安全**的；HashMap 则是**非线程安全**的，并发读写会出问题。而且 Hashtable 作为老式容器，方法基本都加了同步锁，性能开销明显大于 HashMap，并且在 JDK 1.8 之后 Hashtable 也跟着引入了红黑树来优化链表，但同步带来的问题并没有改变。需要并发安全时，正确做法是使用 ConcurrentHashMap，而不是 Hashtable。

其次是**null 的支持**。HashMap 允许 key 和 value 都为 null，因为它的 get 方法里对 key 为 null 做了特殊处理，会去查哈希表第零个桶；而 Hashtable 不允许 key 或 value 为 null，一旦传入会直接抛出空指针异常。这也是为什么 HashMap 可以把 null 当成一个合法的键来存放。

第三是**底层结构与扩容策略**。两者都是数组加链表的结构，但 HashMap 在链表长度超过阈值且数组容量足够时会把链表转成红黑树，Hashtable 虽然在新版本中也引入了红黑树，但树化条件更严格。扩容方面，HashMap 默认容量是 16、负载因子 0.75，扩容为原来的两倍；Hashtable 默认容量是 11、负载因子同样是 0.75，但扩容是原容量的两倍加一。

最后是**继承关系与遍历方式**。Hashtable 继承的是已经废弃的 Dictionary 类，HashMap 继承 AbstractMap，两者都实现了 Map 接口。遍历时 HashMap 使用 Iterator 迭代器，Hashtable 除了迭代器还保留了旧的 Enumeration 方式。

:::tip
一句话总结：Hashtable 是线程安全但性能差、不允许 null 的遗留方案，HashMap 是性能好、允许 null 但需要外部保证线程安全的方案，并发场景请用 ConcurrentHashMap。
:::
