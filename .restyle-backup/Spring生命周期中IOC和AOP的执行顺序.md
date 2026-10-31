---
title: Spring 生命周期中，IOC 和 AOP 哪个先执行？
published: 2026-10-29
description: "结论：IOC 先，AOP 后。 AOP 代理是在 Bean \"创建并注入完成之后\"才被包装上去的 —— AOP 是对已就绪的 Bean 做增强包装，而不是…"
tags: [基础, 面试]
category: Java
section: note
draft: false
---
**结论：IOC 先，AOP 后。** AOP 代理是在 Bean "**创建并注入完成之后**"才被包装上去的 —— AOP 是对已就绪的 Bean 做增强包装，而不是先织入再创建。

1) **先看容器启动的主干顺序**（对应 `AbstractApplicationContext.refresh()`）
`BeanFactoryPostProcessor` 阶段 → `BeanPostProcessor` 注册 → **实例化 + 依赖注入（IOC）** → 初始化回调 → **AOP 代理生成** → 容器就绪。

2) **IOC 要分成两个阶段看**
- **准备阶段（`BeanFactoryPostProcessor`）**：解析 `@Configuration`、处理 `@Import`、解析 `${}` 占位符（`PropertySourcesPlaceholderConfigurer`）—— 此时只有 **BeanDefinition（元信息）**，**还没有任何对象实例**。
- **主体阶段**（`finishBeanFactoryInitialization` → `preInstantiateSingletons` → `createBean`）：真正**实例化**对象（构造器）→ **`populateBean` 做属性/依赖注入**（`@Autowired`、`@Resource`、构造器注入）—— **这一步才是 IOC 的核心**。

3) **AOP 代理在哪一步生成**
由 `AnnotationAwareAspectJAutoProxyCreator`（一个 `SmartInstantiationAwareBeanPostProcessor`）在 **`postProcessAfterInitialization`** 阶段通过 `wrapIfNecessary` 创建代理 —— JDK 动态代理或 CGLIB 子类。

4) **单个 Bean 的精确顺序（`doCreateBean`）**
```
① 实例化（构造器）
② populateBean → 属性注入 / 依赖注入     ← IOC 在这里
③ postProcessBeforeInitialization → @PostConstruct → InitializingBean.afterPropertiesSet
④ postProcessAfterInitialization          ← AOP 代理在这里生成
⑤ 用代理对象替换容器中的原始对象
```
> **所以 IOC（②）严格早于 AOP（④）**。另外注意 `@PostConstruct`（③）是在代理生成**之前**执行的 —— 它跑在**目标对象**上，不是代理上。

5) **⚠️ 容易答错的例外：AOP 的"准备"其实更早**
`AutoProxyCreator` 本身就是一个 `BeanFactoryPostProcessor`，**Advisor（切面）的查找**发生在 BeanFactoryPostProcessor 阶段。所以准确说法是：**增强器的"发现"与 IOC 的准备同期；真正"生成代理对象"才在 IOC 完成之后。** 只说"IOC 一定全在 AOP 前面"是不准确的。

6) **⭐ 循环依赖与 AOP 的特殊处理（高频追问）**
若 A 依赖 B、B 又依赖 A，且 A 需要被 AOP 增强，那么 B 拿到的必须是 **A 的代理对象**，不能是原始对象（否则 B 调 A 的方法会绕过增强，事务/日志失效）。Spring 通过 `SmartInstantiationAwareBeanPostProcessor.getEarlyBeanReference` **提前暴露代理引用**（三级缓存中的 `singletonFactory`）来保证这一点。**这正是"三级缓存"存在的核心原因之一。**

7) **由此推出的实践结论**
- **`this` 内部调用不走代理** → `@Transactional` / `@Async` 失效（同类自调用）
- **`private` / `final` 方法无法被增强** → Spring AOP 基于**方法拦截**；`final` 类不能用 CGLIB，`final` 方法无法覆写
- **Spring AOP 只能增强 Spring 管理的 Bean** —— `new` 出来的对象不受代理
- **`@Async` 必须走代理** → 同样受 `this` 自调用限制

8) **一句话记忆**
> **IOC 负责"把对象造出来并组装好"，AOP 负责"给造好的对象套一层外壳"。** 顺序永远是**先 IOC 后 AOP**，因为代理对象要包装的正是那个已经注入完毕的实例。

9) **面试答法建议**。三点：**① 结论先行（IOC 先、AOP 后）；② 给出 `doCreateBean` 的五步精确顺序**（实例化 → `populateBean` 注入 → `@PostConstruct` → `postProcessAfterInitialization` 生成代理 → 替换容器对象），并指出 `@PostConstruct` 跑在目标对象上；③ 补两个深度点：**Advisor 的发现其实在 BeanFactoryPostProcessor 阶段（准备早于代理生成）**，以及 **循环依赖下靠 `getEarlyBeanReference` 提前暴露代理**（三级缓存存在的核心原因）。**第三点的循环依赖代理问题最能拉开差距。**
