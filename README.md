# DSH Provider Doctor

一个只读的模型连接诊断器。当 DeepSeek Harness 里某个 provider（WorkBuddy、WorkBuddy AI、ZCode CLI）突然用不了时，它会沿着一条固定的链路逐环取证，告诉你**断在哪一环**，以及**下一步该做什么**。

它不会帮你修好，也不会替你重登、重装、改配置。它只负责把「到底哪里坏了」这件事说清楚。

## 它解决什么问题

模型用不了的时候，症状几乎都一样：发出去没有回复。但原因可能在任何一环：

- 宿主版本和插件声明的 `engines.dsh` 对不上；
- 插件装了但被禁用，或者加载时就失败了；
- provider 没有注册到 LLM 路由上（哪怕插件是 active 的）；
- 插件注册了 provider，但没在配置目录里登记，所以设置页里看不到；
- 凭据缺失、读不出、或者区域不匹配；
- 模型目录读不出来，或者读出来是空的；
- 上一次请求其实被模型拒绝了，只是没人把原因记下来。

这些环节的证据来源完全不同：前几环要靠宿主服务，中间几环要靠插件自己的诊断命令，最后几环只能看本地留下的记录。把它们混在一起猜，很容易得出「大概是网络问题」这种没用的结论。

Provider Doctor 的做法是：**每一环单独出一条结论，每条结论都标明证据来自哪里、是亲眼看到的还是推断的、什么时候看到的。**没取到证据的环节就说「没检查」，绝不当成通过。

## 诊断链路

面板里每个 provider 都按下面的顺序列出十项检查，这个顺序就是故障可能的传播方向：

| # | 检查 | 回答的问题 | 默认是否执行 |
|---|---|---|---|
| 1 | `host-runtime` | 宿主版本能满足这个插件的 `engines.dsh` 吗 | 是（只读） |
| 2 | `profile-identity` | 正在诊断的是哪个 profile，能确定吗 | 是（只读） |
| 3 | `plugin-installed` | 插件在这个 profile 里装了吗 | 是（只读） |
| 4 | `plugin-enabled` | 插件启用了吗，加载成功了吗 | 是（只读） |
| 5 | `provider-registered` | provider 注册到 LLM 路由上了吗 | 是（只读） |
| 6 | `provider-configurable` | 它在配置目录里有条目吗 | 是（只读） |
| 7 | `credential-metadata` | 凭据在本地解析得出来吗 | **否**，需要连接检查 |
| 8 | `model-catalog` | 模型目录读得出来吗，非空吗 | 是（只读） |
| 9 | `provider-diagnostic` | 插件自己的诊断命令说什么 | **否**，需要连接检查 |
| 10 | `recent-error` | 上一次请求的结局有记录吗 | 是（只读） |

第 7 和第 9 项会被标记为「需要启动进程」。在默认的基础检查里它们显示「未检查」，并且明确写着为什么没检查——而不是假装通过。

## 两个按钮，两种代价

**基础检查**（默认）

只读，不联网，不启动任何子进程。它读的是宿主内存里的服务快照、profile 的 `package.json`、以及本地留下的诊断记录。耗时通常在几十毫秒量级。

**连接检查**（需要你主动点）

在此基础上额外做两件事：

1. 调用插件自己的诊断命令——WorkBuddy 是 `doctor --json --provider <id>`，ZCode 是 `doctor --json`。这两条命令本身都不发模型请求。
2. 由此拿到凭据状态和模型目录的真实读数。

它需要启动一个 Node 子进程，所以按钮上会写明这一点。超时、取消、子进程被杀，都会被记为对应的状态，**不会**被当成「登录失败」。

ZCode 的 `turn` 和 `image` 子命令会消耗 Start Plan 额度，本插件在代码层面把它们硬性拦住了，永远不可达。

## 四种「能用」被严格区分

这是最容易混淆的地方，所以面板上分成四个独立结论：

- **插件已安装**：profile 的依赖里声明了它，或者宿主插件清单里有这一行。
- **provider 已注册**：LLM 路由里有这个 provider —— 这是唯一能说明「模型列表为什么是空的」的证据。
- **模型目录可读**：`listModels()` 返回了非空数组。注意这只说明目录读得出来，不说明账号能扣费。
- **真实生成成功**：**本插件从不测试这一项。** 分享报告里这一栏固定是 `liveInference: not-tested`，因为要测它就得真的发一次请求、真的消耗额度。

同理，`credential-metadata` 显示通过，只表示凭据在本地能被解析出来，**不表示这个 token 还有效**，也不表示它没被吊销。

## 隐私

默认情况下诊断全在本机完成，没有任何数据离开这台机器。

点「复制脱敏报告」时，生成的文本只包含：

- 插件版本、运行时版本、平台、架构；
- 每个 provider 的四个 readiness 结论；
- 每项检查的 id、状态、证据类型、来源、以及**契约里定义过的**错误码。

不包含：本机路径、用户名、账号标识、环境变量、PID、完整 URL、token、原始 stderr、聊天内容、检查摘要、下一步建议、原始细节对象。

分享文本的生成走的是同一个白名单函数，Host 端和浏览器端逐字节一致——预览里看到什么，剪贴板里就是什么，中间没有第二次转换。

面板上的绝对路径默认折叠，要看必须手动点开。

## 安装

```bash
dsh plugin install dsh-provider-doctor
```

或者手动加到 profile 的依赖里，然后重启宿主。插件通过 `cordis.patch.yml` 插入一行，行 id 是 `provider-doctor`。

安装后左侧边栏会出现一个听诊器图标，点开就是诊断面板。插件管理页里的这个 bundle 也有同样的页面。

## 兼容性

| 项目 | 范围 |
|---|---|
| DSH | `0.2.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |

`engines.dsh` 是精确钉死的单版本。宿主升级后如果范围不匹配，插件会在报告的第 1 项里明确告诉你版本对不上——而不是装死或者假装兼容。

## 开发

```bash
pnpm install
pnpm run check        # typecheck + 21 个测试文件 / 453 个用例 + build
pnpm run build        # tsdown：Host 走 ESM，Client 走 CJS + ModuleLoader 包装
```

目录结构：

```
src/
  shared/       契约、错误码、检查目录、纯快照辅助函数（Host 与 Client 共用）
  host/         宿主侧：运行时探测、插件清单、检查实现、诊断服务、HTTP 路由、鉴权
  providers/    子进程包装、最近错误读取、两个插件的适配器
  privacy/      脱敏白名单
  client/       React 面板、侧栏入口、国际化、样式
tests/          21 个 spec 文件
docs/           架构说明
```

设计上的几条硬约束：

- **绝不自造版本号。**读不到宿主版本就报「未知」，不猜。
- **绝不读凭据文件。**凭据状态只能经插件自己的 CLI 观察。
- **绝不调用 `discoverModels`。**那个接口可能联网并用真实凭据。
- **`pass` 永不带错误码。**带着码的 pass 会让人去找不存在的故障。
- **`not_checked` 不算 healthy。**没检查就是没检查。

## 许可

MIT。Tests 里用到的假件（`tests/support/`）同样在 MIT 之下。

## 相关

- [WorkBuddy Connect](https://github.com/tangyixiao/dsh-workbuddy-connect-community) —— 提供 `workbuddy` / `workbuddy-ai` 两个 provider
- [ZCode Plan Bridge](https://github.com/tangyixiao/dsh-zcode-plan-bridge) —— 提供 `zcode-cli`
