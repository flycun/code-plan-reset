# GLM Code Plan 窗口锚定（GitHub Actions）

每天凌晨用 GitHub Actions 跑一次 Claude Code（headless），消耗一次 GLM Code Plan 套餐额度，
把 5 小时窗口的**重置点**钉在上午，让你在上午工作时段用上**两个窗口**的额度。

> Code Plan 单窗口额度较小（约 1 小时即用完），单窗口撑不满一上午。
> 本方案让重置点落在上午中间——前半段用一个窗口、后半段用另一个窗口。

## 原理

- Code Plan 的 5h 窗口是**动态滚动**的：窗口 = 该窗口内**首次套餐消耗**时刻 + 5h；到期后下次消耗启动新窗口。
- 所以**锚定调用的时刻**决定了**重置点**：`重置点 = 锚定时刻 + 5h`。
- 每天凌晨跑一次最小调用 → 把窗口钉死 → 上午重置点可预测。

```
锚定(北京06:00) ──窗口A(5h)──▶ 重置(北京11:00) ──窗口B(5h)──▶ 重置(北京16:00)
                                   ↑
                         上午 10-11 用 A，11-12 用 B
```

### 锚定精度：cron 提前触发 + 睡到整点

GitHub Actions 的 cron 高峰期可延迟几分钟到几小时。为保证锚定时刻精确，workflow
在 UTC 20:00（北京 04:00）提前触发，job 内 `wait-until-anchor` 步骤睡到 UTC 22:00 整
（北京 06:00）再发起 `claude -p`：

- 触发延迟 < 2 小时 → 锚定分毫不差落在 06:00，重置点 = 11:00
- 触发更晚 → 已过锚定点，立即补跑（重置点随实际触发时刻漂移）
- 触发晚到跨过 UTC 午夜 → 同样立即补跑（等待时长上限 2h，超过视为异常立即执行）

> 💡 仓库为 public 时 Actions 分钟免费，wait 的睡眠时间不计费，可放心用 2h 提前量
> 扛 cron 延迟。若改回私有，需在「扛延迟」和「烧分钟数」（2000 min/月）之间取舍。

## 上午能用多久（重置点 = 11:00 时）

| 北京时间 | 10:00–11:00 | 11:00–12:00 | 12:00–13:00 |
|---------|:---:|:---:|:---:|
| 额度来源 | 窗口 A（满额） | 窗口 B（满额） | ⛔ 空（等 16:00 重置） |
| 状态 | ✅ 可用 ~1h | ✅ 可用 ~1h | 无额度 |

**上午可连续满负荷用 2 小时（10:00–12:00）。** 12 点后到 16:00 断档——这是 5h 间隔的硬上限，
上午最多跨 2 个窗口，用不上第 3 个。

## MiniMax 窗口锚定（与 GLM 同一时刻）

同一 workflow 里有第二个 job `anchor-minimax`，**与 GLM 用同一个 cron、同样的“提前触发 + 睡到
北京 06:00”等待逻辑**，在完全相同的时刻向 MiniMax 的 Anthropic 兼容端点发一次最小调用（`ping`），
把 MiniMax Coding Plan 的 5h 窗口也钉在 06:00 → 11:00 重置。两个套餐、四个窗口：

```
GLM     窗口A 06:00–11:00 │ 窗口B 11:00–16:00
MiniMax 窗口A 06:00–11:00 │ 窗口B 11:00–16:00
```

### 额外要加的 Secrets / Variables

| 名称 | 类型 | 值 |
|------|------|-----|
| `MINIMAX_API_KEY` | Secret | M Plan 订阅 Key（`platform.minimax.cn/console/plan` 获取） |
| `MINIMAX_BASE_URL` | Variable（可选） | 默认 `https://api.minimax.cn/anthropic`（M Plan 国内站）；国际站用户才改 `https://api.minimax.io/anthropic` |
| `MINIMAX_MODEL` | Variable（可选） | 默认 `MiniMax-M3.1-Flash`（需声明 1M 上下文时用 `MiniMax-M3.1-Flash[1m]`） |

> M Plan 接入参数已对照官方文档（platform.minimax.cn/docs/m-plan/claude-code）：认证走
> `Authorization: Bearer`，正好对应 Claude Code 的 `ANTHROPIC_AUTH_TOKEN`，与 GLM 用法一致。
> ⚠️ 国内 M Plan（`api.minimax.cn`）与国际站（`api.minimax.io`）key 不通用，别混用。

### 与 GLM job 的差异

- MiniMax job 只发最小 `ping` 调用（目的只是消耗一次额度锚定窗口），**不发 Trending 邮件**；
  想让 MiniMax 也跑 Trending 任务的话，把 `anchor-ping` 步骤的 prompt 换成
  `$(cat .github/prompts/trending.txt)` 并仿照 GLM job 加 send-mail 步骤即可。
- 验证方式同 GLM：手动触发后看 Actions 日志是否正常返回 `ok`，再到 MiniMax 控制台
  确认用量扣减、窗口重置时间 ≈ 锚定 + 5h。

## 部署（5 步）

1. **新建公开仓库**（public 时 Actions 分钟免费；secrets 不会随代码泄露，安全无虞），把本目录推上去。
2. 仓库 **Settings → Secrets and variables → Actions → Secrets**，新增：
   - `ZAI_API_KEY` = 你的 Code Plan 套餐 key
   - `MINIMAX_API_KEY` = 你的 M Plan 订阅 Key（`platform.minimax.cn/console/plan` 获取；不用 MiniMax 可不加）
3. （可选）同一页 **Variables** 里加：
   - `GLM_MODEL` = `glm-4.6`（模型名，以智谱接入指南为准）
4. 推送 `.github/workflows/glm-anchor.yml`，自动按 cron 运行。
5. 先到 **Actions → GLM Code Plan 窗口锚定 → Run workflow**（workflow_dispatch）手动跑一次验证。

## 关键配置（已对照智谱官方文档）

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://open.bigmodel.cn/api/anthropic`（Anthropic 协议，Claude Code 专用） |
| 认证 | 环境变量 `ANTHROPIC_AUTH_TOKEN` = 你的智谱套餐 API Key |
| 模型名 | `glm-4.6`（也可换 `glm-5.2` 等更新的模型） |
| OpenAI 协议端点（备用） | `https://open.bigmodel.cn/api/coding/paas/v4` |

> ⚠️ 智谱国内开放平台是 `open.bigmodel.cn`，海外 z.ai 是 `api.z.ai`，两者 key/端点不通用，别混用。

MiniMax 侧对应配置（已对照 M Plan 官方文档）：

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://api.minimax.cn/anthropic`（M Plan 国内站，默认）/ `https://api.minimax.io/anthropic`（国际站） |
| 认证 | 环境变量 `ANTHROPIC_AUTH_TOKEN` = M Plan 订阅 Key |
| 模型名 | `MiniMax-M3.1-Flash`（Go/Explore/Build 三档均可用；1M 上下文用 `MiniMax-M3.1-Flash[1m]`） |

> ⚠️ 国内 M Plan 是 `api.minimax.cn`，国际站是 `api.minimax.io`，两者 key/端点不通用，别混用。

## 每日任务：GitHub Trending 邮件

锚定调用不只是 `ping`——它每天会抓取 **GitHub 每日热门仓库 Top 10**，整理成 HTML 邮件发到你的 163 邮箱。
（任务 prompt 在 `.github/prompts/trending.txt`，可自由修改；任务 prompt 用中文随便写，不受 workflow 注册限制。）

### 额外要加的 Secrets

| Secret 名 | 值 |
|-----------|-----|
| `MAIL_USERNAME` | 发件 163 邮箱地址（如 `xxx@163.com`） |
| `MAIL_PASSWORD` | 163 邮箱 **SMTP 授权码**（不是登录密码！） |
| `MAIL_TO` | 收件邮箱（可填同一个 163 邮箱） |

### 获取 163 邮箱 SMTP 授权码

1. 登录 163 邮箱 → **设置 → POP3/SMTP/IMAP**
2. **开启**「SMTP 服务」（按提示完成短信验证）
3. 得到一串 **16 位授权码** → 这就是 `MAIL_PASSWORD`
4. 服务器 `smtp.163.com`、端口 `465`（已在 workflow 写死）

> 换 QQ 邮箱：把 workflow 里 `server` 改成 `smtp.qq.com`，授权码在 QQ 邮箱「设置 → 账户 → POP3/SMTP」开启时获取，其余不变。

## 验证（关键，别跳过）

手动触发后看两处：

- **GitHub Actions 日志**：`claude -p` 是否正常返回（非报错）、`wait-until-anchor` 末尾打印的
  `Anchor time (Beijing)` 是否 ≈ 06:00。
- **z.ai / 智谱控制台**：套餐额度是否**扣减**、当前窗口**重置时间**是否 ≈ 锚定时刻 + 5h（约 11:00）。
  - 额度**没扣** → CI headless 调用未被识别为套餐消耗，见下方「风险」。
  - 重置时间**不对** → 锚定没生效（前窗口未到期 / 触发延迟），见「排查」。

## 调整重置点

公式：`锚定(北京) = 想要的重置点 − 5h`；`cron(UTC) = 锚定时刻(UTC) − 提前约 2h`。

改锚定点要改 workflow 里**两处**：
1. `on.schedule.cron`（提前约 2 小时触发）
2. `wait-until-anchor` 里的 `today 22:00:00`（UTC 锚定整点，睡到此刻再执行）

| 想要的重置点 | 锚定(北京) | cron (UTC) | wait 睡到 (UTC) | 上午可用时段 |
|:---:|:---:|:---:|:---:|:---:|
| 09:00 | 04:00 | `0 18 * * *` | 20:00 | 08:00–10:00 |
| 10:00 | 05:00 | `0 19 * * *` | 21:00 | 09:00–11:00 |
| **11:00**（默认） | **06:00** | **`0 20 * * *`** | **22:00** | **10:00–12:00** |

> 提前量约 2 小时：扛住 GitHub Actions 高峰期的 cron 延迟（实测可达 2h+）。public 仓库分钟免费，
> 等待不计费；若为私有仓库需权衡 2000 min/月额度。
> 「上午可用时段」= 重置点前后各约 1 小时（两个窗口各撑约 1h）。

## 排查 FAQ

- **重置点漂移 / 没钉住**：多半是前一天用到太晚，前一个窗口越过锚定点。
  保证前一天 24:00 前停用即可（正常作息天然满足）。
- **GitHub Actions 触发延迟**：高峰期 cron 可能晚几分钟到几小时。延迟 < 2 小时时锚定不受影响
  （wait 步骤睡到整点）；更晚则立即补跑，重置点随实际触发时刻漂移，属正常。
- **run 卡在 wait 步骤直到 2h 超时被杀**：旧版 bug——cron 晚到跨过 UTC 午夜时，
  `today 22:00` 指向当天晚上而非已过的锚定点，导致傻等 ~21h 直到 timeout 被杀
  （白烧 2h 计费时长，锚定未执行，见 run #35）。
  已修复：等待时长仅当 ≤ 2h 才生效，否则一律立即执行（timeout 已放宽到 150 min）。
- **额度没扣（按量付费 / 报错）**：CI 里 headless 跑 Claude Code 是否被算作合规工具调用，智谱未明确。
  以控制台扣减为准；若不扣，本方案不成立，改用「通用按量 API」（见下）。

## ⚠️ 风险声明

- **合规灰色地带**：智谱称套餐「严禁用于自动化脚本」。技术上本方案是 Claude Code 客户端发起的
  合法工具调用（带正确 UA），但 CI headless 是否被认可，**需你部署后用控制台扣减情况实测确认**。
- **不可控因素**：GitHub schedule 延迟、智谱识别策略变化，都可能影响窗口精度。

## 备选：不追求套餐额度

若只是想「定时跑个 GLM 任务」、不在乎是否走套餐：用 z.ai **通用按量 API** 更省心——
GitHub Actions 直接 `fetch https://open.bigmodel.cn/api/paas/v4` + 通用 key，无 5h 窗口限制，几分钱/次。
