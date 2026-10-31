---
title: Java 中的 Exception 和 Error 有什么区别？
published: 2026-10-22
description: Exception 和 Error 都继承自 Throwable，区别在于它们表示的问题性质不同：Exception 表示程序可以预期和处理的异常情况，E…
tags: [基础, 面试]
category: Java
draft: false
---
Exception 和 Error 都继承自 Throwable，区别在于**它们表示的问题性质不同**：Exception 表示程序可以预期和处理的异常情况，Error 表示 JVM 或系统层面的严重错误，程序通常无法也不应该去处理。

在结构上，Exception 又分为运行时异常和非受检异常。运行时异常都继承自 RuntimeException，比如空指针、数组越界、类型转换、算术异常，它们的特点是不需要在方法签名上声明，编译器不强制捕获，属于程序员编码失误，可以通过良好的代码规范来避免。而非受检异常比如 IOException，属于受检异常，编译器会强制要求捕获或者声明抛出，通常代表外部环境或 I/O 出了问题，可以通过捕获来降级处理。相比之下，Error 及其子类比如 OutOfMemoryError、StackOverflowError、NoClassDefFoundError，代表的是 JVM 层面的资源耗尽或者运行环境损坏，应用程序对它基本无能为力，一旦发生通常只能由 JVM 或运维层面来兜底。

从处理方式上说，Exception 是"程序应该去处理"的，通过 try-catch、抛出或者声明来管理；而 Error 是"程序不该处理"的，业务代码里一般不写针对 Error 的 catch。

实践中的判断标准是：如果一个异常是可以通过修改业务逻辑或者合理的防御性检查来避免的，它大概率是运行时异常，属于代码 bug；而如果是外部依赖不可用导致的，就属于受检异常，应当显式处理并给出降级方案；Error 则应当交给上层框架统一兜底。
