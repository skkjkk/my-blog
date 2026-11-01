---
title: Java 中的序列化和反序列化是什么？
published: 2026-10-22
description: 序列化把对象的实例状态写成字节流，反序列化用字节流重建对象；只搬实例状态，版本契约由 serialVersionUID 承担
tags: [基础, 面试]
category: Java
section: note
draft: false
---

序列化就是把对象的**实例状态**写成一串字节，反序列化就是拿这串字节把对象重建出来的逆操作。它的价值是让 Java 对象脱离 JVM 堆内存，跨进程、跨网络边界去传输或落盘，典型用途是网络通信与远程调用（RPC）、缓存落盘、分布式会话共享和深拷贝。标准做法是让类实现 `Serializable` 标记接口，用 `ObjectOutputStream.writeObject` 写出、用 `ObjectInputStream.readObject` 读回；字节流里只有实例状态，`static` 和 `transient` 字段都不进去，版本契约由 `serialVersionUID` 承担。

## 它到底解决了什么问题

不序列化的时候，对象只活在当前 JVM 的堆里：`new` 出来的引用没法写进文件，也没法通过网络发给另一个进程，进程一退出对象就没了。序列化把对象压成一段自描述的二进制：里面既有**字段值**，也有**类元信息**（类名、`serialVersionUID`、字段列表），接收端凭这些信息在本地找到对应的类，重新分配对象再把字段填回去。所以序列化的本质不是「保存对象」，而是「保存对象在某一刻的状态快照」，行为（方法）永远留在类里，跟着代码走。

## 标准写法：标记接口加两个流

`Serializable` 是一个没有任何方法的空标记接口，它唯一的作用是告诉 JVM「这个类允许被序列化」；真正干活的是 `ObjectOutputStream` 和 `ObjectInputStream`：前者反射遍历字段、写类描述和字段值，后者按流里的类描述找回本地类、分配对象再逐字段回填。下面是一段能跑的最小例子：

```java
import java.io.*;

class Session implements Serializable {
    private static final long serialVersionUID = 1L;  // 显式声明版本契约
    String userId;                                     // 会被序列化
    int loginCount;                                    // 会被序列化
    private static int onlineCount = 0;                // static：不进字节流
    transient String rawToken;                         // transient：不进字节流

    Session(String userId, String rawToken) {
        this.userId = userId;
        this.rawToken = rawToken;
        this.loginCount = 1;
    }
}

public class Demo {
    public static void main(String[] args) throws Exception {
        Session s = new Session("u1", "abc123");

        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (ObjectOutputStream out = new ObjectOutputStream(buf)) {
            out.writeObject(s);                        // 序列化
        }
        byte[] bytes = buf.toByteArray();

        try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(bytes))) {
            Session back = (Session) in.readObject();  // 反序列化，不调用 Session 构造器
            System.out.println(back.userId);           // u1       实例状态被还原
            System.out.println(back.loginCount);       // 1        基本字段被还原
            System.out.println(back.rawToken);         // null     transient 不还原
        }
    }
}
```

## 只搬实例状态：static 和 transient

被序列化的是**对象自己的实例字段**，也就是「这个对象此刻长什么样」。`static` 字段属于类级别信息、所有实例共享，不跟着对象走，所以不进字节流；`transient` 是给开发者用的开关：显式声明某个字段不参与序列化，常见于口令、令牌、`Socket`、`Thread` 这类敏感或不可序列化的字段。要注意反序列化后 `transient` 字段的值是**类型默认值**（引用类型是 `null`，`int` 是 0），不是原来的值，需要的话得在 `readObject` 里自己重建。另外 `serialVersionUID` 虽然是 `static` 字段，但它是特例，会被写进字节流当作版本号。

## serialVersionUID：字节流里的版本契约

`serialVersionUID` 相当于序列化版本的契约号：序列化时把它的值写进字节流，反序列化时拿流里的值和本地类的值比对，不一致就直接抛 `InvalidClassException`。不显式声明时，JVM 会根据类名、修饰符、接口、字段和方法签名算出一个 64 位哈希当作默认值，这意味着只要类结构改了一点（加个字段、改个方法签名），默认值就变了，历史字节流全都读不回来。所以线上有持久化或跨进程传输的类，都应该显式写死 `private static final long serialVersionUID = 1L;`，让版本演进变成一件可控的事：加字段读回来是默认值，删字段直接忽略，改字段类型则可能直接读失败或得到语义错位的旧值。

## 反序列化为什么危险：它绕过构造器

反序列化**不调用类的构造器**，它是先分配一个空对象、再把字节流里的字段值直接塞进去，所以构造器里那些参数校验、状态初始化、不变式检查全部不会执行——一个本该「只能通过构造器合法创建」的对象，可以被字节流造出任意字段组合。更严重的是攻击面：字节流里的类名是调用方给的，攻击者可以构造一串指向 JDK 或第三方库中「`readObject` 里干了危险事」的类，串成 gadget 链，在目标 JVM 上触发任意代码执行。这就是很多框架逐步弱化甚至淘汰 Java 原生序列化的原因之一。实践上的结论很直接：**永远不要反序列化不可信来源的字节流**；确实要收，就用序列化过滤器这类白名单机制限制可反序列化的类，或者干脆换 JSON、Protobuf、Kryo 这类更可控的格式。

## 不可序列化字段与对象图

类里如果含有不可序列化的字段（比如 `ExecutorService`、`Socket`），直接序列化会抛 `NotSerializableException`，标准解法是把它标成 `transient`，再用自定义的 `writeObject` 和 `readObject` 决定「保留哪些信息、怎么重建」：

```java
class Holder implements Serializable {
    private static final long serialVersionUID = 1L;
    private String name;
    private transient java.util.concurrent.ExecutorService pool;  // 不可序列化

    private void writeObject(ObjectOutputStream out) throws IOException {
        out.defaultWriteObject();          // 先按默认规则写可序列化的字段
        out.writeInt(pool.getPoolSize());  // 再手动补写需要保留的信息
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();                                  // 读回 name
        this.pool = java.util.concurrent.Executors.newFixedThreadPool(in.readInt()); // 重建
    }
}
```

另一件常被问到的事是对象图：序列化保存的是**整个引用图**，不只是被直接写入的那个对象——它引用的其他对象会一起被写进去。原生序列化用一张句柄表记录已经写过的对象，遇到循环引用时只写一个指向前面对象的引用标记，所以不会无限递归，一个对象在图里只存一份，读回来仍是同一个实例。真正会被循环引用坑到的是 JSON 这类树形格式：双向关联默认会一直递归，直到栈溢出，得靠 `@JsonIgnore` 之类打断。但图越大、嵌套越深，字节流体积和递归深度都会跟着涨，体积异常膨胀仍然要留意。

## 为什么更常用 JSON、Protobuf、Kryo

原生序列化的优点是「零配置、直接可用」，缺点是体积大、只能 Java 到 Java、和类结构强耦合、对不可信数据不安全。工程上通常按场景换格式：

| | Java 原生序列化 | JSON | Protobuf | Kryo |
| --- | --- | --- | --- | --- |
| 数据形态 | 二进制，自带类元信息 | 文本，字段名可见 | 二进制，靠 `.proto` 定义 | 二进制，靠注册的类 |
| 跨语言 | 不行，只限 Java | 好 | 好 | 差，面向 JVM |
| 体积与速度 | 偏大、偏慢 | 文本偏大 | 小、快 | 小、快 |
| 版本演进 | 靠 `serialVersionUID`，强耦合 | 宽松，缺字段取默认值 | 靠字段编号，兼容性好 | 需类注册，改动敏感 |
| 不可信数据 | 危险，可构造 gadget | 相对安全 | 相对安全 | 需谨慎 |

选型上的经验：对外接口和跨语言场景用 JSON 或 Protobuf，进程内高性能缓存用 Kryo 这类序列化库，Java 原生序列化基本只留在「本地临时落盘」「完全可控的内部环境」和面试题里；用它做深拷贝也成立，但要清楚它会走一遍完整的序列化/反序列化，代价不低。

## 常见追问

**Q：`static` 和 `transient` 字段为什么不序列化？**
A：`static` 属于类级别、被所有实例共享，跟着对象走没有意义；`transient` 是开发者主动声明「这个字段不参与序列化」，用来排除敏感数据和不可序列化对象，代价是读回来是类型默认值。

**Q：不写 `serialVersionUID` 会怎样？**
A：JVM 会按类结构算一个默认值，类一改结构默认值就变，反序列化时和字节流里的值对不上，抛 `InvalidClassException`。所以有持久化或跨进程需求的类都要显式声明。

**Q：循环引用会导致栈溢出吗？**
A：原生序列化不会，它用句柄表复用已写过的对象，环只写一个引用标记；JSON 这类树形格式会，双向关联需要注解打断。

**Q：为什么现在不推荐 Java 原生序列化？**
A：一是反序列化绕过构造器、能构造 gadget 链，不可信数据上是明确的漏洞面；二是体积大、速度慢、只能 Java 之间用、和类结构强耦合。工程上换成 JSON、Protobuf、Kryo 更可控。

## 易错点

- 以为「序列化保存的是对象」：实际只有**实例状态快照**，方法留在类里，`static` 和 `transient` 字段不进字节流，反序列化后 `transient` 字段是 `null` 或 0，不是原值。
- 以为反序列化会走构造器：不会——它是分配空对象再填字段，构造器里的校验逻辑不执行，所以「靠构造器保证的合法性」在反序列化面前是失效的。
- 以为 `serialVersionUID` 一致就一定兼容：一致只过了第一道门，加字段读回默认值、删字段被忽略、改字段类型仍可能读出语义错误的旧值，兼容性要按字段逐个评估。
- 以为含不可序列化字段就没救：标 `transient` 加自定义 `writeObject` / `readObject` 就能处理，`defaultWriteObject()` 和 `defaultReadObject()` 负责默认字段，剩下的自己补。
- 把原生序列化当通用方案：跨语言、对外接口、不可信数据这三类场景都不该用它，也不该在高频路径上用它当深拷贝。

## 一句话记住

:::tip
序列化搬的只是实例状态，static 和 transient 都不进字节流。
:::
