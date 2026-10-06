# 教学用 FTL 页映射与闪存块回收模拟器

纯后端教学项目：在 SQLite 中实现一个简化的闪存转换层（FTL）页映射模型，
模拟"物理页只能写空白页、回收必须整块擦除"的核心约束。提供 HTTP API 与 CLI。
仅用于教学，不访问任何真实磁盘、SSD 或设备接口。

## 运行环境

- Windows 本地，Node.js >= 22（使用内置 node:sqlite，无任何原生/外部依赖）
- 不需要 Docker、WSL 或任何在线服务

## 快速开始

```powershell
npm install        # 仅安装 TypeScript 开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm run demo       # 运行回收演示（4 块 x 2 页，触发多次回收）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口并打印）
```

CLI 直接使用：

```powershell
node dist/src/cli.js create --blocks 4 --pages 2      # 创建模拟盘（数据在 data\ftl.db）
node dist/src/cli.js write 0 hello                    # 写逻辑页 0
node dist/src/cli.js read 0                           # 读逻辑页 0
node dist/src/cli.js unmap 0                          # 取消映射（幂等）
node dist/src/cli.js layout                           # 查看物理布局
node dist/src/cli.js op 7                             # 查询第 7 次操作（含回收过程）
node dist/src/cli.js report                           # 导出统计报告
node dist/src/cli.js demo --db data\demo.db           # 指定数据文件
```

HTTP 服务：`node dist/src/server.js --db data\ftl.db --port 8080`
（--port 省略时默认为 0，自动选择空闲端口，启动日志打印实际端口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /disk | 创建模拟盘 {blocks, pagesPerBlock} |
| POST | /write | 写逻辑页 {lpn, data} |
| POST | /unmap | 取消映射 {lpn} |
| GET | /read/:lpn | 读逻辑页 |
| GET | /layout | 物理布局（每页状态 + 各块擦除次数） |
| GET | /ops/:id | 查询某次操作详情（含回收搬迁与擦除记录） |
| GET | /report | 统计报告（写放大等） |
| GET | /invariants | 不变量自检 |

错误统一返回 {"error":{"code","message"}}，错误码：
INVALID_PARAM、LPN_OUT_OF_RANGE、DATA_TOO_LONG、NOT_FOUND、
ALREADY_EXISTS、NO_VICTIM、INTERNAL_INVARIANT。

## 模型规则

### 容量与布局

- 块数 B >= 3，每块页数 P >= 2，创建后固定，不临时扩容。
- 逻辑页总数 L = (B-1) * P - 1：(B-1) 个普通块减去 1 页余量，
  保证普通区域写满时至少存在一页失效页，回收必有候选。
- 越界逻辑地址（lpn < 0 或 lpn >= L）一律拒绝。

文本布局示例（4 块 x 2 页，容量 5，块 3 为备用块）：

```
块0(普通): [0:0 有效 lpn=0 "A3"] [0:1 有效 lpn=2 "C2"]
块1(普通): [1:0 有效 lpn=3 "D2"] [1:1 失效]          <- 失效页等待回收
块2(普通): [2:0 失效]            [2:1 失效]
块3(备用): [3:0 空白]            [3:1 空白]          <- 始终全空白，普通写入不用
```

### 异地更新

每次写入都编程一个新的空白物理页，再更新逻辑到物理映射，旧页标为失效；
已写物理页绝不直接覆盖。普通区域空白页的选择顺序是确定的：
块号升序（跳过备用块），块内页号升序。

### 垃圾回收与备用块

- 始终保留一个完整擦净的备用块，普通写入不使用它。
- 普通区域没有空白页时触发回收：选择失效页最多的非备用块，
  平局取块号最小者；受害块必须至少有一页失效。
- 回收步骤：把受害块全部有效页按物理页顺序复制到备用块并逐项更新映射
  （搬迁计入物理编程与搬迁页数），然后整块擦除受害块，受害块成为新备用块，
  原备用块转为普通块，其剩余空白页可继续用于普通写入。
- 失效的旧版本永远不会被重新标为有效。

### 取消映射

使对应有效页失效并删除映射；重复取消幂等，返回 alreadyUnmapped: true，
不产生任何状态变化；读取未映射页返回 NOT_FOUND。取消映射不计入数据写入。

### 统计

- 逻辑写入次数、物理编程次数（数据写入 + 搬迁）、搬迁页数、各块擦除次数。
- 写放大 = 物理编程次数 / 逻辑写入次数；没有逻辑写入时返回 null 并标注"无数据"。

### 事务语义

一次逻辑操作连同其触发的回收在一个 SQLite 事务中原子提交：
输入无效或内部不变量失败时整体回滚，不留下半份映射。
这只是教学事务语义，不模拟真实断电场景下的执行顺序。
重启后从同一数据文件继续操作，映射与数据与不中断运行一致，操作日志可复现。

### 内置限制

- 数据长度 <= 200 字节（UTF-8）
- 操作日志最多保留最近 10000 条
- 无后台任务，所有动作由请求驱动

## 教学简化（真实硬件中被省略的部分）

- 不访问真实磁盘原始扇区、SSD 驱动或设备管理接口
- 不实现真实固件、纠错码（ECC）、磨损均衡、坏块管理
- 不实现掉电恢复（PLP）与真实断电语义
- 不模拟真实时间、延迟与并发读写

## 项目结构

```
src/db.ts         SQLite 打开与建表
src/ftl.ts        FTL 核心：读写、取消映射、回收、统计、不变量检查
src/server.ts     HTTP API（可配置端口，默认自动选空闲端口）
src/cli.ts        命令行入口与演示
test/ftl.test.ts  测试：顺序写满、频繁改写、取消后重写、受害块平局、
                  非法地址、手算序列核对搬迁/擦除、随机压力 + 独立字典核对、
                  重启一致性、写放大无数据状态
data/             项目内数据目录（运行时生成）
```
