# 习惯挖掘器 dsh-habit-miner

把你在对话里反复纠正 AI 的做法，整理成 `AGENTS.md` 规则。只提议、不自动写；每条都要你确认，写进去的都能撤销。

右侧栏多一个「习惯」页：待确认候选、证据原话、已生效规则和撤销按钮都在那里。

## 安装

这个包没有发布到 npm，所以用**本地目录**装：

1. 把整个 `dsh-habit-miner` 目录放到那台电脑上（比如 `D:\code\dsh-habit-miner`）
2. 打开 DSH 侧栏「插件」页 → **添加插件** → 箭头 → **安装第三方插件** → 填这个目录的绝对路径
3. 提示要重启就完全退出 DSH 再打开（只关窗口不算）

开发时可用 `link:` 依赖让 profile 指向 checkout；普通 `file:` 或 tgz 是快照，改源码后不能假定会自动更新。Host 模块还可能被 Node 缓存，代码改动后应按 DSH 提示重组或重启；只刷新浏览器不一定够。

或者终端：

```powershell
dsh plugin --profile <profile名> add file:D:\code\dsh-habit-miner
```

装完不需要配置。第一次激活后会在约 8 秒后自动回填一次最近 60 天的会话（最多 120 个），也可以在面板点「扫描历史」。

## 升级（不需要插件自己实现更新器）

DSH 的插件管理器负责包升级。本插件没有后台自更新、下载或重启逻辑。

- **Git / npm 来源**：优先使用 DSH 插件页提供的更新操作。CLI 支持 `dsh plugin --profile <profile名> update dsh-habit-miner`（底层转发给 pnpm；实际是否有新版本取决于安装来源及锁定版本）。
- **本地 `file:` / tgz 快照**：更新 checkout 不等于更新已安装包。需要让 DSH 重新安装新快照；若当前 DSH 拒绝覆盖已安装包，则先移除包再安装，**不要删除数据目录或规则文件**。
- **开发 `link:`**：例如 `dsh plugin --profile <profile名> add link:D:\code\dsh-habit-miner`。源文件会映射到 profile，但运行中的 Host 仍可能缓存旧模块；只有已配置的 HMR/watch 能自动重载，否则完全退出并重开 DSH。
- 更新后以 DSH 返回的 reload / restart 提示为准。浏览器 Ctrl+R 只刷新客户端，不能保证 Host 代码更新。

候选、审核记录、快照保存在独立数据目录 `<DSH_HOME>/habit-miner/`，不在安装包里。仅移除/替换包不需要删除这些数据。

参考：[DSH CLI 插件管理](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/apps/cli/reference/README.zh.md)、[DSH 插件管理器](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/packages/client/ui-plugin-manager/README.md)。

### 作者发布新版本

仓库的 `plugin-index.json` 把版本绑定到 `source.commit`。只 push 新代码、但不更新索引中的版本与 commit，市场仍会安装旧提交，无法把它识别为新版本。

1. 完成测试，提升 `package.json` 版本并提交代码，得到可安装提交的 SHA。
2. 在 `plugin-index.json` 的 `versions` 加入匹配的新版本，更新 `publishTimestamp` 与 `source.commit`，保留旧版本用于回退。
3. 提交并推送索引。新索引引用上一步的代码提交，而不是尚未生成的索引提交本身。
4. 在测试 profile 验证安装/更新到新版本；不要通过删除数据目录来升级。

本地修改或源码补丁不等于已经发布；也不要在插件内另起一个绕过 DSH 的自更新器。

## 用法

入口：右侧栏顶部的 **+**（新标签页）→ **习惯规则**；也可以从右栏引导页里的「习惯规则」进。

装好后如果右栏没有这一项，**重新加载页面**（Desktop 里按 Ctrl+R，或重启 DSH）——客户端插件是页面加载时载入的。

- 正常聊天。你纠正 AI 的话会在回合结束时被记下来（纯本地规则匹配，不调模型）。
- 同一件事跨**两个会话**出现，才会进「待确认」。
- 在面板里：**采纳** 写进规则文件；**改一下** 先改措辞；**→ 本工作区** 切换写入位置；**忽略** 后 30 天内同类不再出现。
- 已生效的规则可以随时**撤销**。

## 配置

通过 DSH 的插件配置或 profile 的 `cordis.patch.yml` 配置（没有就用默认值）。插件不会读取数据目录里的 `config.json`：

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
| `scanDays` | `60` | 回填窗口（天） |
| `scanMaxSessions` | `120` | 单次回填最多会话数 |
| `scopeDefault` | `global` | 新规则的默认落点 |
| `injectHint` | `true` | 有候选时注入一行提示 |
| `debugLog` | `false` | 往数据目录写 debug.json |
| `allowToolAccept` | `false` | 允许模型通过 `habit_accept` 直接写规则；默认仅面板采纳可写。开启后仍需用户明确同意，但代码无法证明模型确实获得同意 |

数据目录：`~/.dsh/habit-miner/`（`DSH_HOME` 可覆盖）。

## 设计

- **零依赖、零构建**：Host 是纯 ESM，浏览器半身是手写的 `__ModuleLoader__` bundle，只依赖宿主自带的 React。
- **默认面板确认制**：模型调用 `habit_accept` 默认会被 Host 拒绝；由用户在面板采纳。此限制是模型工具入口的保护，不是防御拥有文件/HTTP 权限的恶意代理的安全沙箱。仅在信任模型遵循同意要求时开启 `allowToolAccept`。
- **可撤销**：写入前快照，段落按 id 维护，撤销只删那一条。
- **不联网**：相似度用 SimHash + 字符重合度在本地算。
- **失败不挡路**：建目录、扫描、写文件失败都只记一条 warn，聊天照常。

## 开发

```powershell
node --test test/*.test.mjs      # 全部单元测试
node tools/check-plugin-contract.mjs
node --check client.js
```

## License

MIT
