# Rust+ 中文队伍助手

本项目基于 [alexemanuelol/rustplusplus](https://github.com/alexemanuelol/rustplusplus) 修改与适配，原作者为 Alexander Emanuelsson（alexemanuelol）及上游贡献者。本仓库由 Bestgzs 维护，采用 **GPL-3.0-or-later** 许可证；这是社区修改版。

通过本机网页管理 Rust+ 队伍信息，查看地图与队友位置，并接收中文提醒。支持简体中文、繁体中文和英文界面，以及 Discord Webhook / Bot 联动。

## 来源与本版适配

- 上游项目：[rustplusplus](https://github.com/alexemanuelol/rustplusplus)。
- 本版主要适配方向：本机网页控制台、多语言界面、Windows 启停入口，以及网页中的队伍信息、地图和 Discord 配置管理。
- 修改维护者：Bestgzs；本次公开版本整理日期：2026-10-25。最初修改所基于的上游提交尚未记录。
- 上游版权和许可声明见 [NOTICE](NOTICE)；完整许可证见 [LICENSE](LICENSE)。

## 功能

- 队友死亡提醒，附地图网格坐标；可选上线、离线提醒。
- 服务器高清地图、资源点名称、队友实时位置和最近死亡点。
- 网页队伍聊天，支持向游戏内队伍频道发送消息。
- 多服务器收藏与切换，启动后自动重连上次服务器。
- 游戏时间、昼夜倒计时、在线人数、排队人数查询与定时播报。
- Discord Webhook 单向推送，或 Bot 双向聊天、地图图片和斜杠命令。
- Steam 登录配对，或导入已有 Rust+ 配置。

## 从源码运行

主要使用环境为 Windows 10 / 11。安装 Node.js 24 或更新版本；Steam 登录配对需要 Chrome 或 Edge。

```sh
git clone https://github.com/Bestgzs/RustPlus-ZH-Web.git
cd RustPlus-ZH-Web
npm ci
npm start
```

打开 <http://127.0.0.1:3210/>。前台运行时按 `Ctrl+C` 停止后台。

Windows 安装依赖后也可双击 `Start.cmd`，它会启动后台并打开网页；双击 `Stop.cmd` 停止后台。脚本优先使用便携包内的 `runtime/node.exe`，没有时使用 PATH 中的 Node.js。仅关闭网页不会停止后台。

源码仓库不附带 `node_modules` 或 Node.js 运行时。原有便携版使用说明见 [使用说明.txt](使用说明.txt)。

## 首次配对

1. 在网页点击「打开 Steam 配对登录」，在 Steam 官方页面登录自己的账号。
2. 进入 Rust 目标服务器，打开 `ESC → Rust+ → 与服务器配对`。
3. 网页收到配对信息后自动保存并连接。
4. 按需启用死亡提醒、上线提醒、定时播报或 Discord 联动。

也可导入包含 `ip`、`port`、`playerId`、`playerToken` 的配对 JSON，或已有 Rust+ 配置 JSON。每位使用者都需要自行完成配对。

## 聊天命令

| 游戏队伍命令 | 功能 |
| --- | --- |
| `!时间` / `!time` | 游戏时间与昼夜倒计时 |
| `!人数` / `!pop` | 在线与排队人数 |
| `!位置` / `!pos` | 队友地图网格坐标 |
| `!死亡` / `!deaths` | 本次运行最近死亡记录 |
| `!队长` / `!leader` | 移交队长，需要当前账号具备队长权限 |
| `!帮助` / `!help` | 命令帮助 |

Discord Bot 支持 `/time`、`/pop`、`/pos`、`/deaths`、`/map`、`/say`、`/leader`。Webhook 方式只需填写频道 Webhook 链接；Bot 方式需要自己的 Bot Token 与频道 ID。

## 数据与运行说明

- 服务仅监听 `127.0.0.1:3210`，用于本机访问；不要直接暴露到公网。
- `data/` 保存账号配对凭据、服务器令牌、Discord 配置、浏览器资料与日志；不要上传或分享。该目录已加入 `.gitignore`。
- `pair-register.cjs` 是配对时生成的文件，已加入 `.gitignore`。
- 需要服务器支持 Rust+、账号已入队，且网络能访问 Rust+、Steam 和推送服务；Discord 联动还需要访问 Discord。
- 后台与电脑需保持运行。死亡约每 10 秒检测，断线期间可能漏报，首次连接不补发历史记录。
- Steam 配对使用专用浏览器资料目录；上游登录流程临时关闭跨站隔离以接收配对结果，完成后关闭专用窗口。

## 项目结构

| 文件 | 用途 |
| --- | --- |
| `server.cjs` | 本机 HTTP 服务、Rust+ 连接、配对与队伍同步 |
| `core.cjs` | 时间、网格坐标、队伍变化等基础逻辑 |
| `discord.cjs` | Discord Webhook、Bot 与命令处理 |
| `index.html` | 多语言网页控制台 |
| `launcher.cjs` | Windows 后台启动、网页打开与停止 |

## 许可与致谢

本项目作为 rustplusplus 的修改版，按 [GNU GPL v3 或后续版本](LICENSE) 发布。原项目及贡献者的版权归各自权利人所有，Bestgzs 的修改不改变原作者的权利。再分发时应保留版权、许可证和修改声明；分发便携版时也应同时提供对应源码及许可证。

感谢 [alexemanuelol/rustplusplus](https://github.com/alexemanuelol/rustplusplus) 和 [@liamcottle/rustplus.js](https://github.com/liamcottle/rustplus.js)。本版使用 rustplus.js 2.5.0（MIT），第三方依赖保留各自许可证。项目是非官方社区工具，与 Facepunch、Valve 或 Discord 无隶属关系。
