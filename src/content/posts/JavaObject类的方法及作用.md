---
title: Java Object 类中有什么方法，有什么作用？
published: 2026-10-23
description: Object 是所有类的父类，它提供的方法分为三类：通用方法、对象相等与哈希、以及类型与状态相关的方法
tags: [基础, 面试]
category: Java
section: note
draft: false
---
`Object` 是所有类的父类，它提供的方法分为三类：通用方法、对象相等与哈希、以及类型与状态相关的方法。

## `toString()`

。返回对象的字符串表示，默认实现是"类名@哈希码的十六进制"，可读性差。**强烈建议重写**，用于日志打印、异常信息、调试输出。`System.out.println(obj)` 实际调用的就是它。

## `equals(Object)`

。判断两个对象"是否相等"，默认实现是**引用相等**（即 `==`）。重写 `equals` 时**必须同时重写 `hashCode`**，否则对象放进 `HashMap`/`HashSet` 会出现重复键覆盖、`containsKey` 查不到、`remove` 删不掉的问题。

## `hashCode()`

。返回对象的哈希值，契约是**相等的对象必须有相同的 hashCode**，反之不成立。默认实现是身份哈希码，通常与内存地址相关。**重写 `equals` 时必须重写它**，且参与计算的字段一旦变化，hashCode 也应随之变化。

## `getClass()`

。返回对象的运行时类型 `Class` 对象。它是**final 的**，不能被重写，因此可以作为"类型判断"的可靠依据。

## `clone()`

。默认是**浅拷贝**，且是 `protected` 的，外部类无法直接调用（必须通过 `Object.clone()` 或实现 `Cloneable` 接口），且**抛 `CloneNotSupportedException`**。需要深拷贝时应优先用**拷贝构造器或序列化实现**，而不是重写 `clone`。

## `finalize()`

。对象被回收前的最后一次清理机会，已在 **Java 9 起废弃**、Java 18 起被移除。它**执行时机不确定、可能永不执行**，不能用来释放关键资源。正确做法是实现 `AutoCloseable` 并用 **try-with-resources**。

## `notify()` / `notifyAll()`

。唤醒在该对象等待集中的线程（全部或任意一个），**必须持有该对象的监视器锁**才能调用，否则抛 `IllegalMonitorStateException`。

## `wait()`

。让当前线程释放对象锁并进入等待集，直到被 `notify`/`notifyAll` 唤醒、超时或被中断。同样**必须在 `synchronized` 块中调用**。

## `wait(long timeout)`

。带超时版本的 `wait`，超时后自动醒来，返回值可区分"被唤醒"与"超时"。

## `getClass()` 之外的类型相关方法

。`Class` 对象上的 `getName()`、`getSimpleName()`、`getClassLoader()` 等是反射能力的入口。

## 实践要点

。实际开发中最常用的是 **`toString`、`equals`、`hashCode`** 这三个，其余多在并发与资源管理场景使用。写 `equals` 时推荐用 `Objects.equals` 与 `Objects.hash` 减少出错；重写 `toString` 时注意不要把敏感信息（密码、身份证）打进去。
