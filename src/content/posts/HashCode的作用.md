---
title: HashCode 的作用是什么？
published: 2026-10-22
description: hashCode 把对象映射成整数，决定哈希表里的桶位；重写 equals 就必须同时重写 hashCode，否则相等的对象会落进不同的桶。
tags: [集合, 面试]
category: Java
section: note
draft: false
---
hashCode 的作用是把对象映射成一个整数，让 HashMap、HashSet 这类基于哈希的数据结构能直接算出元素该落在哪个桶，从而把查找、插入、删除的平均复杂度维持在常数级。它只决定桶位，桶内是不是同一个键由 equals 判定，两个方法是一套契约的两半，必须成对重写。

## 它在哈希表里到底做了什么

存一个键值对时，HashMap 不会遍历所有元素去比较，而是先拿键的 hashCode 算出一个整数，再把这个整数映射到数组下标上，那一位就是一个桶。定位用的是 `hash & (容量 - 1)`，因为容量始终是 2 的幂，这一步等价于取模但快得多。JDK 8 的 HashMap 在取下标之前还会对 hashCode 做一次扰动，把高 16 位异或到低 16 位，让高位也参与定位，避免一批对象的 hashCode 只有低位不同而全挤在同一个桶里。

落到桶里之后，还要用 equals 逐个比较桶内的键，命中才算同一个键。所以 hashCode 负责把范围缩小到一个桶，equals 负责最终裁决。Set 也一样：HashSet 内部就是一个 HashMap，元素当键、值放一个固定的占位对象，因此它同样依赖 hashCode。

## 和 equals 的契约

两个方法共同维护一条不变式：equals 判定相等的对象，hashCode 必须返回相同的值。这条是硬性要求，一旦违反，整个哈希结构的正确性就没了。

- equals 相等，hashCode 必须相等。这是硬性要求，违反后哈希表定位不到那个键。
- hashCode 相等，equals 不一定相等。这叫哈希冲突，是允许存在的，只是不应该大量出现。
- equals 不相等，hashCode 可以相等也可以不等。相等只会让冲突变多、性能变差，不影响正确性。
- 一致性：只要参与 equals 比较的字段没变，同一个对象多次调用 hashCode 必须返回同一个整数。

## 为什么重写 equals 就必须顺手重写 hashCode

假设只重写 equals，让两个 id 相同的 User 互相 equals，但 hashCode 还是继承来的身份哈希。这时两个"逻辑上相等"的对象会算出不同的哈希、落进不同的桶：对同一个键 put 两次，表里会留下两个键值对，本该被覆盖的旧值还在；用一个新建的相等对象去 containsKey 会返回 false；remove 也删不掉旧的那一条。查不到、删不掉、还能存重复，这三个症状的根源是同一个——桶位由 hashCode 决定，而 equals 只在桶内生效。

## 一致性：算出来之后就不能再变

hashCode 的契约里还有一条常被忽略的稳定性要求：在对象的生命周期内，只要参与 equals 比较的字段没被修改，多次调用必须返回同一个整数。字段变了，hashCode 随之变化是允许的，但前提是这个对象没被当作键放进哈希结构。

反过来说，把一个可变对象当键放进 HashMap，之后又改了参与 hashCode 计算的字段，桶位就已经偏了：拿着这把"钥匙"去 get 会查不到，虽然条目还躺在表里。所以 Map 的键优先选不可变对象，String 和包装类型都是常见选择。

## 默认实现与常见类型的 hashCode

- Object.hashCode 是身份哈希码，与对象的身份绑定，具体取值由 JVM 实现决定，常与对象地址或分配过程有关；只要对象还活着，同一个对象多次调用结果不变，但不要依赖它的具体数值。
- 基本类型本身没有 hashCode，装箱之后 Integer、Short、Byte、Character 的 hashCode 就是它表示的那个值。
- Long 的 hashCode 是把高 32 位与低 32 位异或折叠，Double 和 Float 先转成位模式再折叠，Boolean 只有两个固定取值。
- String 重写了 hashCode，按字符序列计算，第一次算完就把结果缓存下来，所以反复取哈希不会重复计算。
- 数组没有重写 hashCode，用的是 Object 的身份哈希：两个内容完全相同的数组 hashCode 不同，要按内容算得用 `Arrays.hashCode`。

## 代码：一次把 equals 和 hashCode 写对

关键是把参与判等的字段固定成同一批，equals 用哪些字段比，hashCode 就用哪些字段算。`this == o` 是廉价的短路判断，`getClass() != o.getClass()` 保证类型对称，`Objects.equals` 负责 null 安全，`Objects.hash` 负责把多个字段折成一个整数。

```java
public final class User {
    private final String id;
    private final int age;

    public User(String id, int age) {
        this.id = id;
        this.age = age;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;                        // 同一引用直接相等
        if (o == null || getClass() != o.getClass()) return false;
        User other = (User) o;
        return age == other.age && Objects.equals(id, other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id, age);                      // 用参与 equals 的同一批字段
    }
}
```

只重写 equals、不重写 hashCode 会怎样：

```java
class Bad {
    @Override
    public boolean equals(Object o) {
        return o instanceof Bad;
    }
}

Map<Bad, String> map = new HashMap<>();
map.put(new Bad(), "第一次");
map.put(new Bad(), "第二次");
System.out.println(map.size());                     // 2，本该覆盖成 1
System.out.println(map.containsKey(new Bad()));     // false，明明存在相等的键
```

## 常见追问

Q：hashCode 相同是不是就说明两个对象相等？
A：不是。hashCode 相同只说明它们会落进同一个桶，桶里还要再用 equals 比一遍才算相等。哈希冲突必然存在，两个不相干的对象撞到同一个哈希值是正常现象。

Q：只重写 hashCode、不重写 equals 行不行？
A：不行。equals 没重写，两个逻辑相等的对象永远被判为不等，HashMap 会当成两个不同的键，覆盖和查找都会失效；再加上 hashCode 相同，它们只会挤在同一个桶里，冲突更严重。

Q：为什么 String 适合当 HashMap 的键？
A：String 不可变，hashCode 按内容计算并且会缓存，内容相同必然哈希相同；它也重写了 equals，判等同样按内容来，不会因为中途被改而破坏桶位。自定义类要当键，就得把这两条自己补上。

Q：哈希冲突多了会怎样？
A：同一个桶里的键多起来之后，查找就退化成在链表里逐个 equals 比较；JDK 8 的 HashMap 会在链表较长时转成红黑树兜底，但那只是止损手段，根本上还是要让 hashCode 分布得均匀。

## 易错点

- 用 hashCode 判断两个对象是否相等。哈希值不唯一，冲突天然存在，判等只能靠 equals。
- 重写 equals 却忘了重写 hashCode。这是最常见的破契约方式，表现就是"存进去查不到、删不掉、还能存两份"。
- 把可变对象当 key，之后又改参与 hashCode 计算的字段。桶位随哈希一起偏掉，旧条目再也定位不到，等价于泄漏。
- 拿数组当 key 却不看实现。数组用的是身份哈希，内容相同的两个数组哈希不同，要按内容算得换成 `Arrays.hashCode` 或者用 List 当键。

## 一句话记住

:::tip
hashCode 负责找桶，equals 负责判等；重写一个，就必须重写另一个。
:::
