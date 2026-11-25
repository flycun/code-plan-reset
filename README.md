# GLM Code Plan 窗口锚定（GitHub Actions）

每天用 Cloudflare Worker 定时触发 GitHub Actions 跑 Claude Code（headless），在两个锚定点
（北京 06:00 / 11:10）各消耗一次 GLM Code Plan 套餐额度，把 5 小时窗口的**重置点**钉在上午，
让你在上午工作时段用上**两个窗口**的额度。

> Code Plan 单窗口额度较小（约 1 小时即用完），单窗口撑不满一上午。
> 本方案让重置点落在上午中间——前半段用一个窗口、后半段用另一个窗口。

## 原理

- Code Plan 的 5h 窗口是**动态滚动**的：窗口 = 该窗口内**首次套餐消耗**时刻 + 5h；到期后下次消耗启动新窗口。
- 所以**锚定调用的时刻**决定了**重置点**：`重置点 = 锚定时刻 + 5h`。
- 每天在两个锚定点（slot a 凌晨 + slot b 上午）各消耗一次 → 窗口 A/B 的开启时刻都被钉死 → 重置点可预测。

```
锚定 slot a(北京06:00) ──窗口A(5h)──▶ 重置(北京11:00)
锚定 slot b(北京11:10) ──窗口B(5h)──▶ 重置(北京16:10)
                     ↑ 上午 10-11 用 A，11:10-12:10 用 B
```

### 锚定精度：Cloudflare 主时钟 + 睡到整点

GitHub Actions 的 cron 是「尽力而为」：官方文档明说高负载（尤其整点）会延迟甚至丢任务。
实测兜底 cron 每天迟到 4~8 小时、醒来即被去重秒退，从未起过作用——**已移除 schedule 触发**。
现在唯一触发器是 **Cloudflare Worker**（`anchor-dispatch/`）：每天两次调用 `workflow_dispatch`
（带 `slot` 输入）——UTC 21:30（北京 05:30，slot a）和 UTC 02:40（北京 10:40，slot b），
run 秒级启动；job 内 `wait-until-anchor` 步骤睡到各自锚定整点
（slot a → UTC 22:00 / 北京 06:00；slot b → UTC 03:10 / 北京 11:10）再发起调用。

> 💡 仓库为 public 时 Actions 分钟免费，wait 的睡眠时间不计费（最长 ~30 分钟）。
> 若改回私有，需在「扛延迟」和「烧分钟数」（2000 min/月）之间取舍。
> ⚠️ Worker 是唯一触发器，成为新的单点：它挂了 / GH_PAT 过期，当天就没有锚定（窗口漂移），
> 排查见下方「Cloudflare 主时钟部署」的日志方式。

### 去重：缓存标记（避免重复消耗额度）

Worker dispatch 自带 3 次重试：若某次 dispatch 已成功但响应丢失，重试会多起一个 run——
重复消耗一次套餐额度、重复发一封 Trending 邮件。手动误触同理。

用 **GitHub Actions 缓存做「今天是否已锚定」的证据标记**：

- 真正完成锚定的那次 run（额度已消耗）在结束时写入标记：key = `anchor-<provider>-<slot>-<锚定日的北京日期>`
- 后续任何 run 在干活前先 `actions/cache/restore`（`lookup-only: true`，不下载内容）查这个 key
  - **命中** → 今天这个 slot + provider 已锚定过 → 跳过调用、跳过写标记、跳过发邮件
  - **未命中** → 正常执行
- GLM 与 MiniMax 各用各的 key（`anchor-glm-*` / `anchor-minimax-*`），互不影响
- 叠加 `concurrency`（`cancel-in-progress: true`）：晚到的 run 会先取消仍在睡的旧 run

判定用的是「锚定时刻对应的北京日期」，而不是 run 的启动日期——同一天同一 slot 的所有
触发算出的是同一个 key，所以能正确互相识别。

> 失败时 **fail-open**：缓存服务不可用 / 查询报错 → `cache-hit` 为空 → 照常执行锚定。
> 宁可多消耗一次额度，也不漏掉锚定。

## 上午能用多久（窗口 B 由 slot b 钉在 11:10 开启）

| 北京时间 | 10:00–11:00 | 11:10–12:10 | 12:10 之后 |
|---------|:---:|:---:|:---:|
| 额度来源 | 窗口 A（满额） | 窗口 B（满额） | ⛔ 空（等 16:10 重置） |
| 状态 | ✅ 可用 ~1h | ✅ 可用 ~1h | 无额度 |

**上午可连续满负荷用 2 小时（10:00–12:10）。** 之后到 16:10 断档——这是 5h 间隔的硬上限，
上午最多跨 2 个窗口，用不上第 3 个。

## MiniMax 窗口锚定（与 GLM 同一时刻）

同一 workflow 里有第二个 job `anchor-minimax`，**与 GLM 用同一触发（Cloudflare Worker
dispatch）、同样的“提前触发 + 睡到锚定整点”等待逻辑**，在两个锚定时刻（06:00 / 11:10）各向
MiniMax 的 Anthropic 兼容端点发一次最小调用（`ping`），把 MiniMax Coding Plan 的 5h 窗口
也钉在同样的两个重置点。两个套餐、四个窗口：

```
GLM     窗口A 06:00–11:00 │ 窗口B 11:10–16:10
MiniMax 窗口A 06:00–11:00 │ 窗口B 11:10–16:10
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
- 两个 job 各用各的去重标记（`anchor-glm-*` / `anchor-minimax-*`），互不干扰。
- 验证方式同 GLM：手动触发后看 Actions 日志是否正常返回 `ok`，再到 MiniMax 控制台
  确认用量扣减、窗口重置时间 ≈ 锚定 + 5h。

## 部署

1. **新建公开仓库**（public 时 Actions 分钟免费；secrets 不会随代码泄露，安全无虞），把本目录推上去。
2. 仓库 **Settings → Secrets and variables → Actions → Secrets**，新增：
   - `ZAI_API_KEY` = 你的 Code Plan 套餐 key
   - `MINIMAX_API_KEY` = 你的 M Plan 订阅 Key（`platform.minimax.cn/console/plan` 获取；不用 MiniMax 可不加）
3. （可选）同一页 **Variables** 里加：
   - `GLM_MODEL` = `glm-4.6`（模型名，以智谱接入指南为准）
4. 推送 `.github/workflows/glm-anchor.yml`：唯一触发器是下方部署的 Cloudflare Worker。
5. **部署 Cloudflare 主时钟**（治本，推荐），见下方详细步骤。
6. 先到 **Actions → GLM Code Plan 窗口锚定 → Run workflow**（workflow_dispatch，slot 选 `a`）
   手动跑一次验证。⚠️ 手动触发时若已过该 slot 当天锚点，会**立即以当前时刻为锚**消耗额度
   （重置点 = 现在 + 5h）；想精确锚定请等 Worker 定时触发。

### Cloudflare 主时钟部署（详细）

Worker 代码在 `anchor-dispatch/`，作用：每天 **UTC 21:30（北京 05:30，slot a）** 和
**UTC 02:40（北京 10:40，slot b）** 各调用一次 `workflow_dispatch` 秒级触发 workflow，
绕开 GitHub cron 的小时级延迟；workflow 内部睡到各自锚定整点（北京 06:00 / 11:10）才发起锚定调用。

**第 1 步：创建 GitHub PAT**

打开 [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)（Fine-grained token）：

- Repository access → **Only select repositories** → 只选本仓库
- Repository permissions → 在列表找到 **Actions**（按字母排在 Attestations 前面，可向上滚动或用搜索框）
  → 勾选后把右侧下拉从默认的 Read-only 改为 **Read and write**
- 其他权限一律不勾 → **Generate token** → 复制 `github_pat_` 开头的 token（只显示一次）
- ⚠️ **Expiration 别用默认 30 天**：过期后 Worker dispatch 收 401、当天无锚定。选 **No expiration**
  或 90 天+日历提醒；随时可在 [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)
  查有效期。换新 token 时只需 `npx wrangler secret put GH_PAT` 重新粘贴，**无需重新 deploy**。

**第 2 步：部署 Worker**

⚠️ 必须在 `anchor-dispatch` 目录里执行，否则报 `Required Worker name missing`
（Worker 名字定义在该目录的 `wrangler.toml`）：

```bash
cd anchor-dispatch
npx wrangler login                # 浏览器授权 Cloudflare 账号
npx wrangler secret put GH_PAT    # 回车后在 Enter a secret value 处粘贴 PAT
npx wrangler deploy
```

说明：

- `GH_PAT` 是密钥**变量名**，原样照抄不要替换——代码里用 `env.GH_PAT` 取值，真正的 token 是在回车后的提示里粘贴的；
- 首次部署 Worker 还不存在，wrangler 提示是否创建新 Worker 时选 **Y**；
- `wrangler.toml` 已默认 `workers_dev = false`、`preview_urls = false`：纯定时触发器不需要公开 URL，部署输出不应再出现 workers.dev 地址。

**第 3 步：确认定时器生效**

- 部署成功输出里应有 `schedule: 30 21 * * *, 40 2 * * *`（UTC，两个锚定 slot）；
- Cloudflare 控制台：[dash.cloudflare.com](https://dash.cloudflare.com) → 左侧「构建」→「计算」
  →「Workers 和 Pages」→ `code-plan-anchor-dispatch` → **「触发事件」/ Triggers**
  → 「Cron 触发器」（面板显示 UTC，北京 05:30）；
- 每次触发是否成功：「日志」标签开实时日志流，或本地 `npx wrangler tail`，触发时输出 `dispatch OK`；
- 本地手动测试（可选）：`npx wrangler dev --test-scheduled`，然后访问
  `http://localhost:8787/__scheduled?cron=30+21+*+*+*` 可立即触发一次 scheduled 事件。

**验证整条链路**：部署后次日看 GitHub Actions——应出现两个 `workflow_dispatch`
事件的 run（≈ 北京 05:30 和 10:40，`Anchor time (Beijing)` 分别 ≈ 06:00 / 11:10），
各含 GLM 与 MiniMax 两个 job；slot a 的 GLM job 会发 Trending 邮件，slot b 只发最小 ping。

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

锚定调用不只是 `ping`——**slot a（每天 06:00）** 的 GLM 锚定会抓取 **GitHub 每日热门仓库 Top 10**，
整理成 HTML 邮件发到你的 163 邮箱（slot b 只发最小 ping，只锚窗口不发邮件）。
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
  `Anchor time (Beijing)` 是否 ≈ 06:00（slot a）/ 11:10（slot b）。
- **z.ai / 智谱控制台**：套餐额度是否**扣减**、当前窗口**重置时间**是否 ≈ 锚定时刻 + 5h（约 11:00）。
  - 额度**没扣** → CI headless 调用未被识别为套餐消耗，见下方「风险」。
  - 重置时间**不对** → 锚定没生效（前窗口未到期 / 触发延迟），见「排查」。

## 调整重置点

公式：`锚定(北京) = 想要的重置点 − 5h`；Worker cron（UTC）= 锚点 − 30min。

改锚定点要改**两处**（改完 Worker 需重新 `npx wrangler deploy`）：
1. `anchor-dispatch/wrangler.toml` 的 Worker cron（锚点前 30min 触发）
2. `wait-until-anchor` 里的锚定整点（slot a `22:00:00` / slot b `03:10:00`，UTC）

| 想要的重置点 | 锚定(北京) | Worker cron (UTC) | wait 睡到 (UTC) | 上午可用时段 |
|:---:|:---:|:---:|:---:|:---:|
| 09:00 | 04:00 | `30 19 * * *` | 20:00 | 08:00–10:00 |
| 10:00 | 05:00 | `30 20 * * *` | 21:00 | 09:00–11:00 |
| **11:00**（默认） | **06:00** | **`30 21 * * *`** | **22:00** | **10:00–12:00** |

> public 仓库分钟免费，等待不计费。
> 「上午可用时段」= 重置点前后各约 1 小时（两个窗口各撑约 1h）。

## 排查 FAQ

- **重置点漂移 / 没钉住**：多半是前一天用到太晚，前一个窗口越过锚定点。
  保证前一天 24:00 前停用即可（正常作息天然满足）。
- **GitHub Actions 触发延迟**：已不依赖 schedule cron（实测每天迟到 4~8h、从未准点，已移除），
  改由 Cloudflare Worker 的 `workflow_dispatch` 秒级触发。若某天没有锚定 run，先查 Worker：
  `npx wrangler tail` 看触发日志、确认 GH_PAT 未过期，必要时手动 Run workflow 补锚。
- **run 卡在 wait 步骤直到 2h 超时被杀**：旧版 bug——cron 晚到跨过 UTC 午夜时，
  `today 22:00` 指向当天晚上而非已过的锚定点，导致傻等 ~21h 直到 timeout 被杀
  （白烧 2h 计费时长，锚定未执行，见 run #35）。
  已修复：等待时长仅当 ≤ 6h 才生效，否则一律立即执行（timeout 已放宽到 358 min）。
- **MiniMax 报 402 insufficient balance**：M Plan 订阅余额耗尽或 key 失效，去 platform.minimax.cn/console/plan 检查；修好前 MiniMax 锚定不会生效。
- **额度没扣（按量付费 / 报错）**：CI 里 headless 跑 Claude Code 是否被算作合规工具调用，智谱未明确。
  以控制台扣减为准；若不扣，本方案不成立，改用「通用按量 API」（见下）。

## ⚠️ 风险声明

- **合规灰色地带**：智谱称套餐「严禁用于自动化脚本」。技术上本方案是 Claude Code 客户端发起的
  合法工具调用（带正确 UA），但 CI headless 是否被认可，**需你部署后用控制台扣减情况实测确认**。
- **不可控因素**：Cloudflare Worker / GH_PAT 失效、智谱识别策略变化，都可能影响窗口精度。

## 备选：不追求套餐额度

若只是想「定时跑个 GLM 任务」、不在乎是否走套餐：用 z.ai **通用按量 API** 更省心——
GitHub Actions 直接 `fetch https://open.bigmodel.cn/api/paas/v4` + 通用 key，无 5h 窗口限制，几分钱/次。
