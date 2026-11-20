# APIConnect for Magpie

在 Magpie 里调用 APIConnect 模型、查看套餐用量或钱包余额。先安装插件，再按手里的 Key 选择登录方式。

```shell
magpie plugin add https://github.com/heyduanping/magpie-apiconnect
magpie plugin
magpie plugin login apiconnect
```

首次安装后看到 `on`、`0 models` 和 `not signed in` 属于正常状态。

| 我的情况 | 登录时怎么选 | 登录后会看到什么 |
| --- | --- | --- |
| 我只有充值 Key | 选「API Key」，粘贴 Key | 这把 Key 可见的模型。用量接口提供钱包余额或 Key 限额时，卡片会显示对应读数 |
| 我买了套餐 | 打开官网「我的订阅 → 查看可使用套餐的 Key」，复制对应分组的有效 Key，先选「API Key」 | Key 返回的套餐、周额度和本期额度。想查看官网账号下其他套餐和钱包时，选「官网账号与套餐 API Key」 |
| 我已经手动配过 APIConnect | 保留原供应商，按上面的命令安装并登录 | 插件供应商可能名为 `apiconnect-plugin`。后续选择模型、测试、查额度都用界面显示的实际供应商 ID |

启用官网二次验证的账号可以直接使用 API Key。此版本保存一份绑定，重新登录会替换之前的绑定。

## 第一次调用

1. 打开「供应商 → APIConnect」，点击「重新获取模型」，勾选一个模型，记下实际的供应商 ID 和模型 ID。
2. 运行 `magpie provider test <供应商ID> <模型ID>`。将两个占位符替换为上一步的值。这个操作会发送真实模型请求，可能产生费用。看到成功结果后，在 Agent 中选择 `<供应商ID>/<模型ID>`。
3. 打开「观测 → 用量 → 概览」，切换到「剩余」。也可运行 `magpie quota refresh <供应商ID>`。模型列表和额度来自两个独立接口，额度读取失败时仍可测试已列出的模型。

## 读懂额度

- 每日、每周和本期窗口可能记录同一笔消费，各自对照上限看剩余。同一笔用量不要重复相加。
- 官网账号模式会核对当前 Key 的分组。标有「其他订阅」的窗口仅供查看。暂缺的窗口会标出原因，已取得的额度继续显示。
- 钱包显示 APIConnect 返回的美元余额。在 Magpie 中可使用 `magpie quota alert --balance 5` 开启余额提醒，此设置作用于 Magpie 支持的余额卡。用量卡和本地提醒不能阻止平台扣款，套餐耗尽后的结算取决于 APIConnect 的套餐和钱包规则。
- 有明确重置时间的窗口显示下次重置。当前分组只有一个有效套餐时会显示其到期时间。

## 排查问题

| 现象 | 怎么处理 |
| --- | --- |
| 登录后模型列表为空 | 重新获取模型，核对 Key 在官网所属的分组以及该分组可用的模型 |
| 模型测试提示 401、403 或模型不存在 | 核对正在使用的线路和 Key，重新获取模型，再测试列表中的确切 ID |
| 提示 429 或网络连接失败 | 限流后稍候重试。连接失败时检查 Magpie 的供应商代理和本机网络 |
| 模型可用，额度显示暂不可查 | 点击额度卡刷新，或稍后运行 `magpie quota refresh <供应商ID>`。仅返回 Key 限额时，卡片会标为「Key 额度」 |
| 官网会话过期 | 用「官网账号与套餐 API Key」重新登录，或选择只需要 Key 的登录方式 |

提交 issue 时可复制用量卡中的「接入诊断」，另附 Magpie 版本、操作步骤和 HTTP 状态码。诊断文本只含插件版本、登录方式、已知模型数量和额度读取状态。请勿附完整命令输出、API Key、邮箱、密码或会话。

## 凭据和协议

只有官网账号模式会将邮箱和密码提交给 `https://apiconnect.lol/api/v1/auth/login`。密码只用于登录，Magpie 在本机保存模型 Key 和可续期的会话。模型列表来自 `GET /v1/models`。模型请求通过 APIConnect 的 Anthropic Messages 接口发送，支持 `/v1/messages` 和 `/v1/messages/count_tokens`。插件不依赖运行时 npm 包。

[APIConnect](https://apiconnect.lol) · [Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins) · [MIT 许可证](LICENSE)
