---
title: Java Object 类中有什么方法，有什么作用？
published: 2026-10-23
description: "Object 是所有类的根父类，它的方法按用途分为表示与类型、相等与哈希、生命周期与线程协作三类，核心是 equals 与 hashCode 的契约。"
tags: [基础, 面试]
category: Java
section: note
draft: false
---
`Object` 是 Java 所有类的根父类，任何类没有显式继承时都直接继承它，所以它的方法所有对象都能用。按用途分三类：**表示与类型**（`toString`、`getClass`）、**相等与哈希**（`equals`、`hashCode`）、**生命周期与线程协作**（`clone`、`finalize`、`wait`/`notify`）。面试考的是契约：`equals` 与 `hashCode` 成对重写，`wait` 释放锁且必须在同步块里，`finalize` 已废弃。

## 方法全清单：三类各管什么

`Object` 一共给了 9 个可以被子类使用的方法（`wait` 另有 `wait(long)`、`wait(long, int)` 两个重载），三类分别回答三个问题：**怎么描述自己、怎么算相等、对象怎么被复制/清理/等待**。先记住这张地图，再逐个看契约。

| 归类 | 方法 | 作用 |
| --- | --- | --- |
| 表示与类型 | `toString()` | 返回对象的字符串表示，`println` 打的就是它 |
| 表示与类型 | `getClass()` | 返回运行时 `Class` 对象，是反射入口，final 不可重写 |
| 相等与哈希 | `equals(Object)` | 判断逻辑相等，默认实现是引用相等 |
| 相等与哈希 | `hashCode()` | 返回哈希值，散列表靠它定位桶 |
| 生命周期与线程协作 | `clone()` | 复制对象，默认浅拷贝，抛 `CloneNotSupportedException` |
| 生命周期与线程协作 | `finalize()` | 回收前的清理钩子，已废弃 |
| 生命周期与线程协作 | `wait()` / `wait(long)` | 释放锁并进入等待集，直到被唤醒或超时 |
| 生命周期与线程协作 | `notify()` / `notifyAll()` | 唤醒等待集中一个 / 全部线程 |

## `toString()`：给人看的字符串表示

默认实现是「全限定类名 + `@` + 哈希码的十六进制」，形如 `com.example.User@1b6d3586`，对排查问题几乎没有信息量。**强烈建议重写**：日志、异常信息、调试输出都靠它，`System.out.println(obj)` 和字符串拼接实际调用的都是 `toString()`。重写时输出能定位问题的关键字段即可，但**不要把密码、身份证号、token 打进日志**，这是最常见的信息泄露来源。

## `equals()` 与 `hashCode()`：必须成对重写

`equals` 的默认实现就是 `==`，即**引用相等**，两个内容完全相同的对象也会判为不等，所以值对象（订单、金额、坐标）必须重写。`hashCode` 的契约是**相等的对象必须有相同的哈希值，哈希值相同的对象不一定相等**。两者必须成对重写，否则放进 `HashMap`/`HashSet` 会出现三类故障：**逻辑上相等的对象被当成两个不同的键**、**`containsKey` 查不到自己刚放进去的对象**、**`remove` 删不掉**。原因是散列表先用 `hashCode` 定位桶、再用 `equals` 在桶内比较，两个结论不一致就会找错桶或漏判。

## `getClass()`：运行时类型，final 不能重写

它返回对象**运行时类型**的 `Class` 对象，等同于 `user.getClass() == User.class` 这种精确判断。它是 `final` 的，任何类都不能重写，所以是类型判断最可靠的依据：`instanceof` 会把子类也算进来，`getClass()` 不会。反射能力的入口也在它上面，`getName()`、`getSimpleName()`、`getClassLoader()`、`getDeclaredFields()` 都是在 `getClass()` 拿到的 `Class` 对象上继续调用的。

## `clone()`：默认浅拷贝，且是 protected

`clone()` 默认是**浅拷贝**：基本类型字段复制值，引用类型字段只复制引用，副本和原对象共享同一个内部对象，改一个另一个也跟着变。它还是 `protected` 的，别的包无法直接调 `other.clone()`；要能用，必须实现 `Cloneable` 接口并重写为 `public`，否则抛 `CloneNotSupportedException`。**需要深拷贝时优先用拷贝构造器或序列化，而不是重写 `clone`**。

## `finalize()`：已废弃，别拿它放关键资源

它曾是对象被回收前的最后一次清理机会。问题在于**执行时机不确定、可能永远不执行，还会拖慢 GC 并带来对象复活等麻烦**，所以在 **Java 9 被标记废弃、Java 18 起被标记为待移除**，新代码不该再用。要确定性释放资源，就实现 `AutoCloseable` 并用 **try-with-resources** 保证关闭。

## `wait` / `notify` / `notifyAll`：线程协作，必须在同步块里

这三个方法是**线程协作**的原语，都必须在**持有该对象监视器锁**（`synchronized` 块或方法）时调用，否则抛 `IllegalMonitorStateException`。`wait()` 做两件事：**释放当前持有的对象锁**，然后把线程挂到该对象的等待集上；被 `notify`/`notifyAll` 唤醒、超时或被中断后，还要**重新抢回锁**才能从 `wait` 返回。`notify()` 唤醒等待集里的一个线程（哪一个不确定），`notifyAll()` 唤醒全部，通常更安全，避免唤醒错线程导致信号丢失。

`wait(long timeout)` 是带超时的版本，超时后自动醒来，**但它返回 `void`，不能用返回值区分「被唤醒」还是「超时」**——工程做法是记录调用前后的时间自行判断，并且**永远在 `while` 循环里判断条件**，因为 `wait` 存在虚假唤醒（spurious wakeup）。

## 重写示例

下面三个方法用的是同一组字段 `x`、`y`，这是最容易出错的地方：**`equals` 用了哪些字段，`hashCode` 就必须用哪些**，少一个多一个都会破坏契约；类型判断用 `getClass()` 保证对称性，引用类型字段比较用 `Objects.equals` 避免空指针。

```java
import java.util.Objects;

public final class Point {
    private final int x;
    private final int y;

    public Point(int x, int y) {
        this.x = x;
        this.y = y;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;                                // 引用相同直接相等
        if (o == null || getClass() != o.getClass()) return false;  // 类型必须严格一致
        Point other = (Point) o;
        return x == other.x && y == other.y;
    }

    @Override
    public int hashCode() {
        return Objects.hash(x, y);                                 // 字段与 equals 保持一致
    }

    @Override
    public String toString() {
        return "Point{x=" + x + ", y=" + y + "}";                  // 只放可公开的诊断字段
    }
}
```

## 常见追问

- **Q：只重写 `equals` 不重写 `hashCode` 会怎样？** A：对象进 `HashSet` 可能出现两个「相等」的元素，`HashMap` 里 `get` 拿不到自己 `put` 进去的值，因为两者落到了不同的桶。
- **Q：`==` 和 `equals` 有什么区别？** A：`==` 比较基本类型的值或引用地址，`equals` 默认也是比较引用地址，只有重写后才变成按内容比较。
- **Q：为什么 `wait` 必须在 `synchronized` 里，`sleep` 却不用？** A：`wait` 操作的是对象等待集，必须先把该对象的锁交出去并原子地进入等待；`sleep` 只是让当前线程暂停，不涉及对象的锁。
- **Q：`finalize` 不能用了，替代方案是什么？** A：实现 `AutoCloseable` 配 try-with-resources 是最稳的做法；需要回收后回调可以用虚引用加 `ReferenceQueue`。

## 易错点

- **错**：`wait()` 不释放锁。**对**：`wait()` 会释放对象锁并进入等待集，不释放锁的是 `Thread.sleep()`。
- **错**：`equals` 里字段直接用 `==` 比。**对**：引用类型字段要用 `Objects.equals`，否则字段为 `null` 时直接空指针。
- **错**：`clone()` 就是复制出一份互不影响的新对象。**对**：默认浅拷贝，引用类型字段仍与原对象共享。
- **错**：`getClass()` 可以重写来改类型判断。**对**：它是 `final` 方法，改不了；`instanceof` 认子类，`getClass()` 不认。

## 一句话记住

:::tip
`equals`/`hashCode` 成对重写，`wait` 释放锁且在同步块里，`finalize` 已废弃。
:::
