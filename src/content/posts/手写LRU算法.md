---
title: 手写 LRU 算法（最近最少使用）？
published: 2026-10-29
description: LRU（Least Recently Used）是淘汰策略：当缓存满了需要腾出空间时，淘汰最久未被使用的那一项
tags: [面试]
category: 算法与数据结构
draft: false
---
LRU（Least Recently Used）是**淘汰策略**：当缓存满了需要腾出空间时，淘汰**最久未被使用**的那一项。判断"最近"的标准是**访问时刻**（读和写都算使用）。

1) **核心思路：HashMap + 双向链表**。**HashMap** 提供 O(1) 的键到节点定位；**双向链表**维护访问顺序 —— **链表头部是最近使用的（MRU），尾部是最久未使用的（LRU）**。
> **为什么必须是双向链表**：删除节点时需要知道它的前驱。单向链表删除是 O(n)，双向链表配合"节点自己持有前驱/后继引用"可做到 O(1)。

2) **四个核心操作**
- **get(key)**：命中则**移到链表头部**（标记为最近使用），返回 value；未命中返回 null 或抛异常
- **put(key, value)**：已存在则**更新 value 并移到头部**；不存在则**新建节点插入头部**，若超容量则**移除尾部节点并从 map 中删除对应键**
- **remove(key)**：从链表摘除 + 从 map 删除
- **size / capacity**：维护当前容量与上限

3) **Node 节点要自己持有前驱/后继**
```java
class Node {
    int key, value;
    Node prev, next;
    Node(int k, int v) { key = k; value = v; }
}
```
> **关键设计决策：把 prev/next 放在 Node 里而不是放在 LRU 类里** —— 这样删除任意节点时能 O(1) 摘链，且代码更简洁。**这是 LinkedHashMap 之外手写 LRU 的标准写法。**

4) **手写实现的核心代码结构**
```java
class LRUCache {
    private final int capacity;
    private final Map<Integer, Node> map = new HashMap<>();
    private final Node head = new Node(0, 0);   // 哨兵头
    private final Node tail = new Node(0, 0);   // 哨兵尾

    LRUCache(int capacity) {
        this.capacity = capacity;
        head.next = tail;
        tail.prev = head;
    }

    public int get(int key) {
        Node node = map.get(key);
        if (node == null) return -1;
        moveToHead(node);
        return node.value;
    }

    public void put(int key, int value) {
        Node node = map.get(key);
        if (node != null) {
            node.value = value;
            moveToHead(node);
            return;
        }
        node = new Node(key, value);
        map.put(key, node);
        addToHead(node);
        if (map.size() > capacity) {
            Node last = tail.prev;      // 尾部即 LRU
            remove(last);
            map.remove(last.key);
        }
    }
}
```
配套的 `addToHead` / `remove` / `moveToHead` 三个私有方法，分别做**头插、摘链、摘链后重新头插**。

5) **必须用哨兵节点（dummy head/tail）** ⭐
用两个哨兵节点把真实节点"夹"在中间，好处是：
- **插入和删除不需要判断头尾是否为 null** —— 代码里没有 `if (head == null)` 这类分支
- **删除尾部 LRU 节点不需要特判** —— `tail.prev` 一定存在
- **大幅减少空指针风险**，是链表题的通用技巧。

6) **复杂度**：**所有操作均为 O(1)** —— get/put/remove 里的查表是 O(1)，链表摘插是 O(1)。
> **与 `LinkedHashMap` 的对比**：`LinkedHashMap` 的 `accessOrder=true` 就能实现 LRU，**但它的 `removeEldestEntry` 回调是在 `put` 之后触发的**，且**它不支持"get 命中后更新顺序"之外的一些定制**。**面试手写 LRU 的目的正是考察手写双向链表**，所以必须自己写。

7) **并发版本：LinkedHashMap 的 `afterNodeAccess`**
```java
class ConcurrentLRU<K, V> extends LinkedHashMap<K, V> {
    private final int capacity;
    ConcurrentLRU(int capacity) {
        super(capacity, 0.75f, true);   // accessOrder = true
        this.capacity = capacity;
    }
    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > capacity;
    }
}
```
**注意 `super(capacity, 0.75f, true)` 的第三个参数 `true` 才是关键** —— 它表示按访问顺序排序。

8) **⚠️ 生产上的两个坑**
- **`LinkedHashMap` 不是线程安全的** —— 并发场景需用 `Collections.synchronizedMap` 包装，或直接用 Caffeine / Guava Cache / Redis 的实现
- **`LinkedHashMap` 的 LRU 是"近似 LRU"** —— 它的链表顺序在**并发下会错乱**，且 `removeEldestEntry` 的判断时机有限制。**严格 LRU 语义与高并发，建议直接用 Caffeine**（W-TinyLFU，命中率显著优于 LRU）。

9) **LRU 的缺点与替代算法**
- **缺点一：突发访问污染** —— 一次批量扫描把热点数据全挤出去（**scan resistance** 差）
- **缺点二：对访问频率不敏感** —— 一次访问与访问 100 次，在 LRU 里地位相同
- **替代方案**：**LFU**（按频率淘汰，**抗突发但对新数据不友好、有"缓存污染"历史包袱**）｜**W-TinyLFU**（Caffeine 默认，**结合 LRU 的分段 + LFU 的频率计数**，用 Count-Min Sketch 统计频率，**命中率远高于纯 LRU**）｜**ARC**（自适应，兼顾近期与常用）。

10) **面试加分点：为什么 LRU 适合缓存**
- **符合直觉**：被频繁访问的数据更可能再次被访问（**时间局部性原理**）
- **实现代价低**：O(1) 的 get/put，可用数组+HashMap 实现
- **对比 LRU 的替代 —— 最优替换（OPT/MIN）**：需要预知未来访问序列，**理论命中率最高但无法实现**，LRU 是"可实现的近似最优"。**这句能明显加分。**

11) **面试答法建议**。四点：**① 数据结构选型（HashMap + 双向链表，链表头 MRU、尾 LRU，为什么必须双向）；② 手写代码（Node 自带 prev/next、哨兵节点、四个操作、复杂度 O(1)）；③ `LinkedHashMap` 的 `accessOrder=true` + `removeEldestEntry` 写法及其非线程安全问题；④ 进阶（LRU 的 scan resistance 缺点 → LFU/W-TinyLFU/Caffeine；以及"OPT 理论最优但不可实现，LRU 是可实现的近似"）。** 第四点是区分度最高的。
