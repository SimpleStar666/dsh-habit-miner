/**
 * dsh-habit-miner — browser half.
 *
 * Adds one right-Sidebar tab type, `habit-miner`, that lists the habit candidates
 * the Host half mined from corrections, plus the rules already written into an
 * AGENTS.md. The panel is the human gate described in docs/DETAIL.md: nothing is
 * written to a rule file without a click here (or an explicit "yes" the model
 * passes to habit_accept).
 *
 * Written as a hand-authored ModuleLoader bundle: no build step, no dependency
 * beyond the `react` the shell already provides. Colours come from theme
 * variables so the panel follows light/dark.
 */

window.__ModuleLoader__.load({
  id: 'dsh-habit-miner',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useState } = React

    const NS = 'habitMiner'
    const KIND = 'habit-miner'
    const ID = 'dsh-habit-miner'
    const STATE_PATH = '/api/habit-miner/state'
    const ACTION_PATH = '/api/habit-miner/action'

    const DICT = {
      zh: {
        'type.label': '习惯',
        'guide.title': '习惯规则',
        'guide.description': '把反复纠正你的做法变成规则',
        pending: '待确认',
        applied: '已生效',
        observing: '观察中',
        scan: '扫描历史',
        scanning: '扫描中…',
        reload: '刷新',
        accept: '采纳',
        edit: '改一下',
        save: '保存并采纳',
        cancel: '取消',
        reject: '忽略',
        revoke: '撤销',
        scopeGlobal: '全局',
        scopeWorkspace: '本工作区',
        evidence: '证据',
        support: '支持 {count} 次',
        sessions: '{count} 个会话',
        confidence: '置信度 {value}',
        conflict: '与已生效的规则冲突，需要你定夺',
        conflictWith: '冲突：{text}',
        emptyPending: '还没有待确认的习惯',
        emptyPendingBody: '当你在对话里反复纠正同一件事，它会在这里排队；确认后才写进 AGENTS.md。',
        emptyApplied: '还没有写进规则的',
        emptyAppliedBody: '采纳的规则会按「全局」或「本工作区」写进对应的 AGENTS.md，段落由插件维护，可逐条撤销。',
        observingHint: '还有 {count} 条证据不够的候选在观察中',
        scanHint: '第一次可以先「扫描历史」，把过去的纠正挖出来。',
        noHistory: '这个环境没有会话历史接口，只能从新对话里收集。',
        wrote: '已写入 {file}',
        effectHint: 'DSH 没有 watcher：下次读取该目录或新开会话时才生效。',
        errorPrefix: '出错了：{message}',
        loading: '读取中…',
        retry: '重试',
        storeHint: '数据目录：{path}',
      },
      en: {
        'type.label': 'Habits',
        'guide.title': 'Habit rules',
        'guide.description': 'Repeated corrections turned into rules',
        pending: 'To confirm',
        applied: 'In effect',
        observing: 'Observing',
        scan: 'Scan history',
        scanning: 'Scanning…',
        reload: 'Reload',
        accept: 'Accept',
        edit: 'Edit',
        save: 'Save as rule',
        cancel: 'Cancel',
        reject: 'Dismiss',
        revoke: 'Revoke',
        scopeGlobal: 'Global',
        scopeWorkspace: 'This workspace',
        evidence: 'Evidence',
        support: '{count} times',
        sessions: '{count} sessions',
        confidence: 'Confidence {value}',
        conflict: 'Conflicts with a rule already in effect — decide it yourself',
        conflictWith: 'Conflict: {text}',
        emptyPending: 'No habits waiting',
        emptyPendingBody: 'Repeat the same correction across conversations and it queues here. Nothing is written to AGENTS.md until you confirm it.',
        emptyApplied: 'Nothing written yet',
        emptyAppliedBody: 'Accepted rules go to the matching AGENTS.md as a plugin-maintained block; each one can be revoked.',
        observingHint: '{count} candidates still gathering evidence',
        scanHint: 'Start with Scan history to mine past corrections.',
        noHistory: 'This environment has no session-history service, so habits are collected from new conversations only.',
        wrote: 'Written to {file}',
        effectHint: 'DSH has no watcher: the rule applies when that directory is read next or in a new session.',
        errorPrefix: 'Failed: {message}',
        loading: 'Loading…',
        retry: 'Retry',
        storeHint: 'Data folder: {path}',
      },
    }

    const CSS = `
.hbm{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#111);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}
.hbm-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));flex:none}
.hbm-counts{flex:1 1 auto;min-width:0;display:flex;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums;overflow:hidden;white-space:nowrap}
.hbm-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;box-sizing:border-box;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.hbm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.hbm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}
.hbm-btn[disabled]{opacity:.5;cursor:default}
.hbm-btn-primary{border-color:var(--dsw-alias-state-business-primary,#4c8dff);color:var(--dsw-alias-state-business-primary,#4c8dff)}
.hbm-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 0 10px}
.hbm-section{padding:2px 10px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);letter-spacing:.02em}
.hbm-card{margin:6px 10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-secondary,#fafafa)}
.hbm-draft{font-size:13px;color:var(--dsw-alias-label-primary,#111);word-break:break-word}
.hbm-textarea{width:100%;box-sizing:border-box;min-height:52px;resize:vertical;font:inherit;font-size:13px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.2));background:var(--dsw-alias-bg-primary,#fff);color:inherit}
.hbm-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.hbm-chip{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.hbm-chip-warn{background:rgba(255,170,0,.16);color:var(--dsw-alias-state-warning-primary,#a06000)}
.hbm-evidence{margin-top:6px;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
.hbm-evidence-item{margin:2px 0;font-size:11px;color:var(--dsw-alias-label-secondary,#666);word-break:break-word}
.hbm-evidence-time{color:var(--dsw-alias-label-tertiary,#999);margin-right:4px}
.hbm-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.hbm-status{padding:16px 12px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888)}
.hbm-status p{margin:0 0 6px}
.hbm-status p:last-child{margin-bottom:0}
.hbm-title{color:var(--dsw-alias-label-primary,#111);font-weight:600;margin-bottom:4px!important}
.hbm-note{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}
.hbm-rule{display:flex;gap:8px;align-items:flex-start;margin:6px 10px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-secondary,#fafafa)}
.hbm-rule-text{flex:1 1 auto;min-width:0;font-size:12px;word-break:break-word}
.hbm-rule-scope{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}
`

    /**
     * Format an ISO timestamp as a short relative time.
     *
     * @param {string} iso
     * @returns {string}
     */
    function relativeTime(iso) {
      const value = Date.parse(String(iso ?? ''))
      if (!Number.isFinite(value)) return ''
      const diff = Date.now() - value
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
      return `${Math.round(diff / 86_400_000)} 天前`
    }

    /**
     * Call one of this plugin's own JSON endpoints.
     *
     * @param {string} path
     * @param {object} [init]
     * @returns {Promise<object>}
     */
    async function callJson(path, init) {
      const response = await window.fetch(path, {
        method: init?.method ?? 'GET',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        const message = payload && payload.error ? payload.error : `请求失败（HTTP ${response.status}）`
        throw new Error(message)
      }
      return payload
    }

    /**
     * One candidate card: draft, evidence, meta and the human gate buttons.
     *
     * @param {object} props
     * @returns {any} React element
     */
    function CandidateCard(props) {
      const { item, t, busy, onAccept, onReject, onHide, workspace } = props
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(item.draft)
      const [scope, setScope] = useState(item.scope === 'workspace' && workspace ? 'workspace' : 'global')

      useEffect(() => {
        setDraft(item.draft)
      }, [item.draft])

      const scopeLabel = (value) => (value === 'workspace' ? t('scopeWorkspace') : t('scopeGlobal'))
      const canWorkspace = Boolean(workspace)

      return h('div', { className: 'hbm-card' },
        editing
          ? h('textarea', {
            className: 'hbm-textarea',
            value: draft,
            maxLength: 200,
            onChange: (event) => setDraft(event.target.value),
          })
          : h('div', { className: 'hbm-draft' }, item.draft),

        h('div', { className: 'hbm-meta' },
          h('span', { className: 'hbm-chip' }, t('sessions', { count: item.sessions })),
          h('span', { className: 'hbm-chip' }, t('support', { count: item.support })),
          h('span', { className: 'hbm-chip' }, scopeLabel(scope)),
          item.conflict ? h('span', { className: 'hbm-chip hbm-chip-warn' }, t('conflict')) : null),

        item.evidence.length
          ? h('div', { className: 'hbm-evidence' },
            item.evidence.map((entry, index) => h('div', { className: 'hbm-evidence-item', key: `${entry.at}-${index}` },
              h('span', { className: 'hbm-evidence-time' }, relativeTime(entry.at)),
              entry.userText)))
          : null,

        h('div', { className: 'hbm-actions' },
          h('button', {
            className: 'hbm-btn hbm-btn-primary',
            disabled: busy,
            onClick: () => onAccept({
              id: item.id,
              text: editing ? draft : undefined,
              scope: canWorkspace ? scope : 'global',
              workspace: scope === 'workspace' ? workspace : undefined,
            }),
          }, editing ? t('save') : t('accept')),
          h('button', {
            className: 'hbm-btn',
            disabled: busy,
            onClick: () => {
              if (editing) {
                setDraft(item.draft)
                setEditing(false)
              } else {
                setEditing(true)
              }
            },
          }, editing ? t('cancel') : t('edit')),
          canWorkspace
            ? h('button', {
              className: 'hbm-btn',
              disabled: busy,
              onClick: () => setScope(scope === 'global' ? 'workspace' : 'global'),
            }, scope === 'global' ? `→ ${t('scopeWorkspace')}` : `→ ${t('scopeGlobal')}`)
            : null,
          h('button', {
            className: 'hbm-btn',
            disabled: busy,
            onClick: () => onReject(item),
          }, t('reject')),
          onHide
            ? h('button', {
              className: 'hbm-btn',
              disabled: busy,
              onClick: () => onHide(item),
            }, '×')
            : null))
    }

    /**
     * One accepted rule row with its revoke control.
     *
     * @param {object} props
     * @returns {any} React element
     */
    function RuleRow(props) {
      const { rule, t, busy, onRevoke } = props
      return h('div', { className: 'hbm-rule' },
        h('div', { className: 'hbm-rule-text' }, rule.text),
        h('div', { className: 'hbm-rule-scope' }, rule.scope === 'workspace' ? t('scopeWorkspace') : t('scopeGlobal')),
        h('button', {
          className: 'hbm-btn',
          disabled: busy,
          onClick: () => onRevoke(rule),
        }, t('revoke')))
    }

    /**
     * The tab body.
     *
     * @param {any} props composed slot props
     * @returns {any} React element
     */
    function HabitBody(props) {
      const { t } = props
      const sessionId = props.sessionId
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [scanning, setScanning] = useState(false)
      const [notice, setNotice] = useState(null)

      const load = useCallback(async () => {
        try {
          const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
          const next = await callJson(`${STATE_PATH}${query}`)
          setState(next)
          setError(null)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        }
      }, [sessionId])

      useEffect(() => {
        load()
      }, [load])

      const act = useCallback(async (action, payload) => {
        setBusy(true)
        setNotice(null)
        try {
          const next = await callJson(ACTION_PATH, {
            method: 'POST',
            body: { action, sessionId, ...payload },
          })
          if (next.state) setState(next.state)
          else await load()
          if (next.message) setNotice(next.message)
          setError(null)
          return next
        } catch (cause) {
          setError(cause?.message ?? String(cause))
          return null
        } finally {
          setBusy(false)
        }
      }, [load, sessionId])

      const scan = useCallback(async () => {
        setScanning(true)
        setNotice(null)
        try {
          const next = await callJson(ACTION_PATH, {
            method: 'POST',
            body: { action: 'scan', sessionId },
          })
          if (next.state) setState(next.state)
          if (next.scan?.ok === false) {
            setNotice(next.scan.reason === 'no-session-query' ? t('noHistory') : String(next.message ?? next.scan.reason))
          } else if (next.message) {
            setNotice(next.message)
          }
          setError(null)
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setScanning(false)
        }
      }, [sessionId, t])

      if (!state) {
        return h('div', { className: 'hbm-status' },
          error ? h('p', null, t('errorPrefix', { message: error })) : h('p', null, t('loading')),
          error ? h('button', { className: 'hbm-btn', onClick: load }, t('retry')) : null)
      }

      const workspace = state.agents?.workspace ?? null
      const pending = state.pending ?? []
      const applied = state.applied ?? []
      const counts = state.counts ?? {}

      return h('div', { className: 'hbm' },
        h('div', { className: 'hbm-head' },
          h('div', { className: 'hbm-counts' },
            `${t('pending')} ${counts.pending ?? 0} · ${t('applied')} ${counts.accepted ?? 0}`),
          h('button', {
            className: 'hbm-btn',
            disabled: scanning || busy,
            onClick: scan,
          }, scanning ? t('scanning') : t('scan')),
          h('button', { className: 'hbm-btn', disabled: busy, onClick: load }, t('reload'))),

        notice ? h('div', { className: 'hbm-note' }, notice) : null,
        error ? h('div', { className: 'hbm-note' }, t('errorPrefix', { message: error })) : null,

        h('div', { className: 'hbm-list' },
          pending.length === 0
            ? h('div', { className: 'hbm-status' },
              h('p', { className: 'hbm-title' }, t('emptyPending')),
              h('p', null, t('emptyPendingBody')),
              state.capabilities?.backfill ? h('p', null, t('scanHint')) : h('p', null, t('noHistory')),
              counts.observing ? h('p', null, t('observingHint', { count: counts.observing })) : null)
            : h('div', null,
              h('div', { className: 'hbm-section' }, `${t('pending')} ${pending.length}`),
              pending.map((item) => h(CandidateCard, {
                key: item.id,
                item,
                t,
                busy,
                workspace,
                onAccept: (payload) => act('accept', payload),
                onReject: (target) => act('reject', { id: target.id }),
                onHide: (target) => act('hide', { id: target.id }),
              }))),

          applied.length
            ? h('div', null,
              h('div', { className: 'hbm-section' }, `${t('applied')} ${applied.length}`),
              applied.map((rule) => h(RuleRow, {
                key: rule.id,
                rule,
                t,
                busy,
                onRevoke: (target) => act('revoke', { id: target.id }),
              })))
            : null,

          applied.length === 0
            ? h('div', { className: 'hbm-status' },
              h('p', { className: 'hbm-title' }, t('emptyApplied')),
              h('p', null, t('emptyAppliedBody')))
            : null,

          h('div', { className: 'hbm-note' }, t('storeHint', { path: state.storeDir ?? '' }))))
    }

    /**
     * Mount the browser half.
     *
     * @param {any} ctx client Cordis context
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICT), 'habit-miner: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', ID)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'habit-miner: styles')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: () => t('type.label'),
        guide: [{
          id: 'habits',
          order: 30,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
        }],
      }), 'habit-miner: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, HabitBody)), 'habit-miner: tab body')
    }

    exports.name = 'habit-miner-client'
    exports.inject = ['slots', 'locale', 'sidebarRightTabs']
    exports.apply = apply
    exports.__test = { relativeTime, KIND, ID }
    return module.exports
  },
})
