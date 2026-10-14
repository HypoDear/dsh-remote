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
| 手机切换权限档位 | 需先在桌面插件设置中单独授权 |
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

## 兼容性

验证于 DSH `0.2.0-rc.2`。插件跟随上游客户端协议的节奏，
上游协议或中继策略变更时可能失效。

## 许可

本仓库不附带许可文件。
