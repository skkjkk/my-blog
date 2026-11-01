---
title: HashMap 和 Hashtable 的区别是什么？
published: 2026-10-22
description: HashMap 不保证线程安全但允许 null、默认容量 16；Hashtable 方法级同步、禁止 null、默认容量 11，并发场景应改用 ConcurrentHashMap。
tags: [集合, 面试]
category: Java
section: note
draft: false
---

HashMap 和 Hashtable 最主要的区别是**线程安全性**和**对 null 的支持**：HashMap 不加锁，允许一个 null key 和任意多个 null value，性能好；Hashtable 是 JDK 1.0 就存在的遗留类，方法整体加了 synchronized，所以线程安全，但完全不允许 null，开销也明显更大。需要并发安全时，正确做法是使用 ConcurrentHashMap，而不是 Hashtable。

## 线程安全：锁的粒度决定了代价

Hashtable 的 put、get、remove 等方法都用 `synchronized` 修饰，锁的是整个 Hashtable 实例，同一时刻只允许一个线程读写这张表，所以它连两个线程读不同的 key 都要排队，单线程下也比 HashMap 慢。HashMap 完全不加锁，多线程并发写可能丢更新、size 计数不准，并发扩容或修改时结构会错乱；JDK 7 及以前的扩容用头插法，并发扩容还可能把链表连成环，导致 get 死循环，JDK 8 改成尾插后不再成环，但数据错误依然存在。所以 HashMap 要线程安全，只能由调用方在外部加锁，或者换成 ConcurrentHashMap —— 后者锁的粒度是单个桶，读操作基本无锁，是 Hashtable 的现代替代品。

## null 的处理：hash 取 0 还是直接抛异常

Hashtable 的 put 第一步就检查 value 是否为 null 并抛出 NullPointerException，key 为 null 时则会在取 hashCode 时抛 NPE，所以它一个 null 都不收。HashMap 在计算哈希时对 null key 直接返回 0，于是 null key 固定落在第 0 个桶（下标是 `(n-1) & 0`，结果恒为 0），读取时用同样的方式去找，所以 null 可以当一个合法的键用，而且只能有一个，重复 put 会覆盖 value。ConcurrentHashMap 同样禁止 null，常见解释是并发下 get 返回 null 无法区分「key 不存在」和「value 就是 null」，再补一次 containsKey 又会引入竞态。

```java
Map<String, String> hashMap = new HashMap<>();
hashMap.put(null, "a");   // 允许：null key 落到第 0 个桶
hashMap.put("k", null);   // 允许：value 也可以为 null

Map<String, String> table = new Hashtable<>();
table.put("k", null);     // 抛 NullPointerException
table.put(null, "a");     // 同样抛 NullPointerException
```

## 底层结构与扩容：只有 HashMap 会树化

两者都是「数组 + 链表」的桶结构，差别在冲突处理深度和扩容规则。HashMap 在链表长度达到 8 且数组容量不小于 64 时把链表转成红黑树，最坏查询从 O(n) 降到 O(log n)，节点减少后再退化回链表；Hashtable 至今没有树化逻辑，冲突的桶始终是一条 Entry 链表。扩容上，HashMap 默认容量 16、负载因子 0.75，容量永远是 2 的幂，元素数超过阈值就把容量翻倍，取下标时用 `(n-1) & hash` 代替取模；Hashtable 默认容量 11、负载因子同样是 0.75，扩容规则是新容量 = 旧容量 × 2 + 1，所以它一直是奇数容量，索引用 `(hash & 0x7FFFFFFF) % length` 取模。

这几组数字可以直接背：

- 默认容量：HashMap 是 16，Hashtable 是 11
- 负载因子：两者都是 0.75
- 扩容规则：HashMap 容量翻倍（保持 2 的幂），Hashtable 是 2n + 1（保持奇数）
- 冲突处理：HashMap 链表长度 ≥8 且容量 ≥64 时转红黑树，Hashtable 只有链表

## 继承关系与遍历方式

Hashtable 继承 JDK 1.0 就存在的 Dictionary 抽象类，这个类早已标记为过时（obsolete），新代码不该再继承它；HashMap 继承 AbstractMap，两者都实现了 Map 接口。遍历上，HashMap 只提供 Iterator（来自 entrySet、keySet、values），迭代过程是 fail-fast 的；Hashtable 除了 Iterator，还保留了 JDK 1.0 时代的 Enumeration（keys() 和 elements()），这个老接口连 remove 都没有。这也是判断一段代码「是不是老代码」的一个小信号：见到 Enumeration 遍历 Map，基本就是 Hashtable 时代的写法。

## 对比速查表

| 维度 | HashMap | Hashtable |
| --- | --- | --- |
| 线程安全 | 否，需外部同步 | 是，方法级 synchronized 锁整个实例 |
| null 支持 | key 最多一个 null，value 可 null | key 和 value 都不允许，抛 NPE |
| 默认容量 / 负载因子 | 16 / 0.75 | 11 / 0.75 |
| 扩容规则 | 容量翻倍，保持 2 的幂 | 2n + 1，保持奇数 |
| 冲突处理 | 链表，≥8 且容量 ≥64 时转红黑树 | 只有链表，不树化 |
| 下标计算 | `(n-1) & hash` | `(hash & 0x7FFFFFFF) % length` |
| 父类 | AbstractMap | Dictionary（已过时） |
| 遍历方式 | Iterator | Iterator 与 Enumeration |
| 推荐替代 | ConcurrentHashMap（并发场景） | ConcurrentHashMap 或 synchronizedMap |

## 常见追问

**Q：既然 Hashtable 线程安全，为什么还说它不好用？**
A：它的 synchronized 加在方法上，锁的是整张表，两个线程读不同的 key 也要互斥，本质是「不会出错但没法扩展」。ConcurrentHashMap 只锁单个桶、读基本无锁，并发吞吐明显更好，所以线程安全不等于适合并发。

**Q：HashMap 为什么允许 null key？**
A：它在算哈希时对 null 直接返回 0，不需要额外的分支判断，null key 就固定在第 0 个桶里，读和写走同一条路径，代价是只能有一个 null key。

**Q：多线程同时 put HashMap 会发生什么？**
A：可能丢更新、size 不准、扩容时链表结构错乱；JDK 7 及以前还可能因为头插法扩容形成环形链表，让后续 get 变成死循环。这不代表 JDK 8 的 HashMap 变安全了，它依然没有任何同步。

**Q：ConcurrentHashMap 和 Collections.synchronizedMap 怎么选？**
A：synchronizedMap 只是给所有方法套同一把锁，等于一个包装过的 Hashtable，只适合并发极低的场景；真正有并发读写压力就用 ConcurrentHashMap。

## 易错点

- 错：「Hashtable 在 JDK 1.8 之后也引入了红黑树，只是条件更严格。」对：Hashtable 从 1.0 到现在都是数组加链表，没有树化逻辑，红黑树优化只发生在 HashMap 和 ConcurrentHashMap 上。
- 错：「HashMap 允许 null，那 ConcurrentHashMap 应该也允许。」对：ConcurrentHashMap 明确禁止 null key 和 null value，否则 get 返回 null 时无法区分「没这个 key」和「值就是 null」。
- 错：「Hashtable 线程安全，并发场景用它就对了。」对：它是方法级全表锁，只是保证不出错，并发吞吐远不如 ConcurrentHashMap，新代码不该主动选它。
- 错：「HashMap 和 Hashtable 的默认容量都是 16。」对：HashMap 是 16，Hashtable 是 11，扩容也分别是翻倍和 2n + 1。

## 一句话记住

:::tip
HashMap 快、能放 null；要并发就上 ConcurrentHashMap。
:::
