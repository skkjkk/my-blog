---
title: Spring Boot 的启动过程？
published: 2026-10-29
description: Spring Boot 启动就是创建容器、解析配置类、实例化所有 Bean，并在 refresh 内拉起内嵌 Web 服务器。
tags: [基础, 面试]
category: Java
section: note
draft: false
---
Spring Boot 启动本质上是**创建 ApplicationContext 容器、解析配置类、实例化所有非懒加载单例并触发生命周期回调**的过程。主线是 `SpringApplication.run()`：推断应用类型 → 准备 Environment → 创建上下文 → refresh 容器 → 发布就绪事件。用自动装配、内嵌服务器、外部化配置和运维端点把长串动作收成一行代码，`refresh()` 内部就把内嵌 Tomcat 拉起来了。

## 总览：run() 里的五个阶段

```java
SpringApplication.run(App.class, args)
 ├─ 推断应用类型 + 准备 Environment（application.yml / 系统属性 / 环境变量 / 命令行 / 配置中心）
 ├─ createApplicationContext()：按应用类型创建上下文
 ├─ prepareContext()：设 Environment → 执行 Initializer → 注册主配置类 → 发布 PreparedEvent
 ├─ refreshContext()：refresh() 的 12 步，解析配置类 → 注册后置处理器 → 实例化单例 → 启动内嵌服务器
 └─ afterRefresh()：发布 StartedEvent → 执行 Runner → 发布 ReadyEvent
```

记住这张骨架就够了：**前三步是「准备容器」，第四步是「把容器填满并跑起来」，第五步是「通知外面我好了」。** 被追问细节时，再按下面五节的顺序往里填：哪一步创建了什么对象、哪一步解析了什么配置、哪一步真正启动了服务器。这样分阶段复述，比一路平铺方法名更容易记住，也更像在讲机制而不是在背源码。

## 第一步：推断应用类型并准备 Environment

`SpringApplication.run(App.class, args)` 内部先创建 `SpringApplication` 对象，这一步做三件事：

- **推断应用类型**：`WebApplicationType` 有三个取值 `NONE`、`SERVLET`、`REACTIVE`，依据类路径上能不能找到 `DispatcherServlet` 或响应式的 `WebFlux` 相关类来判断，它决定了后面创建哪种上下文、要不要建内嵌服务器。
- **准备 Environment**：把 `application.yml` / `application.properties`、系统属性、环境变量、命令行参数、配置中心的内容按优先级合并成统一的 `Environment`，并发布 `ApplicationEnvironmentPreparedEvent`。
- **确定应用名与主配置类**：`spring.application.name`、主启动类（`primarySources`）、启动 Banner 都在这一段定下来，同时启动 `StopWatch` 开始记录启动耗时。

这里的关键认知：**Environment 在容器创建之前就已经准备好了**，所以后面的 `@Value`、`${}` 占位符能从 Environment 里取到值。

## 第二步：创建 ApplicationContext（容器）

根据第一步推断出的应用类型，选择对应的上下文实现：

- `SERVLET` → `AnnotationConfigServletWebServerApplicationContext`
- `REACTIVE` → `AnnotationConfigReactiveWebServerApplicationContext`
- `NONE` → `AnnotationConfigApplicationContext`

创建容器的同时设置 `Environment`，加载 `ApplicationContextInitializer` 与 `ApplicationListener`（都来自 `spring.factories` 的登记），并准备好 `BeanNameGenerator`、资源加载器、Banner。

这一节最容易被忽略的一点：**容器构造时就已经通过 `AnnotatedBeanDefinitionReader` 把 `ConfigurationClassPostProcessor` 等内置后置处理器的 BeanDefinition 注册进去了**，只是「注册」而已，真正的解析与执行要等到 `refresh()`——这是后面几个易错点的根子。

## 第三步：prepareContext —— 执行 Initializer 并装配上下文

这一步发生在容器创建之后、`refresh()` 之前，一共做四件事：

- `applyInitializers`：依次执行所有 `ApplicationContextInitializer`。这是启动链上**第一个可扩展点**——容器已经创建、还没 refresh，可以拿到 `ApplicationContext` 设置环境属性、补注册 `BeanFactoryPostProcessor`、改写 BeanDefinition
- 把上一步准备好的 `Environment` 设进 context，并注入 `BeanNameGenerator`、资源加载器（`postProcessApplicationContext`），必要时包一层 `ApplicationContext` 代理
- 把主配置类 `load` 成 BeanDefinition
- 发布 `ApplicationPreparedEvent`

**注意这一步只登记 BeanDefinition，不解析 `@Configuration`。** 配置类、`@Bean`、`@Import`、自动配置类的解析统统发生在下一步 `refresh()` 的 `invokeBeanFactoryPostProcessors` 里。

再往前一点，`SpringApplicationRunListener` 的 `starting()` 已经发布过 `ApplicationStartingEvent`，标志着启动正式开始；紧随其后的是准备 Environment、打印 Banner、启动 `StopWatch` 计时。实践里 Initializer 用得最多的是测试与灰度：测试中替换数据源、往 Environment 里塞标记位、按环境注册额外的后处理器。

## 第四步：refreshContext —— refresh() 的 12 步（核心）

这一步是 Spring 容器的标准生命周期，`AbstractApplicationContext.refresh()` 依次执行：

| # | 方法 | 做了什么 |
| --- | --- | --- |
| 1 | `prepareRefresh` | 初始化属性源、获取 Environment、校验必需属性、记录启动时间 |
| 2 | `obtainFreshBeanFactory` | 获取（并刷新）`DefaultListableBeanFactory` |
| 3 | `prepareBeanFactory` | 设置类加载器与 SpEL 解析器、注册 `ApplicationContextAwareProcessor`、忽略 Aware 接口的自动注入 |
| 4 | `postProcessBeanFactory` | 留给子类扩展，Servlet 容器在这里注册 `ServletContextAwareProcessor` |
| 5 | `invokeBeanFactoryPostProcessors` | ⭐ 真正执行所有 `BeanFactoryPostProcessor`：`ConfigurationClassPostProcessor` 解析 `@Configuration` / `@ComponentScan` / `@Bean` / `@Import`，`PropertySourcesPlaceholderConfigurer` 解析 `@Value` 占位符 |
| 6 | `registerBeanPostProcessors` | ⭐ 注册所有 `BeanPostProcessor`：`AutowiredAnnotationBeanPostProcessor`（处理 `@Autowired` / `@Value` 注入）、`CommonAnnotationBeanPostProcessor`（`@PostConstruct` / `@PreDestroy`）、`ApplicationListenerDetector` |
| 7 | `initMessageSource` | 初始化国际化资源 |
| 8 | `initApplicationEventMulticaster` | 初始化事件多播器 |
| 9 | `onRefresh` | ⭐ 子类实现：Servlet 环境下 `createWebServer()` 把内嵌 Tomcat 创建出来，同时注册负责启停的 Lifecycle |
| 10 | `registerListeners` | 把 `ApplicationListener` 注册进多播器 |
| 11 | `finishBeanFactoryInitialization` | ⭐ 实例化所有非懒加载的单例：构造器 → 属性注入 → `@PostConstruct` / `InitializingBean.afterPropertiesSet` / `SmartInitializingSingleton` 回调 |
| 12 | `finishRefresh` | 初始化 `LifecycleProcessor` → 启动所有 `SmartLifecycle`（内嵌服务器在这里真正 start）→ 发布 `ContextRefreshedEvent` → 标记容器 active |

面试里真正值得展开的是第 5、6、11 步：第 5 步决定「自动装配到底有没有生效」，第 6 步决定「`@Autowired` 和 `@PostConstruct` 能不能被处理」，第 11 步决定「Bean 是什么时候被 new 出来的」。把这三步说清楚，比背完 12 个方法名更能体现深度。

## 第五步：afterRefresh 与就绪事件

`refresh()` 返回后，启动流程只剩「通知」：

- `SpringApplicationRunListener.contextStarted()` → 发布 `ApplicationStartedEvent`
- 执行 `ApplicationRunner` / `CommandLineRunner`（在 `run()` 末尾、`ApplicationReadyEvent` **之前**执行，适合做预热缓存、注册路由、校验配置；⚠️ 这里的异常会导致启动失败）
- `SpringApplicationRunListener.started()` → 发布 `ApplicationReadyEvent`

**`ApplicationReadyEvent` 是「应用完全就绪」的信号**，注册中心注册、指标上报这类收尾动作通常挂在这个时机。除了 Runner，也可以用 `@EventListener` 监听 `ApplicationReadyEvent` 等容器事件，适合放不要求顺序的收尾逻辑。

## 内嵌服务器在什么时候启动（最容易答错）

很多人以为「启动 Tomcat」在最后一步，实际时间线是：

- **`onRefresh()`** —— 创建 Web 服务器（`createWebServer()`），此时只是把 `WebServer` 对象 new 出来并注册好，端口还没有监听
- **`refresh()` 收尾的 `finishRefresh()`** —— `LifecycleProcessor` 触发 `SmartLifecycle` 的 `start()`，内嵌服务器的启停组件在这里调用 `start()`，**端口才真正开始监听**
- **创建服务器时顺带完成** —— 容器里的 `ServletContextInitializer`（含 `DispatcherServletRegistrationBean`）会被应用到 `ServletContext`，`DispatcherServlet` 在这一步完成注册，所以端口一开始监听就能接请求

:::tip
**结论：Tomcat 是在 `refresh()` 内部启动的，不是 `run()` 返回之后才启动的。** 有说法把位置记成 `finishBeanFactoryInitialization` 的末尾调用 `startWebServer()`，不同版本的具体写法有差异，但共同的关键点是同一个：**创建与启动都在 `refresh()` 之内完成**。
:::

## Spring Boot 相比 Spring 简化了什么（题眼）

- **自动装配** —— `spring-boot-autoconfigure` 提供大量 `XxxAutoConfiguration`，用 `@ConditionalOnClass` / `@ConditionalOnMissingBean` / `@ConditionalOnProperty` 做条件化装配，只有类路径存在、且用户没有自定义时才生效，这就是「约定优于配置」
- **内嵌服务器** —— Tomcat / Jetty / Undertow 直接打进 jar，`java -jar` 就能跑，不需要外部容器和部署描述符
- **外部化配置** —— 统一的 `Environment` 抽象与优先级（命令行参数 > 系统属性 > 环境变量 > 配置文件）
- **Starter 与 Actuator** —— Starter 聚合依赖，一行依赖带来一整套可用组件；Actuator 提供健康检查、指标、优雅停机等运维端点

## 常见追问

**Q：`@SpringBootApplication` 凭什么能自动装配？**
A：它是 `@SpringBootConfiguration`、`@EnableAutoConfiguration`、`@ComponentScan` 的组合。`@EnableAutoConfiguration` 通过 `@Import(AutoConfigurationImportSelector.class)` 把登记在 `META-INF/spring.factories` 或较新版本的 `AutoConfiguration.imports` 里的自动配置类导入成普通配置类，再由 `ConfigurationClassPostProcessor` 解析，条件注解决定哪一个真正生效。

**Q：`BeanFactoryPostProcessor` 和 `BeanPostProcessor` 有什么区别？**
A：前者在 refresh 的第 5 步执行，操作对象是 **BeanDefinition（元信息）**，此时一个对象都还没创建；后者在第 6 步注册、第 11 步实例化每个 Bean 时回调，操作对象是**已经 new 出来的实例**，`@Autowired` 注入和 AOP 代理都靠它。

**Q：`ApplicationRunner` 和 `@PostConstruct` 哪个先执行？**
A：`@PostConstruct` 早得多。它是单个 Bean 初始化阶段的回调（refresh 第 11 步），容器还没就绪；Runner 在 `refresh()` 之后才跑。所以依赖「容器全部就绪」的初始化逻辑，不能写在 `@PostConstruct` 里。

**Q：启动慢一般卡在哪里？**
A：常见是单例 Bean 太多被逐个实例化、`@ComponentScan` 扫的包过大、数据源或远程配置中心连接超时、以及 Runner 里做了同步远程调用。排查方向是把启动过程打开 DEBUG 日志看各阶段耗时，而不是凭感觉猜。

## 易错点

- **把 `ConfigurationClassPostProcessor` 的执行说成在 `prepareContext`。** 它只是在容器构造时被注册成 BeanDefinition，真正执行在 `refresh()` 的 `invokeBeanFactoryPostProcessors`，这是「自动装配生效」的准确位置。
- **把内嵌服务器说成 `run()` 返回之后才启动。** 创建在 `onRefresh()`，真正 `start()` 在 `finishRefresh()`，全部发生在 `refresh()` 之内。
- **把「容器 refresh 完成」当成「应用已就绪」。** `refresh()` 结束时容器可用，但还没发布 `ApplicationStartedEvent` / `ApplicationReadyEvent`，Runner 也还没跑。
- **以为 Runner 抛异常只是打个日志。** 它跑在 `ApplicationReadyEvent` 之前，异常会直接导致启动失败，所以预热、校验这类逻辑要做兜底。

## 一句话记住

:::tip
**启动就是 refresh 一次容器：装 Bean、起 Tomcat，返回时已能收请求。**
:::
