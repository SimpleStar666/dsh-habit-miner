# 习惯挖掘器 dsh-habit-miner

把你在对话里反复纠正 AI 的做法，整理成 `AGENTS.md` 规则。只提议、不自动写；每条都要你确认，写进去的都能撤销。

右侧栏多一个「习惯」页：待确认候选、证据原话、已生效规则和撤销按钮都在那里。

## 安装

这个包没有发布到 npm，所以用**本地目录**装：

1. 把整个 `dsh-habit-miner` 目录放到那台电脑上（比如 `D:\code\dsh-habit-miner`）
2. 打开 DSH 侧栏「插件」页 → **添加插件** → 箭头 → **安装第三方插件** → 填这个目录的绝对路径
3. 提示要重启就完全退出 DSH 再打开（只关窗口不算）

或者终端：

```powershell
dsh plugin --profile <profile名> add file:D:\code\dsh-habit-miner
```

装完不需要配置。第一次激活后会在 8 秒内自动回填一次最近 30 天的会话，也可以在面板点「扫描历史」。

## 用法

入口：右侧栏顶部的 **+**（新标签页）→ **习惯规则**；也可以从右栏引导页里的「习惯规则」进。

装好后如果右栏没有这一项，**重新加载页面**（Desktop 里按 Ctrl+R，或重启 DSH）——客户端插件是页面加载时载入的。

- 正常聊天。你纠正 AI 的话会在回合结束时被记下来（纯本地规则匹配，不调模型）。
- 同一件事跨**两个会话**出现，才会进「待确认」。
- 在面板里：**采纳** 写进规则文件；**改一下** 先改措辞；**→ 本工作区** 切换写入位置；**忽略** 后 30 天内同类不再出现。
- 已生效的规则可以随时**撤销**。

## 配置

改 `~/.dsh/habit-miner/config.json`（没有就用默认值），或用 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: dsh-habit-miner
  name: dsh-habit-miner
  config:
    minSessions: 2      # 出现在几个会话才算习惯
    scanDays: 60        # 回填窗口
    scopeDefault: global # 默认写全局还是本工作区
    injectHint: true    # 有候选时在系统提示里加一行状态
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `capture` | `true` | 回合结束时收集纠正 |
| `minSessions` | `2` | 跨几个会话才升级成候选 |
| `minSupport` | `2` | 至少出现几次 |
| `maxPending` | `60` | 待确认队列上限 |
| `scanOnFirstRun` | `true` | 首次激活自动回填 |
| `scanDays` | `30` | 回填窗口（天） |
| `scanMaxSessions` | `60` | 单次回填最多会话数 |
| `scopeDefault` | `global` | 新规则的默认落点 |
| `injectHint` | `true` | 有候选时注入一行提示 |
| `debugLog` | `false` | 往数据目录写 debug.json |

数据目录：`~/.dsh/habit-miner/`（`DSH_HOME` 可覆盖）。

## 设计

- **零依赖、零构建**：Host 是纯 ESM，浏览器半身是手写的 `__ModuleLoader__` bundle，只依赖宿主自带的 React。
- **确认制**：任何模型输出都不会直接变成行为；没有你点头，规则文件一个字节都不会变。
- **可撤销**：写入前快照，段落按 id 维护，撤销只删那一条。
- **不联网**：相似度用 SimHash + 字符重合度在本地算。
- **失败不挡路**：建目录、扫描、写文件失败都只记一条 warn，聊天照常。

## 开发

```powershell
node --test test/*.test.mjs      # 26 个单元测试
node tools/check-plugin-contract.mjs
node --check client.js
```

## License

MIT
