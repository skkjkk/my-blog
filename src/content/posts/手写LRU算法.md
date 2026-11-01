---
title: 手写 LRU 算法（最近最少使用）？
published: 2026-10-29
description: "LRU 用 HashMap 加双向链表做到 O(1) 的 get/put：链表头是最近使用、尾部是最久未使用，满载时淘汰尾部节点"
tags: [面试]
category: 算法与数据结构
section: note
draft: false
---

LRU（Least Recently Used，最近最少使用）是一种**缓存淘汰策略**：当缓存满了需要腾出空间时，淘汰**最久未被使用**的那一项；判断"最近"的标准是**访问时刻**，读和写都算使用。手写实现的标准答案是 **HashMap + 双向链表**——HashMap 负责 O(1) 定位节点，双向链表维护访问顺序，链表头是 MRU、尾部是 LRU，所以 get/put/remove **全部 O(1)**。

## 核心思路：HashMap + 双向链表

**HashMap** 提供 O(1) 的键到节点定位；**双向链表**维护访问顺序 —— **链表头部是最近使用的（MRU），尾部是最久未使用的（LRU）**。两者配合的关键是：map 里存的不是 value，而是**节点引用**，所以命中后不需要遍历链表就能把节点就地摘出来、再插到头部。

:::tip
**为什么必须是双向链表**：删除节点时需要知道它的前驱。单向链表删除是 O(n)，双向链表配合"节点自己持有前驱/后继引用"可做到 O(1)。
:::

## 四个核心操作

- **get(key)**：命中则**移到链表头部**（标记为最近使用），返回 value；未命中返回 null 或抛异常
- **put(key, value)**：已存在则**更新 value 并移到头部**；不存在则**新建节点插入头部**，若超容量则**移除尾部节点并从 map 中删除对应键**
- **remove(key)**：从链表摘除 + 从 map 删除
- **size / capacity**：维护当前容量与上限

## Node 节点要自己持有前驱/后继

```java
class Node {
    int key, value;
    Node prev, next;
    Node(int k, int v) { key = k; value = v; }
}

```

:::tip
**关键设计决策：把 prev/next 放在 Node 里而不是放在 LRU 类里** —— 这样删除任意节点时能 O(1) 摘链，且代码更简洁。**这是 LinkedHashMap 之外手写 LRU 的标准写法。**
:::

## 手写实现的核心代码结构

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
配套的 `addToHead` / `remove` / `moveToHead` 三个私有方法，分别做**头插、摘链、摘链后重新头插**：`moveToHead` 就是先 `remove` 再 `addToHead`；`remove` 只改 `prev.next` 和 `next.prev` 两个指针；`addToHead` 把新节点插到 `head` 与 `head.next` 之间。注意淘汰发生在 **`put` 的最后一步**，取 `tail.prev` 就是要删的 LRU 节点，而且必须**按 `node.key` 从 map 里删**——所以 Node 里非存 key 不可，只存 value 就不知道该删哪个键。

## 必须用哨兵节点（dummy head/tail）

用两个哨兵节点把真实节点"夹"在中间，好处是：
- **插入和删除不需要判断头尾是否为 null** —— 代码里没有 `if (head == null)` 这类分支
- **删除尾部 LRU 节点不需要特判** —— `tail.prev` 一定存在
- **大幅减少空指针风险**，是链表题的通用技巧。

## 复杂度

**所有操作均为 O(1)** —— get/put/remove 里的查表是 O(1)，链表摘插是 O(1)。

:::tip
**与 `LinkedHashMap` 的对比**：`LinkedHashMap` 的 `accessOrder=true` 就能实现 LRU，**但它的 `removeEldestEntry` 回调是在 `put` 之后触发的**，且**它不支持"get 命中后更新顺序"之外的一些定制**。**面试手写 LRU 的目的正是考察手写双向链表**，所以必须自己写。
:::

## 并发版本：LinkedHashMap 的 `afterNodeAccess`

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
**注意 `super(capacity, 0.75f, true)` 的第三个参数 `true` 才是关键** —— 它表示按访问顺序排序。`accessOrder = true` 时，`get` 命中会让节点走一次 `afterNodeAccess`，把该节点挪到链表尾部（最近使用的位置），LRU 的"顺序"就来自这里；`removeEldestEntry` 则在 `put` / `putAll` 完成后回调，返回 `true` 就删掉 eldest，而 `accessOrder = true` 时 eldest 恰好就是最久未访问的那个。所以 LRU 语义是**这两个钩子配合**出来的，方法名里的 `afterNodeAccess` 指的是前一半。另外类名里的 `Concurrent` 只是示意，它**并不线程安全**。

## 生产上的两个坑

- **`LinkedHashMap` 不是线程安全的** —— 并发场景需用 `Collections.synchronizedMap` 包装，或直接用 Caffeine / Guava Cache / Redis 的实现
- **`LinkedHashMap` 的 LRU 是"近似 LRU"** —— 它的链表顺序在**并发下会错乱**，且 `removeEldestEntry` 的判断时机有限制。**严格 LRU 语义与高并发，建议直接用 Caffeine**（W-TinyLFU，命中率显著优于 LRU）。

## LRU 的缺点与替代算法

- **缺点一：突发访问污染** —— 一次批量扫描把热点数据全挤出去（**scan resistance** 差）
- **缺点二：对访问频率不敏感** —— 一次访问与访问 100 次，在 LRU 里地位相同
- **替代方案**：**LFU**（按频率淘汰，**抗突发但对新数据不友好、有"缓存污染"历史包袱**）｜**W-TinyLFU**（Caffeine 默认，**结合 LRU 的分段 + LFU 的频率计数**，用 Count-Min Sketch 统计频率，**命中率远高于纯 LRU**）｜**ARC**（自适应，兼顾近期与常用）。

## 面试加分点：为什么 LRU 适合缓存

- **符合直觉**：被频繁访问的数据更可能再次被访问（**时间局部性原理**）
- **实现代价低**：O(1) 的 get/put，可用数组+HashMap 实现
- **对比 LRU 的替代 —— 最优替换（OPT/MIN）**：需要预知未来访问序列，**理论命中率最高但无法实现**，LRU 是"可实现的近似最优"。**这句能明显加分。**

## 易错点

- **"get 是只读操作，不该动链表"** —— 错。LRU 里读也算使用，`get` 命中**必须**把节点移到头部，否则链表顺序退化成插入顺序，整个缓存变成 FIFO。
- **"Node 只存 value 就够了"** —— 错。淘汰时要从 map 里删键，`map.remove` 需要 key，所以 **Node 必须带 key**；这也是很多人写完代码发现淘汰不掉旧键的原因。
- **"`LinkedHashMap` 开了 `accessOrder` 就是线程安全的"** —— 错。它底层还是无锁的哈希表结构，并发读写下链表顺序会错乱，要外部同步或换 Caffeine。
- **"单向链表省一个指针，能用就用"** —— 错。摘链要知道前驱，单向链表删除是 O(n)，双向链表加节点自持 prev/next 才能把 get/put 压到 O(1)，这是本题的前提。

## 常见追问

**问：手写 LRU，数据结构该怎么选，为什么这么选？**
**答：** HashMap + 双向链表：map 存 key 到 Node 的引用做 O(1) 定位，双向链表维护访问顺序，头 MRU、尾 LRU；必须双向，因为删除节点要知道前驱，单向链表摘链是 O(n)。

**问：put 的过程讲一遍，淘汰发生在哪一步？**
**答：** key 已存在就更新 value 并移到头部；不存在就新建节点头插、写进 map，再判断 `map.size() > capacity`，超了就把 `tail.prev`（真正的 LRU）从链表摘掉并按 `node.key` 从 map 删除。哨兵节点让头尾都不用特判。

**问：为什么不用 `LinkedHashMap` 直接交差？**
**答：** `LinkedHashMap(initialCapacity, 0.75f, true)` 加重写 `removeEldestEntry` 确实能实现 LRU（第三个参数 `true` 才是关键），但它不是线程安全的，回调时机也固定在 put 之后，定制空间小；面试手写这题考的就是双向链表本身。

**问：LRU 有什么毛病，为什么生产上更常上 Caffeine？**
**答：** LRU 抗不住突发扫描（scan resistance 差），也对访问频率不敏感——访问 1 次和 100 次地位相同。所以换成 LFU、W-TinyLFU（Caffeine 默认，分段 LRU 加频率计数，用 Count-Min Sketch 统计）、ARC；再补一句"OPT 理论最优但不可实现，LRU 是可实现的近似"，这是区分度最高的一句。

## 一句话记住

:::tip
LRU = HashMap 定位 + 双向链表排队，头是刚用过的，尾是先淘汰的。
:::
