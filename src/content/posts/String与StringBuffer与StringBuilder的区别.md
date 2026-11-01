---
title: String、StringBuffer 和 StringBuilder 的区别是什么？
published: 2026-10-22
description: "String 不可变所以线程安全，StringBuilder 单线程拼接最快，StringBuffer 方法加锁才线程安全。"
tags: [基础, 面试]
category: Java
section: note
draft: false
---
三者的核心区别只有两条：String 不可变，任何「修改」都会返回一个新对象；StringBuilder 和 StringBuffer 可变，直接在内部字符数组上追加内容，其中 StringBuffer 的关键方法加了 synchronized 所以线程安全，StringBuilder 不加锁、单线程下最快。选型上默认用 StringBuilder，需要常量、Map 的键或跨线程共享时才用 String，确实存在多线程共享写入才考虑 StringBuffer。

## String 的不可变体现在哪

String 是不可变类，字符数据一旦创建就不能修改，所有看起来像修改的方法都是返回一个新的 String 对象，再把变量指向它，原对象保持不变。好处有三个：对象天然线程安全，不用加锁就能被多线程共享；可以作为共享常量被复用，字符串常量池（intern 池）就是靠这一点工作的；放进 HashMap 当键以后，内容永远不变，不用担心键放进去又被改掉。代价是每次拼接都要新分配一个对象并复制原有内容，频繁拼接会制造大量短命对象，给 GC 带来压力。

内部实现上，字符串内容存在一个私有的字符数组里（早期 JDK 用 char[]，较新的版本为了省内存改成 byte[] 加编码标记），这个数组不对外暴露，String 也没有提供任何能改它的公开方法，所以内容不可能从外部被改掉。

## StringBuilder 和 StringBuffer 是同一个父类的两种实现

两者都继承自同一个抽象父类（AbstractStringBuilder），实现思路基本一致：内部维护一块可扩容的字符缓冲区，append 时直接往后写，返回自身引用以便链式调用，只有容量不够时才申请更大的数组并把旧内容复制过去。区别只在 StringBuffer 的公开方法上加了 synchronized，让单个方法调用互斥；StringBuilder 完全不处理并发，所以更快。

因此两者的性能差距来自锁的获取与释放开销：单线程下 StringBuilder 不用付出任何同步成本，拼接效率远高于 String；多线程下 StringBuffer 能保证单个方法不会让别的线程看到写了一半的内部数组，代价是每次操作都要加解锁。注意它保证的是「单个方法原子」，不是「一段复合逻辑原子」。

## 怎么选：一张对比表

| 维度 | String | StringBuilder | StringBuffer |
| --- | --- | --- | --- |
| 可变性 | 不可变 | 可变 | 可变 |
| 线程安全 | 安全（对象本身不可变） | 不安全 | 安全（方法加 synchronized） |
| 拼接开销 | 每次产生新对象 | 最低，只在扩容时复制 | 比 StringBuilder 多一次加解锁 |
| 典型场景 | 常量、Map 的键、跨线程共享 | 单线程循环拼接、拼 SQL 或 JSON | 多线程共享的缓冲区 |

落到日常写代码：

- 常量、少量拼接、作为 Map 的键、需要跨线程共享的值，用 String。
- 单线程环境下的高频拼接（尤其是循环里），用 StringBuilder。
- 确实存在多线程共享且需要频繁修改，才用 StringBuffer；这种场景更常见的做法是自己加一把锁配合 StringBuilder，把临界区控制得更小，避免每个方法都加锁。

## String 的 `+` 到底怎么编译

如果拼接的全是编译期就能确定的常量，javac 会直接算出结果，运行期不创建任何中间对象；只要拼接里带了变量，这条语句每次执行都会产生一个新的 String。早期 JDK 把这种运行期拼接编译成 new StringBuilder 加一串 append，较新的 JDK 改成 invokedynamic 加 StringConcatFactory 来生成拼接逻辑，但语义没变：结果仍然是一个新对象。

```java
String a = "he" + "llo";   // 编译期折叠成常量 "hello"，没有对象创建
String b = a + "!";        // 运行期拼接，产生一个新的 String

// 错误的写法：每轮迭代都新建拼接对象并复制已有内容
String s = "";
for (int i = 0; i < 1000; i++) {
    s += i;
}

// 正确的写法：StringBuilder 提到循环外复用
StringBuilder sb = new StringBuilder();
for (int i = 0; i < 1000; i++) {
    sb.append(i);
}
String result = sb.toString();
```

循环里用 `+` 拼接之所以慢，是因为循环把「新建对象 + 复制已有内容」这两个动作放大了成百上千次，字符串越长每次复制的成本越高。此时应该显式声明一个 StringBuilder 在循环外复用，循环结束后统一 toString。

## 常见追问

- **Q：String 不可变，为什么 `s += "a"` 还能改？**
  A：改的是变量 s 的引用，不是对象本身。原对象一个字都没变，只是 s 指向了新建的那个 String。
- **Q：多线程下用 StringBuffer 就一定安全吗？**
  A：只保证单方法原子。像「先判断长度再删除首字符」这种复合操作仍然会被其他线程插进来，还是要自己加锁或换同步策略。
- **Q：StringBuilder 默认容量多大，什么时候扩容？**
  A：默认 16 个字符；装不下时按「旧容量乘 2 再加 2」扩，并复制旧内容。数据量已知时可以在构造时指定容量，省掉中间的复制。
- **Q：循环里反复调用 `sb.toString()` 有问题吗？**
  A：有问题。toString 会新建一个 String 并复制当前内容，放在循环里等于又把对象创建的开销加了回来，应该循环结束后只调用一次。

## 易错点

- 把 StringBuffer 当成「更安全的默认选择」。它的锁是方法级的，开销和粒度都不划算；能自己控制临界区的场景里，用 StringBuilder 配一把锁更合适。
- 认为 String 拼接一定慢。编译期常量折叠后它就是个常量，连对象都不创建，慢的只是运行期、循环里的拼接。
- 认为循环里的 `+` 会被编译器优化成复用同一个 StringBuilder。不会，每轮迭代都会新建一个，这是最经典的性能坑。
- 把「StringBuffer 线程安全」理解成「内容读出来一定是最新的」。锁只覆盖单次方法调用，跨多次调用的读写组合仍需外部同步。

## 一句话记住

:::tip
拼接默认 StringBuilder，多线程共享才用 StringBuffer。
:::
