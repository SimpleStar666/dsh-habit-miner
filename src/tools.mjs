/**
 * Tool definitions.
 *
 * Two rules, both learned from memory plugins that got this wrong:
 *
 * 1. **Nothing is written from a tool call alone.** `habit_accept` exists so the
 *    model can act on an explicit "yes, add that rule", but the panel is the
 *    normal path; the tool still records the decision in the review ledger.
 * 2. **Descriptions are instructions.** They say when to call the tool and, more
 *    importantly, when not to: no task details, no one-off requests.
 *
 * @module dsh-habit-miner/tools
 */

/** Shared output schema for the simple acknowledgement shape. */
const ACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    message: { type: 'string', description: '给模型看的一句话结果' },
    pending: { type: 'number', description: '当前待确认条数' },
  },
};

/**
 * Build every tool spec.
 *
 * @param {object} api host operations supplied by plugin.mjs
 * @param {object} api.view current view builder
 * @param {fn} api.scan history backfill runner
 * @param {fn} api.accept accept one candidate
 * @param {fn} api.reject reject one candidate
 * @returns {object[]} author-DSL tool specs for the compiler
 */
export function createToolSpecs(api) {
  return [
    {
      name: 'habit_scan',
      description:
        '【用途】扫描最近的会话历史，找出用户反复纠正过 AI 的地方，生成待确认的习惯候选。'
        + '【什么时候用】用户问「最近我都在纠正你什么」「有没有什么规律」，或刚装好插件想先挖一遍历史时。'
        + '【不要用】不要替用户确认任何规则；扫描只入队列。',
      parameters: {
        days: { type: 'integer', description: '回看多少天，缺省用配置里的 scanDays（30）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            sessions: { type: 'integer' },
            events: { type: 'integer' },
            signals: { type: 'integer' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value?.message ?? '扫描完成' }],
      },
      execute: async (args) => api.scan(args ?? {}),
    },

    {
      name: 'habit_list',
      description:
        '【用途】列出待确认的习惯候选（含证据条数、出现在几个会话里）。'
        + '【什么时候用】用户问「有什么待确认的规则」「我最近反复纠正你什么」。'
        + '【注意】这里的 id 只能用来确认或拒绝，改了不会影响任何文件。',
      parameters: {
        status: { type: 'string', description: 'pending（缺省）或 observing（证据还不够的观察中候选）' },
        limit: { type: 'integer', description: '最多返回条数，缺省 20' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            count: { type: 'integer' },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value?.message || (value?.items ?? []).map((item) => `- ${item.id}：${item.draft}（${item.sessions} 个会话）`).join('\n'),
        }],
      },
      execute: async (args) => api.list(args ?? {}),
    },

    {
      name: 'habit_accept',
      description:
        '【用途】把一条待确认候选写成 AGENTS.md 规则（会先快照，可撤销）。'
        + '【什么时候用】用户明确说「这条对，记下来」「以后都这样」并指着某个 id 时。'
        + '【注意】没拿到用户明确同意就不要调用；写完还要说明「下次会话或下次读取该目录后生效」。',
      parameters: {
        id: { type: 'string', description: '候选 id，先用 habit_list 查', required: true },
        text: { type: 'string', description: '要写入的规则文本；不改就留空，用候选里的草稿' },
        scope: { type: 'string', description: 'global（写 ~/.dsh/AGENTS.md）或 workspace（写当前工作区的 AGENTS.md）' },
      },
      output: { schema: ACK_SCHEMA, render: (_args, value) => [{ type: 'text', text: value?.message ?? '已写入' }] },
      execute: async (args) => api.accept(args ?? {}),
    },

    {
      name: 'habit_reject',
      description:
        '【用途】忽略一条候选。'
        + '【什么时候用】用户说「这条不对」「别记这个」时。'
        + '【注意】忽略后同类候选 30 天内不会再出现。',
      parameters: {
        id: { type: 'string', description: '候选 id', required: true },
        reason: { type: 'string', description: '可选：用户为什么不要它' },
      },
      output: { schema: ACK_SCHEMA, render: (_args, value) => [{ type: 'text', text: value?.message ?? '已忽略' }] },
      execute: async (args) => api.reject(args ?? {}),
    },
  ];
}
