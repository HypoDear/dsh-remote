# DSH Web 启动器

一个原生 exe，点一下弹菜单：**打开界面 / 重启 DSH / 停止 DSH**。

没有开机自启，没有崩溃自动重拉，没有常驻进程 —— 点完就退出，dsh 独立活着。

## 文件

| 文件 | 作用 |
|---|---|
| `DshLauncher.cs` | 全部逻辑：菜单、启停、状态探测、浏览器去重 |
| `scripts/build-launcher.ps1` | 用系统自带 `csc.exe` 编译，冒烟测试 |
| `README.md` | 本文件 |

`DshLauncher.exe`（约 12 KB）和 `%LOCALAPPDATA%\DSH\dsh.ico` 都**不入库**，现场生成。

## 安装

```powershell
pwsh -File scripts/build-launcher.ps1
```

编译出 `DshLauncher.exe` 后，建一个指向它的快捷方式，即可固定到任务栏。
图标用 `%LOCALAPPDATA%\DSH\dsh.ico`（从 DSH 自带的 `favicon.svg` 生成）。

## 用法

| 命令 | 作用 |
|---|---|
| `DshLauncher.exe` | 弹菜单 |
| `DshLauncher.exe open` | 已在跑就开浏览器；没跑就先启动 |
| `DshLauncher.exe restart` | 杀掉 → 等端口释放 → 启动 → 开浏览器 |
| `DshLauncher.exe stop` | 杀掉 → 等端口释放 |
| `DshLauncher.exe status` | 只打印状态（诊断用，退出码 0=在跑 1=没跑） |

## 为什么是编译过的 exe

实测「从启动到菜单出现」：

| 方案 | 耗时 |
|---|---|
| **.NET exe（本方案）** | **93–134 ms** |
| pwsh 7 脚本（去掉状态探测） | ~453 ms |
| pwsh 7 脚本（原实现，含探测） | ~896–976 ms |
| powershell 5.1 脚本 | ~1528 ms |

菜单构建本身只要 **44 ms**，其余全是进程启动开销。exe 比脚本快约 **10 倍**，
进入「指哪打哪」的范围（<150ms 人基本察觉不到）。

代价：逻辑从 PowerShell 搬进 C#。但换来的是下面三个问题都能干净解决 ——
它们在 PowerShell 里靠动态类型写 `ContextMenuStrip` 的消息循环很难写对。

## 三个已解决的坑

### ① 连点两次出两个菜单

**具名互斥体** `Local\DSH-Menu-3080`：第二个实例 `WaitOne(0)` 失败即静默退出。
实测同时启动两个进程，只剩 1 个在跑。

### ② 鼠标移开菜单跟着飘

菜单用**点击那一刻的坐标**显示（`Cursor.Position` 在创建菜单前就取好），
并且不跟随光标移动。

### ③ 菜单关不掉

两个必要条件，缺一不可：

1. **`SetForegroundWindow`** —— 弹菜单前必须把自身提到前台，否则
   `ToolStripDropDown` 收不到外部点击，Esc 也不生效。这是 Windows 弹
   右键菜单的标准前置动作。
2. **消息过滤器** —— 无 owner 的 `ToolStripDropDown` 不会自动捕获外部点击，
   必须装 `IMessageFilter` 显式处理「点菜单以外的任何地方」和 `Esc`。

## 状态异步回填

菜单**先弹出来**，状态行显示当时的判断，随后 40ms 的定时器用 `TcpClient`
探测端口（约 35ms）并回填「运行中 / 未运行」。所以既有「立刻出现」，
又不丢状态显示。

## 启动必须带 `--no-open`

`dsh web` **默认自己会打开浏览器**（日志里的 `dsh web: opening the default browser`）。
启动器在端口就绪后也会开一次，两边都开就一次点击冒出两个标签 ——
这是「一次弹两个」的主要根因。

## 浏览器去重

3 秒内不重复开（跨进程文件时间戳，因为每次点击都是新进程）。
需求是「每次点击只开 1 个」，**不是**「全局只留 1 个」—— 旧标签与新标签能共存，
所以不去找、不去切已有标签。

## 性能相关的实现细节

- **端口探测用 `TcpClient` 直连**（35ms），不用 `Get-NetTCPConnection`（1886ms）
- **进程匹配用严格正则**：`@deepseek-ai[\\/]+dsh[\\/]+lib[\\/]+bin\.js"?\s+web\s*$`。
  宽松匹配会撞上「命令行里恰好含该模式」的无关进程，导致永远不启动且毫无报错
- 等待端口就绪用 100ms 间隔轮询

## 日志

`~/.dsh/logs/dsh-web.log` —— dsh 自身的 stdout/stderr，由启动器转发。
