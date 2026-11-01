---
title: Spring 生命周期中，IOC 和 AOP 哪个先执行？
published: 2026-10-29
description: "IOC 先执行、AOP 后执行：代理在 Bean 实例化并注入完成后才被包装上去，@PostConstruct 仍跑在原始对象上。"
tags: [基础, 面试]
category: Java
section: note
draft: false
---
**结论：IOC 先，AOP 后。** AOP 代理是在 Bean "**创建并注入完成之后**"才被包装上去的 —— AOP 是对已就绪的 Bean 做增强包装，而不是先织入再创建。放到 `doCreateBean` 里看就是：实例化 → `populateBean` 注入 → 初始化回调 → `postProcessAfterInitialization` 生成代理，注入发生在代理生成之前，所以顺序不可能是反的。

## 先看容器启动的主干顺序

（对应 `AbstractApplicationContext.refresh()`）
`BeanFactoryPostProcessor` 阶段 → `BeanPostProcessor` 注册 → **实例化 + 依赖注入（IOC）** → 初始化回调 → **AOP 代理生成** → 容器就绪。

把这条主干和「谁产出什么东西」对起来，顺序就不会记混：

| 阶段 | 主要动作 | 此时手上的产物 |
| --- | --- | --- |
| `BeanFactoryPostProcessor` | 解析 `@Configuration`、`@Import`、`${}` 占位符（`PropertySourcesPlaceholderConfigurer`）、扫描 `@Aspect` | 只有 BeanDefinition（元信息）与切面候选，没有任何对象实例 |
| `BeanPostProcessor` 注册 | 把 `AutowiredAnnotationBeanPostProcessor`、`AnnotationAwareAspectJAutoProxyCreator` 等后置处理器注册进容器 | 一批后置处理器实例 |
| 实例化 + 依赖注入 | 构造器建对象、`populateBean` 注入属性、`@Autowired` / `@Resource` 生效 | 原始对象，还没有代理 |
| 初始化回调 | `@PostConstruct` → `InitializingBean.afterPropertiesSet` → 自定义 `init-method` | 初始化完成的目标对象 |
| AOP 代理生成 | `postProcessAfterInitialization` → `wrapIfNecessary` | JDK 动态代理或 CGLIB 子类，替换原始对象进入单例池 |

## IOC 要分成两个阶段看

- **准备阶段（`BeanFactoryPostProcessor`）**：解析 `@Configuration`、处理 `@Import`、解析 `${}` 占位符（`PropertySourcesPlaceholderConfigurer`）—— 此时只有 **BeanDefinition（元信息）**，**还没有任何对象实例**。
- **主体阶段**（`finishBeanFactoryInitialization` → `preInstantiateSingletons` → `createBean`）：真正**实例化**对象（构造器）→ **`populateBean` 做属性/依赖注入**（`@Autowired`、`@Resource`、构造器注入）—— **这一步才是 IOC 的核心**。

面试里说「IOC 先执行」，指的一定是主体阶段：对象造出来、依赖填进去。前面那个准备阶段只是把「图纸」画好，图纸阶段谈不上谁先谁后，因为它根本不产生对象。

## AOP 代理在哪一步生成

由 `AnnotationAwareAspectJAutoProxyCreator`（一个 `SmartInstantiationAwareBeanPostProcessor`）在 **`postProcessAfterInitialization`** 阶段通过 `wrapIfNecessary` 创建代理 —— JDK 动态代理或 CGLIB 子类。

判断依据是「这个 Bean 有没有匹配到 Advisor」：匹配上了就把原始对象包进代理返回，没匹配上就原样返回。所以代理不是每个 Bean 都有的，只有被切面命中的 Bean 才会被包一层；这也意味着「AOP 后执行」是就单个 Bean 的生命周期而言，不是容器级的两个独立阶段。

## 单个 Bean 的精确顺序（`doCreateBean`）

把上面那条主干收到单个 Bean 上，就是 `AbstractAutowireCapableBeanFactory.doCreateBean` → `initializeBean` 的固定次序：

```
① 实例化（构造器）
② populateBean → 属性注入 / 依赖注入     ← IOC 在这里
③ postProcessBeforeInitialization → @PostConstruct → InitializingBean.afterPropertiesSet
④ postProcessAfterInitialization          ← AOP 代理在这里生成
⑤ 用代理对象替换容器中的原始对象
```

:::caution
**所以 IOC（②）严格早于 AOP（④）**。另外注意 `@PostConstruct`（③）是在代理生成**之前**执行的 —— 它跑在**目标对象**上，不是代理上。
:::

记住 ③ 和 ④ 的先后还有个直接好处：它一次解释了两种「注解不生效」——`@PostConstruct` 里调用本类的 `@Transactional` 方法不会开事务，因为此刻既没有代理，调用走的也是 `this`；而 ② 注入进来的依赖对象，只要它已经完成创建，拿到的就是它的最终形态（必要时是代理），不会出现「容器里是代理、注入进去的是原始对象」的错位，循环依赖那条特殊路径除外。

## 容易答错的例外：AOP 的「准备」其实更早

代理创建器并不是等所有 Bean 都造好才登场的：`AnnotationAwareAspectJAutoProxyCreator` 是 `@EnableAspectJAutoProxy` 通过 `AspectJAutoProxyRegistrar` 注册进来的 BeanDefinition，**在 `BeanFactoryPostProcessor` 阶段（`ConfigurationClassPostProcessor` 解析 `@Import`）就已经进入容器**，`@Aspect` 切面类也在这一阶段被扫成候选。

所以准确说法是：**切面的「发现」与 IOC 的准备同期；真正「生成代理对象」才在 IOC 完成之后。** 只说「IOC 一定全在 AOP 前面」是不准确的。

这里顺手纠一个常见口误：`AnnotationAwareAspectJAutoProxyCreator` 本身是 `SmartInstantiationAwareBeanPostProcessor`（属于 BeanPostProcessor），**不是** `BeanFactoryPostProcessor`；它只是被「注册 BeanDefinition」这个 BeanFactoryPostProcessor 阶段顺带带进来的。Advisor 的实例化、排序与缓存，发生在这个后置处理器第一次被调用（`getAdvicesAndAdvisorsForBean`）时。

## 循环依赖与 AOP 的特殊处理（高频追问）

若 A 依赖 B、B 又依赖 A，且 A 需要被 AOP 增强，那么 B 拿到的必须是 **A 的代理对象**，不能是原始对象（否则 B 调 A 的方法会绕过增强，事务/日志失效）。Spring 通过 `SmartInstantiationAwareBeanPostProcessor.getEarlyBeanReference` **提前暴露代理引用**（三级缓存中的 `singletonFactory`）来保证这一点。**这正是「三级缓存」存在的核心原因之一。**

三级缓存的分工也是同一个道理：一级 `singletonObjects` 放完全就绪的 Bean，二级 `earlySingletonObjects` 放提前暴露的半成品，三级 `singletonFactories` 存的是能生产「提前引用」的 `ObjectFactory`。用工厂而不是直接放对象，是因为此刻还不知道这个 Bean 要不要被代理，要等真正有人来取时才由 `getEarlyBeanReference` 决定返回代理还是原始对象 —— 这也是为什么代理可以「提前」出现，却不破坏「先注入、后包装」的主线。

## 由此推出的实践结论

- **`this` 内部调用不走代理** → `@Transactional` / `@Async` 失效（同类自调用）
- **`private` / `final` 方法无法被增强** → Spring AOP 基于**方法拦截**；`final` 类不能用 CGLIB，`final` 方法无法覆写
- **Spring AOP 只能增强 Spring 管理的 Bean** —— `new` 出来的对象不受代理
- **`@Async` 必须走代理** → 同样受 `this` 自调用限制

## 常见易错点

- **错直觉：AOP 在 IOC 之前织入。** 那是编译期/类加载期织入（AspectJ 静态织入）的做法；Spring AOP 默认是运行时代理，没有造好的目标对象就没有东西可包，所以必然先 IOC 后 AOP。
- **错直觉：初始化方法跑在代理上。** `@PostConstruct`、`afterPropertiesSet`、`init-method` 都在 `postProcessAfterInitialization` 之前执行，操作的是目标对象，不是代理。
- **错直觉：`@Autowired` 注入的是原始对象。** 单例池里最终注册的是代理，注入给别人、`getBean` 拿到的都是代理；`this` 才是原始对象。
- **错直觉：所有方法都能被增强。** 被增强的方法得是 `public`，`private` / `static` 方法无效；`final` 类不能被 CGLIB 生成子类，`final` 方法不能被覆写。

## 常见追问

**Q：`@PostConstruct` 里能拿到自己的代理吗？**
A：不能。它执行在 `postProcessBeforeInitialization` 阶段，代理还没生成，此时的 `this` 是原始对象；确实需要的话用 `AopContext.currentProxy()`（要开启 `exposeProxy`），或者注入自己。

**Q：能不能先生成代理再注入？**
A：不行。代理是目标对象的包装，目标对象不存在就没法包；字段最终也落在目标实例上，代理只是把调用转发过去。

**Q：`@Transactional` 失效一般有哪几种原因？**
A：同类 `this` 自调用绕过代理、方法不是 `public`、对象不是 Spring 管理的 Bean（`new` 出来的没有代理），加上异常类型不符合回滚规则。

**Q：AOP 是容器级的一个阶段吗？**
A：不是。它是每个 Bean 走 `postProcessAfterInitialization` 时按需触发的一次包装，命中了切面才有代理，所以容器里可能同时存在被代理和未被代理的 Bean。

## 面试怎么答

1. 结论先行（IOC 先、AOP 后）
2. 给出 `doCreateBean` 的五步精确顺序（实例化 → `populateBean` 注入 → `@PostConstruct` → `postProcessAfterInitialization` 生成代理 → 替换容器对象），并指出 `@PostConstruct` 跑在目标对象上
3. 补两个深度点：切面发现与代理创建器的注册其实在 BeanFactoryPostProcessor 阶段（准备早于代理生成），以及循环依赖下靠 `getEarlyBeanReference` 提前暴露代理（三级缓存存在的核心原因）。循环依赖那一条最能拉开差距

## 一句话记住

:::tip
**IOC 负责造对象并注入，AOP 负责给造好的对象套壳：先 IOC，后 AOP。**
:::
