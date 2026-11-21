# 推广手册

技术不是瓶颈。96 条补丁、三套量化数据、三档引擎——这些不输任何同类项目。缺的是**没人知道你存在**。

---

## 现状

| 项 | 数值 |
|---|---|
| Stars | 2 |
| 同赛道头部项目 | 291 |
| 同赛道中型项目 | 56 |
| 差距原因 | 不在技术，在入口 |

**291 stars 那个做对了什么**：GitHub Pages 官网 + Telegram 群 + 4 个 B站链接 + Discussions。

---

## 已完成（不需要你再动手）

- ✅ GitHub Pages 落地页 → https://yushang657.github.io/DSH-YS-pojia/
- ✅ homepage 字段已设置（仓库标题下方显示）
- ✅ topics 扩到 20 个（含 `dsh-pojia` / `pojia` / `jailbrake` 蹭搜索）
- ✅ Discussions 已开启
- ✅ README 加了「与其他项目区别」章节（中英双语）
- ✅ description 含 14 个搜索关键词（338 字符）
- ✅ B站第 1 期视频脚本 → `docs/promo/bilibili-ep1.md`

---

## 待你做（按投入产出比排序）

### 第一优先：B站视频

脚本已经写好，在 `docs/promo/bilibili-ep1.md`。

**为什么最优先**：中文技术圈看 B站，不看 GitHub Trending。291 stars 那个有 4 个 B站链接，这是它主要流量来源。

**做什么**：
1. 装 OBS，录终端跑 `node bench.mjs --set benign --verbose`
2. 按脚本念旁白（不用露脸）
3. 封面三行大字：「破甲后 / 模型变笨了吗 / 12 个题实测」

**预期**：第一条视频 500-2000 播放，能带来 5-20 stars。

---

### 第二优先：垂直社区投放

按这个顺序发，每个改一下措辞避免被识别为纯广告。

**V2EX · `/go/security`**

标题：`我做了一个 DSH 破甲插件，附横向评测数据`

正文：
```
DSH（DeepSeek Harness）的破甲插件，做了几个月。

核心是三件事：
1. 宿主层 96 条补丁，覆盖 70 个文件
2. 消息层历史拒绝清洗（标准/强制两档）+ assistant 预填充
3. 三档引擎可切换，每档标注降智程度

量化评测：39 类 x 56 探针，0-100 分 8 档。
gpt-6.1-sol 实测 ASR 46.2%，pass@N 76.9%，良性能力损耗 Δ=0（12 个基础题 8/8 全对）。

横向对比了同赛道的三个技术路线，客观差异在 README 里。

https://github.com/yushang657/DSH-YS-pojia
https://yushang657.github.io/DSH-YS-pojia/

仅供授权安全研究。
```

**吾爱破解 · 逆向工程版**

同样内容，但开头加一段技术细节（那边喜欢看实现）：

```
补丁是按宿主源码字符串匹配的，所以 DSH 一升级就静默失效——不报错，但破甲没了。
这个坑我踩了很久。后来做了三档降级：T3 补丁失效能退到 T2 边界改写，再退到 T1 纯提示词，
不会整个破甲消失。

另一个坑：消息层的历史清洗会被 mtime 判据覆盖回去。磁盘文件比加密槽旧时，
插件判定「盘上是旧一代」然后覆盖——改了源文件、重新密封、三个 home 都落盘，
控制台里还是旧内容。后来在部署脚本里加了 touch 解决。
```

**Reddit · r/LLMDevs + r/LocalLLaMA**

英文版，强调 benchmark 方法论：

```
Title: I built a DSH breach plugin and benchmarked three approaches — here's the data

Three stacked layers: 96 host patches, message-layer refusal scrubbing, prompt injection.
39 categories × 56 probes, scored 0-100 in 8 bands by information density.

gpt-6.1-sol: ASR 46.2%, pass@N 76.9%, benign capability cost Δ=0 (12 basic tasks, 8/8 correct).

Comparison with two other approaches in this space (one host-patch only, one request-boundary only):
https://github.com/yushang657/DSH-YS-pojia

The interesting part for this sub might be the scoring design — pure ASR is binary and
counts "framework given but details blurred" as success. I use 8 bands instead.
Happy to discuss why.
```

---

### 第三优先：建群

B站视频里挂链接，然后建群。

**Telegram**（中文破甲圈主要在 TG）：
- 群名：`DSH 破甲交流`
- 简介：`YS-pojia 插件讨论 / 破甲评测数据 / 问题反馈`

**QQ 群**：同上，B站观众更习惯 QQ。

---

### 第四优先：持续更新

GitHub 会推给 watchers。每周一次小更新（文档、探针、bug fix）就够。

---

## 蹭竞品流量的技巧（已做）

这些是「别人搜竞品名时能命中你」的手段：

| 手段 | 状态 |
|---|---|
| topics 含 `dsh-pojia` / `pojia` | ✅ |
| topics 含 `jailbrake`（常见拼错） | ✅ |
| README 对比章节提到竞品全名 | ✅ |
| description 含 `jailbreak` / `breach` | ✅ |

**还可以做的**：在同类项目的 Issues / Discussions 里，遇到版本兼容类问题时客观回复自己的方案。不要硬广，只在真的能解决问题时提。

---

## 数据追踪

每周看一次这几个数：

```bash
curl -s https://api.github.com/repos/yushang657/DSH-YS-pojia | jq '{stars: .stargazers_count, forks: .forks_count, watchers: .subscribers_count}'
```

Pages 访问量：仓库 → Insights → Traffic。

---

## 一句话总结

**你已经有一个技术指标不输任何同类的项目。现在要做的只有一件事：让需要它的人知道它存在。**
