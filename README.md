# 教学用 FTL 页映射与闪存块回收模拟器

纯后端教学项目：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无外部服务）。
在 SQLite 中模拟闪存转换层（FTL）的核心约束：**物理页只能写空白页、回收必须整块擦除**，
通过"异地更新 + 保留空白备用块"实现垃圾回收。仅提供 HTTP API 与 CLI，不访问任何真实磁盘、
SSD 或设备接口。

## 模型

```
块数 B（>=3），每块 P 页（>=2）
逻辑页数 L = (B-1)*P - 1        ← 留出 1 页正常写入余量，越界地址一律拒绝
备用块：始终保留 1 个全空白块    ← 普通写入绝不使用
普通区容量 = (B-1)*P 页          ← 有效页最多 L 页，故回收总能进行

示例 B=3, P=2（L=3，LPN 0..2）：

        页0        页1
块0   [ blank ] [ blank ]   ← 备用块（全空白，普通写入不用）
块1   [valid L0] [valid L1] ← 普通块
块2   [valid L2] [ blank ]  ← 普通块
```

页状态：`blank`（空白可写）/ `valid`（有效，关联 LPN 与短字符串）/ `invalid`（失效）。

- **异地更新**：写 LPN 时选新空白页写入，旧页标 `invalid`，再改映射；绝不覆盖已写页。
- **空白页选择顺序**（确定）：普通块中按块号升序、块内页号升序取第一个空白页。
- **垃圾回收**：普通区无空白页时触发。选**失效页最多**的非备用块（至少 1 页失效），
  平局取块号最小者。把受害块全部有效页**按物理页顺序**复制到备用块并逐项更新映射，
  然后整块擦除受害块，它成为新备用块；原备用块转为普通块，剩余空白页继续可用。
- **取消映射**：使对应有效页失效并删除映射；重复取消幂等（返回提示、不改状态、不计写入）；
  读未映射页返回 `NOT_FOUND`。
- **事务**：一次逻辑操作连同其触发的回收在一个 SQLite 事务中原子提交；输入非法或
  内部不变量校验失败时整体回滚，不留半份映射。这只是教学事务语义，
  **不**模拟真实断电时序。重启后重新打开同一数据文件即可继续，操作日志可复现。

## 统计

逻辑写入次数、物理编程次数（含搬迁）、搬迁页数、每块擦除次数。
写放大 = 物理编程 / 逻辑写入；无写入时报告"无数据"。数据搬迁计物理编程；
取消映射不计数据写入。

## 命令

```powershell
npm install        # 仅需开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP API（默认端口 0 = 自动选空闲端口；PORT=8080 可指定）
npm run demo       # 演示：3 块反复覆盖同几个逻辑页，触发多次回收
npm run cli -- create d1 3 2     # 创建模拟盘（数据在 ./data/d1.db）
npm run cli -- write d1 0 hello
npm run cli -- read d1 0
npm run cli -- unmap d1 0
npm run cli -- layout d1         # 物理布局
npm run cli -- log d1 3          # 查询某次操作/回收记录
npm run cli -- report d1         # 统计报告
```

## HTTP API

均返回 JSON；错误为 `{"error": 错误码, "message": 描述}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/disks/:name` | 创建/重置模拟盘，body: `{blocks, pagesPerBlock, maxDataLen?, maxLogRecords?}` |
| POST | `/disks/:name/write` | `{lpn, data}`，返回映射前后、写入位置、失效旧页、回收详情 |
| POST | `/disks/:name/unmap` | `{lpn}` |
| GET  | `/disks/:name/read?lpn=N` | 读取，未映射返回 `NOT_FOUND` |
| GET  | `/disks/:name/layout` | 全部物理页状态与备用块 |
| GET  | `/disks/:name/logs/:id` | 查询某次操作（含回收过程） |
| GET  | `/disks/:name/report` | 统计与写放大 |

错误码：`INVALID_CONFIG` `CONFIG_MISMATCH` `NOT_INITIALIZED` `INVALID_LPN`
`INVALID_DATA` `NOT_FOUND` `OUT_OF_SPACE` `INVARIANT_FAILED` `INVALID_NAME`
`PAYLOAD_TOO_LARGE`。

## 限制与假设

- 限制：块数 3..64，每块页数 2..64，数据最长 256 字符（默认 64），日志最多 10000 条（超出删最旧）。
- 每次写/取消映射同步完成；无后台任务、无真实时间模拟。
- 容量固定，越界 LPN 直接拒绝，不临时扩容。

## 真实硬件中被省略的部分

本模型只做教学演示，**不实现也不模拟**：真实固件、NAND 时序与坏块管理、
纠错码（ECC）、磨损均衡、掉电恢复（断电时序/电容保护）、TRIM 之外的高级特性、
多通道/多 die 并行、读干扰与数据保持问题。事务原子性仅来自 SQLite，
不代表真实 SSD 在任意断电点的行为。
