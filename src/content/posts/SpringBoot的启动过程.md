---
title: Spring Boot 的启动过程？
published: 2026-10-29
description: Spring Boot 的启动本质上是创建一个 Spring 容器（ApplicationContext）并加载其中所有 Bean、触发其生命周期回调的过…
tags: [基础, 面试]
category: Java
draft: false
---
Spring Boot 的启动本质上是**创建一个 Spring 容器（ApplicationContext）并加载其中所有 Bean、触发其生命周期回调的过程**。它是在 Spring 的基础上，用**自动装配 + 内嵌服务器 + 外部化配置 + 运维端点**四件事把启动过程"简化"了。

1) **第一步：创建 SpringApplication 实例并准备环境**
`SpringApplication.run(App.class, args)` 内部先创建 `SpringApplication` 对象，**推断应用类型**（`NONE`/`WEB`/`REACTIVE`/`SERVLET`），准备 **Environment**（加载 `application.yml`、`系统属性`、`环境变量`、`命令行参数`、配置中心），并确定**应用名、启动横幅**等。

2) **第二步：创建 ApplicationContext（容器）**
根据应用类型创建对应的上下文（**Servlet 环境是 `AnnotationConfigServletWebServerApplicationContext`**，`AnnotationConfigApplicationContext`；Reactive 则是 `AnnotationConfigReactiveWebServerApplicationContext`）。同时设置 `Environment`、**加载初始化器与监听器**（`ApplicationContextInitializer`、`ApplicationListener`），并准备 **Bean 名称生成器**、**Banner**。

3) **第三步：执行 ApplicationContextInitializer**
这是**启动的第一个可扩展点** —— 在容器创建后、refresh 之前，允许修改 `ApplicationContext`（如设置环境属性、添加 BeanFactoryPostProcessor）。**`ConfigurationClassPostProcessor` 就通过这条路径被注册进去的。**

4) **第四步：执行 ApplicationListener 的 `starting` 事件**
`SpringApplicationRunListener` 的 `starting()` 被调用，此时会**打印 Banner**、**记录启动耗时**。

5) **第五步：prepareContext —— 装配 Environment、创建并加载 ApplicationContext**
- 设置 `Environment` 到 context
- **创建 `BeanFactory`**（`DefaultListableBeanFactory`）
- **加载上下文中的 Bean 定义**（`BeanDefinitionReader`）：`@ComponentScan` 扫描、 `@Import`、`@Bean`、自动装配配置类
- **发布 `ApplicationPreparedEvent`**
- ⭐ **这个阶段会执行 `ConfigurationClassPostProcessor`**（它本身是一个 `BeanDefinitionRegistryPostProcessor`）—— 负责**解析 `@Configuration` 类**：解析 `@ComponentScan` 扫描出的类、解析 `@Bean` 方法、**处理 `@Import`/`@ImportSelector`/`@ImportBeanDefinitionRegistrar`**、**推断配置类**（`@Configuration`/`@Component`/`@ComponentScan`/`@Import`/`@ImportResource`）。**这是 Spring Boot 自动装配能够生效的关键一步。**

6) **第六步：refreshContext —— 核心的 12 步**
这一步是 Spring 容器的标准生命周期，`AbstractApplicationContext.refresh()` 依次做：
- **`prepareRefresh`** —— 初始化属性源、获取环境、校验必需属性、记录启动时间
- **`obtainFreshBeanFactory`** —— 获取（并刷新）`DefaultListableBeanFactory`
- **`prepareBeanFactory`** —— 设置类加载器、SpEL 解析器、注册 `ApplicationContextAwareProcessor`、忽略 Aware 接口的自动注入
- **`postProcessBeanFactory`** —— **BeanFactoryPostProcessor 的执行点**（此时 `BeanDefinitionRegistryPostProcessor` 也会被调用）
- **`invokeBeanFactoryPostProcessors`** —— ⭐ **真正执行所有 `BeanFactoryPostProcessor`**，包括 `ConfigurationClassPostProcessor`（解析配置类）、`PropertySourcesPlaceholderConfigurer`（**`@Value` 占位符解析**）
- **`registerBeanPostProcessors`** —— 注册所有 `BeanPostProcessor`（⭐ **最关键的一步**）：`AutowiredAnnotationBeanPostProcessor`（**处理 `@Autowired`/`@Value` 注入**）、`CommonAnnotationBeanPostProcessor`（`@PostConstruct`/`@PreDestroy` 生命周期）、`ApplicationListenerDetector` 等
- **`initMessageSource`** —— 国际化
- **`initEventMulticaster`** —— 事件多播器
- **`onRefresh`** —— ⭐ **子类实现：Servlet 环境下在这里创建内嵌 Web 服务器（Tomcat）**
- **`registerListeners`** —— 注册 `ApplicationListener`
- **`finishBeanFactoryInitialization`** —— ⭐ **实例化所有非懒加载的单例 Bean**（`preInstantiateSingletons`）：执行属性注入、构造器、初始化方法、`@PostConstruct`、`InitializingBean.afterPropertiesSet`、`SmartInitializingBean.afterSingletonsInstantiated`；**并启动 `SmartLifecycle`（如内嵌服务器的启动）**
- **`finishRefresh`** —— 初始化 `LifecycleProcessor`、**发布 `ContextRefreshedEvent`**、标记上下文为 active

7) **第七步：afterRefresh —— 启动后的扩展点**
`SpringApplicationRunListener.contextStarted()` / `started()` 被调用，**发布 `ApplicationStartedEvent` 与 `ApplicationReadyEvent`**。**`ApplicationReadyEvent` 是"应用完全就绪"的信号** —— 很多框架（如 `CommandLineRunner` 的部分场景、指标上报、注册到注册中心）在这个时机做最后动作。

8) **⭐ 内嵌服务器的启动时机（易混）**
很多人以为"启动 Tomcat"在最后一步，实际上：
- **`onRefresh()`** —— **创建** Web 服务器（`createWebServer()`，此时只是 new 出来并初始化）
- **`finishBeanFactoryInitialization()` 的最后** —— **`startWebServer()`**，调用 Servlet 容器的 `start()`，**此时端口才真正开始监听**
- **上下文 refresh 完成后** —— 执行 `WebServerStartStopLifecycle` 等 `SmartLifecycle` bean 的 `start()`，以及 **`ServletContextInitializer`（DispatcherServlet）的初始化**
> **结论：Tomcat 是在 `refresh()` 内部启动的，不是 run() 之后才启动的。** 且 **`DispatcherServlet` 的注册与初始化也在 refresh 期间完成**，因此 `run()` 返回时应用已经可以接收请求。

9) **第四步之外的两个重要扩展点**
- **`ApplicationRunner` / `CommandLineRunner`** —— 在 `run()` 末尾、`ApplicationReadyEvent` **之前**执行。**适合做"应用启动后的初始化"**（预热缓存、注册路由、校验配置），但**⚠️ 这里的异常会导致启动失败**，且**它跑在 ready 之前**
- **`@EventListener`** —— 监听 `ApplicationReadyEvent` 等容器事件

10) **Spring Boot 相比 Spring 简化了什么**（这是问题的"题眼"）
- **自动装配（Auto Configuration）** —— `spring-boot-autoconfigure` 提供大量 `XxxAutoConfiguration`，通过 `@ConditionalOnClass`/`@ConditionalOnMissingBean`/`@ConditionalOnProperty` **条件化装配**，只有类路径存在且用户没自定义时才生效 —— **约定优于配置**
- **内嵌服务器** —— Tomcat/Jetty/Undertow 直接嵌进 jar，**`java -jar` 即可运行**，无需外部容器
- **外部化配置** —— 统一 `Environment` 抽象与配置优先级（命令行 > 系统属性 > 环境变量 > 配置文件）
- **Starter 与 Actuator** —— Starter 聚合依赖；Actuator 提供健康检查、指标、**优雅停机**等运维端点

11) **⭐ 面试答法建议**。四点：**① 启动主线（SpringApplication.run → 推断类型 → 创建 Environment 与 Context → 执行 Initializer → 准备上下文（解析 @Configuration）→ refresh() 12 步 → afterRefresh 发布 Ready 事件）；② refresh 里的三个关键点（`invokeBeanFactoryPostProcessors` 处理配置类与 @Value、`registerBeanPostProcessors` 处理 @Autowired 与 @PostConstruct、`finishBeanFactoryInitialization` 实例化非懒加载单例）；③ 内嵌服务器在 `onRefresh()` 创建、`finishBeanFactoryInitialization` 末尾真正 start（**不是 run() 之后**）；④ Spring Boot 的四层简化（自动装配 + 内嵌服务器 + 外部化配置 + Actuator）。** 第三点是高频追问，也是最容易被答错的。
