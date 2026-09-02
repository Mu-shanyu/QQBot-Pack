# QQBot 一键封装包（QQBot-Pack）

事情的起因是这样：前几天跟大肥鱼聊的起劲，就想着怎么给他弄到手机上来，结果等我整完之后，我才想起来可以先上github上参考一下,等我来搜的时候发现果然真的很多，但是我用他们的话，那我的不白做了，干脆就也上传了，希望各位路过的佬佬们，给小资历提提意见

**基于 DeepSeek Harness 的 QQ 群 AI 机器人一键封装包** —— 我的第一个开源学习项目，新人作品，欢迎指正 🐟

> 拿到**完整可运行包**（见本仓库 Releases 附件，约 319MB）→ 装好 Node.js → 填自己的 QQ 小号和 DeepSeek API Key → 双击启动 → 你的 QQ 小号就变成群里一个会聊天的 AI 机器人。

## 这是什么 / 不是什么

**是什么**：一个"绿色目录包"，把下面几样东西封装成拷走就能用：

| 组件 | 作用 | 作者 |
|---|---|---|
| [NapCat](https://github.com/NapNeko/NapCatQQ) | QQ 协议端（OneBot v11），登录你的 QQ 小号 | NapNeko 社区 |
| [DeepSeek Harness](https://github.com/deepseek-ai/dsh) | DeepSeek 开源的本地 AI 工作台（Web 控制台 + 本地 API 网关）——**本包基于它运行 AI 对话** | DeepSeek |
| `app/bridge` + `app/webui` + 启动脚本 + 文档 | 消息桥接、本地管理台、一键启动、给非技术用户的说明 | **我（新人）** |

**不是什么**：我不是 NapCat / DeepSeek Harness 的作者，也没有重写 QQ 协议端或 AI 模型。
我做的是**基于 DeepSeek Harness 之上的封装、桥接、管理界面与文档**，让不熟悉命令行的人也能双击跑起自己的群机器人。代码或有粗糙之处，欢迎通过 Issue / PR 指正。

## 功能

- 群里 @ 机器人 → 必回；聊到感兴趣的话题 → 主动插嘴；金钱/隐私话题（转账、密码、验证码…）→ 安静闭嘴；
- 每分钟限频，结合最近群聊上下文判断"值不值得插嘴"，像真人一样克制、不刷屏；
- 本地管理台（`http://127.0.0.1:3210`）：四张服务状态卡、群白名单/回复规则网页热改、日志查看、一键重启；
- 掉号自动重登看门狗（探活 → 判死 → 杀进程 → 3 秒拉起，防抖防风控）、断线自动重连、单实例锁防重复回复；
- 每群独立 AI 会话（记忆隔离）；人设文件外置——改 `persona\我的机器人.txt` 就能换一个"性格"。

## 快速开始（完整包，见 Releases）

1. 安装 Node.js 22+（https://nodejs.org）；
2. 解压完整包，双击 `首次配置.bat`（自动安装 DeepSeek Harness 依赖，首次需联网，已走国内镜像）；
3. 用记事本填 `config\bridge.config.json`（群号、主人 QQ、机器人名；模板全带中文注释）；
4. 双击 `启动全部.bat`，会依次拉起 NapCat / DSH / 管理台并自动打开网页；
5. 完成两件一次性的事：
   - 在 NapCat WebUI（`http://127.0.0.1:6099/webui`）**扫码登录你的 QQ 小号**（首次/换机有验证码属正常风控）；
   - 在 DSH 控制台（`http://127.0.0.1:3080`）**填入你的 DeepSeek API Key** 并选模型；
6. 回管理台（3210）等四张卡全绿，把小号拉进群 @ 它——上线！

详细步骤与故障排查见包内 `README.txt`（5 步版）与 `docs\操作文档.txt`。

## 源码仓库结构（本仓库只含源码，不含 NapCat 运行时）

```
QQBot-Pack/
├── .gitignore / LICENSE / README.md
├── 首次配置.bat / 启动全部.bat / 停止全部.bat / 启动桥接.bat
├── README.txt                 # 给包内用户的 5 步使用说明
├── docs/操作文档.txt           # 详细技术文档（端口表/配置字段/登录引导/排障）
├── config/bridge.config.example.json   # 配置模板（留白自填）
├── persona/我的机器人.txt      # 人设模板（改成你自己的）
└── app/
    ├── bridge/    # 桥接：bridge.mjs + dsh-client.mjs（Node 内置 API，零 npm 依赖）
    ├── webui/     # 管理台：server.mjs + public/index.html
    └── dsh/       # DeepSeek Harness 运行目录（首次配置.bat 自动 npm 安装）
```

> `app/napcat/`（NapCat 运行时，含腾讯 QQ 相关二进制）**不在本仓库**——
> 完整包请从 Releases 下载。仓库保持轻量，只放我写的源码与文档。

## 技术要点

- 桥接与管理台全部使用 Node.js **内置能力**（fetch / WebSocket / http）实现，运行时**零 npm 依赖**；
- 全部服务只监听 `127.0.0.1`（本机），不对局域网/公网开放；API Key、QQ 号只存在于部署者自己电脑上；
- 踩坑实录：NapCat 官方 Node 包 v4.18.19 存在发行缺陷（wrapper.node 静态依赖缺失导致启动失败），包内已附修复版与排障文档。

## 致谢与许可

- NapCat、OneBot 协议、DeepSeek Harness 均为第三方项目，版权归各自作者所有；
- 本仓库代码以 MIT 协议开源（见 LICENSE）；
- 新人第一作，欢迎任何形式的指正与建议！
