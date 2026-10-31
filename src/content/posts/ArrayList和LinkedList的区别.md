---
title: ArrayList 和 LinkedList 的区别是什么？
published: 2026-10-22
description: ArrayList 和 LinkedList 都实现了 List 接口，区别主要体现在底层数据结构上
tags: [集合, 面试]
category: Java
draft: false
---
ArrayList 和 LinkedList 都实现了 List 接口，区别主要体现在底层数据结构上。ArrayList 底层是**动态数组**，元素在内存中连续存放；LinkedList 底层是**双向链表**，每个节点保存元素本身以及前后两个节点的引用。

由此带来的核心差异是**随机访问和增删的代价不同**。ArrayList 支持按下标直接定位元素，查询第 n 个元素是 O(1) 级别；LinkedList 必须从头或尾沿链表遍历，查询是 O(n)。反过来在**头部插入和删除**的场景下，ArrayList 需要把后面所有元素的引用整体后移，是 O(n)；LinkedList 只需要修改相邻节点的指针，是 O(1)。

在**尾部追加**元素时两者差别不大，ArrayList 只需要偶尔扩容，LinkedList 只需要新增节点，都是均摊 O(1)，但 LinkedList 每个节点要多存两个指针并且有额外内存开销。

工程选型上，绝大多数场景都应该用 ArrayList，因为它的缓存局部性好、内存占用小、CPU 缓存命中率高。只有在确实存在大量中间位置插入删除、并且几乎不需要按下标随机访问的场景下，LinkedList 才有优势。所以面试里说"LinkedList 插入删除更快"是不完整的，准确说法是**在头尾或已知节点位置插入删除时 LinkedList 更快，而 ArrayList 的随机访问能力是 LinkedList 无法替代的**。

需要补充的是，LinkedList 已经不是一个好的选择了，官方文档明确建议优先使用 ArrayList 和 Deque 接口实现。
