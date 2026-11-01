---
title: Java 中的 Exception 和 Error 有什么区别？
published: 2026-10-22
description: Exception 表示程序可预期可处理的异常，Error 表示 JVM 层面的严重错误，本文讲清两者的继承结构与判断标准。
tags: [基础, 面试]
category: Java
section: note
draft: false
---
Exception 和 Error 都继承自 Throwable，区别在于**它们表示的问题性质不同**：Exception 表示程序可以预期、也有可能处理的异常情况，Error 表示 JVM 或系统层面的严重错误，程序通常无法也不应该去处理。落到实操上只需一句话判断：能靠改业务逻辑或加防御性检查避免的是运行时异常，来自外部依赖的是受检异常，Error 则交给上层统一兜底。

## 继承结构：Throwable 只有两条分支

Throwable 下面只有两个直接子类，Error 和 Exception，二者平级，不共享捕获语义。Exception 再往下分两支：一支是 RuntimeException 及其所有子类，属于非受检异常；另一支是其余继承 Exception 的类，属于受检异常。判断一个异常受检与否，不看类名好不好听，只看它是不是 RuntimeException 的后代：不是后代，编译器就强制你处理。正因为 Error 和 Exception 平级，`catch (Exception e)` 是抓不到 OutOfMemoryError 的，这也是很多人以为「兜住了」却在线上直接挂掉的原因。

## Exception：程序应该处理的两种情况

运行时异常都继承自 RuntimeException，典型的是空指针、数组越界、类型转换错误、算术异常（除零）。它们的共同点是编译器既不强制捕获，也不要求在方法签名上声明，根因几乎都是程序员编码失误——少判了 null、下标算错、强转没校验。既然是自己写错的，就该用代码规范和单元测试去避免，而不是在每个调用点套 try-catch。

受检异常则以 IOException 为代表，编译器强制要求二选一：就地捕获处理，或者在方法签名上 throws 交给调用方。

```java
// 受检异常：不捕获就必须声明，二者必居其一
public String read(String path) throws IOException {
    return Files.readString(Path.of(path)); // 抛给调用方处理
}
```

它们通常代表外部环境出了问题——文件被删、连接断了、磁盘满了——程序本身没写错，但必须给出降级路径，比如重试、读缓存、返回兜底数据。

## Error：JVM 层面的故障，业务代码不抢救

Error 及其子类代表 JVM 自身出了状况：OutOfMemoryError 是内存耗尽，StackOverflowError 是递归太深把栈压爆，NoClassDefFoundError 是类加载阶段就找不到类定义。这类错误发生时，堆、栈等运行时资源已经不可靠，即使 catch 住也很难保证后续代码还能安全执行，所以应用层基本无能为力，通常靠 JVM 退出、容器重启、上层框架或运维监控来兜底。

## 三类问题的对比与判断标准

| 维度 | 运行时异常 | 受检异常 | Error |
| --- | --- | --- | --- |
| 代表类 | NullPointerException、ArrayIndexOutOfBoundsException | IOException、SQLException | OutOfMemoryError、StackOverflowError |
| 编译器是否强制处理 | 不强制 | 强制捕获或 throws | 不强制 |
| 根因 | 代码写得不对 | 外部环境或 I/O 异常 | JVM 资源耗尽或运行环境损坏 |
| 正确应对 | 改代码、加校验、补测试 | 显式捕获并给出降级方案 | 不处理，交给上层兜底 |

按这张表反推判断标准：一个异常如果能通过修改业务逻辑或合理的防御性检查避免，它大概率是运行时异常，本质是代码 bug；如果是外部依赖不可用导致的，就属于受检异常，应当显式处理并给出降级方案；Error 则应当交给上层框架统一兜底，业务代码里一般不写针对 Error 的 catch。处理手段上也对应得很整齐——Exception 靠 try-catch、throw、throws 三件套管理生命周期，Error 则根本不进入这套流程。

## 常见追问

**Q：`catch (Exception e)` 能兜住 OutOfMemoryError 吗？**
不能。Error 与 Exception 是 Throwable 下平级的两支，只有 `catch (Throwable t)` 才拦得住，而这通常是不该写的代码。

**Q：那我把 OutOfMemoryError 捕获住、清理一下内存再继续，行不行？**
不建议。OOM 发生时堆已经处于不可信状态，清理动作本身也可能再分配对象；正确做法是让它快速失败，由监控告警和重启恢复，再回头查内存泄漏或堆配置。

**Q：受检异常太啰嗦，全包成 RuntimeException 抛出去可以吗？**
要分清场景。受检异常的设计意图是强制调用方意识到「这里可能失败、必须给个降级方案」，无脑包装等于把这个约束删掉，故障就变成了运行时才暴露。框架边界处统一转换可以，但转换时要保留 cause 并记录上下文。

**Q：自定义异常该继承谁？**
业务可预期的失败继承 Exception（受检）或 RuntimeException（非受检），取决于你是否希望强制调用方处理；永远不要继承 Error，那会骗过所有上层兜底逻辑。

## 易错点

- 把「非受检异常」和「受检异常」说反，甚至称 IOException 是非受检异常。正确说法是：IOException 属于受检异常，受检与否只取决于是否继承 RuntimeException。
- 以为 Error 也继承自 Exception。二者是 Throwable 下的兄弟，层级搞错，捕获范围就全错。
- 混淆 ClassNotFoundException 和 NoClassDefFoundError。前者是受检异常，显式加载类时抛；后者是 Error，类在编译期存在、运行期加载失败时抛。
- 用 `catch (Throwable t)` 图省事兜住一切。它连 Error 一起吞掉，掩盖真正该暴露的故障；捕获 InterruptedException 后忘记恢复中断标记，则是另一种常见的同类错误。

## 一句话记住

:::tip
能靠改代码避免的是运行时异常；Error 只兜底，不抢救。
:::
