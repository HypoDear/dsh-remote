# dsh-remote

DSH 插件：用手机浏览器遥控桌面端 DSH 的真实工作区与会话。

插件把 DSH 的会话、模型与权限投影到公网遥控网页，因此不要求同一局域网，
手机端也不需要安装 App。电脑上的 DSH 必须保持运行并且能联网。

> 独立、实验性的第三方插件，与 DeepSeek 官方无关。
> 遥控链路上的网页与中继由第三方运营，链路只有逐跳传输加密，不属于端到端加密。

## 工作方式

```text
手机浏览器
  遥控网页
     |
  公共中继
     |
  dsh-remote 插件
     |
  DSH 桌面端：真实会话、模型、权限
```

## 功能

| 功能 | 状态 |
| --- | --- |
| 选择已共享工作区、读取真实会话、新建会话 | 支持 |
| 文本发送、回复流式显示、停止生成 | 支持 |
| 切换模型与推理强度 | 读取 DSH 实际模型目录，发送时生效 |
| 图片发送与历史预览 | PNG/JPEG/WebP/GIF，最多 4 张，每张 8 MiB |
| 手机切换权限档位 | 需先在桌面端侧边栏「远程控制」面板中单独授权 |
| 开启、停止、刷新二维码、复制链接 | 支持 |
| 网页刷新后恢复当前会话 | 支持 |
| 手机审批与结构化问答 | 本地单独授权后支持 |
| 排队、撤回编辑、删除 | 已接入 DSH Inbox |

## 安装

插件以本地目录或打包产物安装到 DSH 的 `desktop` profile。

```powershell
# 打包：在 dist/ 生成 dsh-remote-<version>.tgz
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -PackOnly

# 安装到 desktop profile（先关闭 DSH）
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

## 配对状态

配对凭据保存在 DSH 主目录下的 `dsh-remote/state.json`（权限 0600），
其中包含中继 pass hash，等同于凭据，不要外传。

`state.json` 同时记录 `deviceMid` 与当前持有者 `owner.pid`：

- **`deviceMid` 必须持久化。** 它是手机链接的组成部分（`?mid=`）。早先版本只在
  新配对时回写、resume 时不回写，且被中继 `KICKED` 时会临时换一个新的 —— 结果是
  **每次重启或每次冲突都会把你手里的链接换掉**，表现为"又失效了"。现在 mid 一经
  分配就固定，且不复因冲突而轮换。
- **同一时刻只允许一个 DSH 进程控制远程访问。** 两个进程共用一份 `state.json` 时，
  双方会拿同一个 `device_sid` 去中继注册，中继判定槽位被占并回 `KICKED`，两边互踢。
  现在启动时会写入 `owner.pid` 并回读校验，后来者不连中继，只在面板上显示
  「由其他实例接管」，避免互踢。

## 手机链接为什么能长期可用

链接由 `sid + hash + mid + t` 组成。前三者一经配对就固定；`t` 是**每次读取状态时
现算**的（不是配对那一刻冻结的值），所以：

- 复制走的链接不会因 `t` 变旧而失效；
- 中途断线重连不会改变 `sid/mid`，手机上的旧链接照样匹配到本机。

真正会主动作废旧链接的只有两处显式操作：面板上的**停止**，和**刷新链接**。

## 已知的外部依赖（无法在本插件内解决）

中继 `wss://zcode.z.ai/ws` 与遥控网页是**第三方公共服务**，不在本项目控制范围内。
上面的修复让插件自身不再主动丢弃或轮换身份，但若中继侧调整策略、清理长时间空闲的
`device_sid`、或对 `t` 增加新鲜度校验，链接仍可能失效。要完全掌握可用性需要自建中继。

## 在哪里操作

入口在**侧边栏左下角、账号头像正上方**的一行「远程控制」（带状态色圆点）。
点它展开面板，里面有全部操作：共享工作区、三个授权开关、
开启/停止、刷新链接、复制链接、显示二维码。

侧边栏收起时该行随底部区域一起隐藏（这是 DSH 的固有行为），
但标题栏左上角的「打开侧边栏」按钮始终可用，展开后即可看到。

## 兼容性

验证于 DSH `0.2.0-rc.2`。插件跟随上游客户端协议的节奏，
上游协议或中继策略变更时可能失效。

插件主体是 **host 侧代码**（`lib/index.js` → `relay.js`），由 `dsh web` 进程直接
加载并自行建立到中继的 WebSocket，**不依赖浏览器页面是否打开**。`lib/client.js`
只是侧边栏那个状态面板，关掉浏览器只会让面板不可见，不影响手机侧连接。

## 上游协议（`lib/wire.js`）与更新方法

`lib/wire.js` 是**打包产物**，不是本项目编写的代码：它由 esbuild 把 Z.ai 官方
ZCode 客户端的协议包打成单文件。没有它插件无法与遥控网页对话。

| 项 | 值 |
| --- | --- |
| 上游仓库 | <https://github.com/zai-org/ZCode>（公开） |
| 当前 pin 的 commit | `aac4755666d09fdcd70272fcf063c077a639015f` |
| 打包的包 | `packages/rpc`、`packages/client`、`packages/shared`、`packages/model-option-map` |

**上游更新后重建**（在仓库根目录执行）：

```sh
node build-vendor.mjs
```

脚本会自动从 `codeload.github.com` 下载 pin 的那个 commit 并重新打包，
**不需要 `git`，也不需要预装 `tar`**（自带纯 Node 的 tar 解包，因为 Windows 的
`bsdtar` 无法处理上游仓库里的中文文档路径）。

想换到更新的上游版本时，把脚本顶部的 `UPSTREAM_COMMIT` 改成新的 commit，
再执行一次即可；`--out` 可写到别处做对比：

```sh
node build-vendor.mjs --out /tmp/wire-check.js
```

本地已有 checkout 时用 `ZCODE_SOURCE=<路径> node build-vendor.mjs`
（该 checkout 必须正好停在 `UPSTREAM_COMMIT`）。

⚠️ 打包后脚本会做一次**命名净化**：上游用 `zcode*` 命名，本项目改为中性名，
而所有**协议必需的字面量**（中继地址、`zcode-*` 通道名、`zcode_type`、格式标记）
统一收敛到 `lib/upstream-protocol.js` 并在 `wire.js` 里 import。
所以重建后 `wire.js` 内不应出现任何 `zcode` 字样（脚本会校验并在残留时报错退出）。

## 许可

本仓库不附带许可文件。
`lib/wire.js` 打包自上游 ZCode（Apache-2.0），来源见上表。
