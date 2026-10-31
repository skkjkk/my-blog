---
title: HashCode 的作用是什么？
published: 2026-10-22
description: HashCode 的核心作用是为对象生成一个哈希值，让基于哈希结构的数据结构能够在 O(1) 时间内定位元素
tags: [集合, 面试]
category: Java
section: note
draft: false
---
HashCode 的核心作用是为对象生成一个哈希值，让基于哈希结构的数据结构能够在 O(1) 时间内定位元素。在 HashMap 当中，键的 hashCode 参与计算，决定了这个键最终落在哪个哈希桶里；配合桶内的链表或红黑树比较，从而把查找、插入、删除的平均复杂度维持在常数级别。HashSet 的底层就是 HashMap，所以同样依赖 hashCode。

HashCode 通常要和 equals 方法配合使用，它们共同遵守一个契约：equals 相等的两个对象，hashCode 必须相等；反过来 hashCode 相等的对象并不保证 equals 相等，因为哈希冲突是允许存在的，只是不应该大量出现。正因为这个契约，如果重写了 equals 方法，就必须同时重写 hashCode 方法，否则一个逻辑上"相等"的对象会被放进不同的桶里，导致 HashMap 出现重复键覆盖、containsKey 查不到、remove 删不掉这类诡异问题。

另外要注意 hashCode 要满足一致性：同一个对象在它的生命周期内，多次调用 hashCode 必须得到相同结果；如果对象的字段变了，那它的 hashCode 允许随之变化。

实现上，基本类型的 hashCode 就是它自身的值，而引用类型默认使用 Object 的 hashCode，它是与对象身份相关的身份哈希码，通常跟内存地址有关，所以在实际业务中，自定义对象放进 Map 时几乎都会重写 equals 和 hashCode。
