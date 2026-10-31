---
title: ArrayList 和 LinkedList 的区别是什么？
published: 2026-10-22
description: ArrayList 和 LinkedList 都实现了 List 接口，区别主要体现在底层数据结构上
tags: [集合, 面试]
category: Java
section: note
draft: false
---
## 底层数据结构：动态数组 vs 双向链表

`ArrayList` 和 `LinkedList` 都实现了 `List` 接口，区别主要体现在底层数据结构上。`ArrayList` 底层是**动态数组**，元素在内存中连续存放；`LinkedList` 底层是**双向链表**，每个节点保存元素本身以及前后两个节点的引用。

## 核心差异：随机访问与增删的代价

由此带来的核心差异是**随机访问和增删的代价不同**。

| 操作场景 | ArrayList | LinkedList |
|---------|-----------|------------|
| 按下标查询第 n 个元素 | O(1)，直接定位 | O(n)，必须从头或尾沿链表遍历 |
| 头部插入和删除 | O(n)，需要把后面所有元素的引用整体后移 | O(1)，只需要修改相邻节点的指针 |
| 尾部追加元素 | 均摊 O(1)，偶尔扩容 | 均摊 O(1)，新增节点，但每个节点要多存两个指针并有额外内存开销 |

## 工程选型建议

绝大多数场景都应该用 `ArrayList`，因为它的缓存局部性好、内存占用小、CPU 缓存命中率高。只有在确实存在大量中间位置插入删除、并且几乎不需要按下标随机访问的场景下，`LinkedList` 才有优势。

:::tip[面试加分点]
面试里说"LinkedList 插入删除更快"是不完整的，准确说法是**在头尾或已知节点位置插入删除时 LinkedList 更快，而 ArrayList 的随机访问能力是 LinkedList 无法替代的**。
:::

需要补充的是，`LinkedList` 已经不是一个好的选择了，官方文档明确建议优先使用 `ArrayList` 和 `Deque` 接口实现。

## 面试怎么答

1. 先点明两者都实现了 `List` 接口，但底层数据结构不同：`ArrayList` 是动态数组，`LinkedList` 是双向链表。
2. 对比随机访问：`ArrayList` 按下标定位是 O(1)，`LinkedList` 需要遍历是 O(n)。
3. 对比头部插入删除：`ArrayList` 需要整体后移是 O(n)，`LinkedList` 只改指针是 O(1)。
4. 补充尾部追加：两者都是均摊 O(1)，但 `LinkedList` 有额外内存开销。
5. 给出选型结论：绝大多数场景用 `ArrayList`，并指出官方文档已建议优先使用 `ArrayList` 和 `Deque` 接口实现。
