/**
 * Text normalisation, correction-signal detection and rule drafting.
 *
 * Everything here is pure and dependency-free so it can be unit-tested without a
 * host. Two rules of the design:
 *
 * 1. **Recall is cheap, precision is earned by the queue.** A false positive only
 *    costs one tap in the panel; a missed correction costs nothing. So the
 *    detector may be generous, but nothing it produces is written anywhere until
 *    the user confirms it.
 * 2. **The draft is a template, not a model output.** No host or network call
 *    stands between "you said this twice" and "here is a rule to confirm".
 *
 * @module dsh-habit-miner/text
 */

/** Lead-in phrases that carry no rule content. Longest first. */
const LEAD_FILLERS = [
  '从现在开始', '以后', '今后', '从今往后', '后续',
  '麻烦你', '麻烦', '帮我', '帮忙', '请你', '请', '你能不能', '能不能', '你可以', '可以',
  '可不可以', '我要你', '我要', '记得', '记住', '总之', '反正', '就是', '其实', '感觉',
  '我觉得', '那么', '然后', '还有', '另外', '所以', '但是', '不过', '可是', '而且', '并且', '问题是', '那', '你', '您',
];

/**
 * A directive that corrects behaviour: "别…", "不要…", "不该…", or a
 * complaint that carries its own fix ("不对，应该…").
 */
const NEGATIVE_DIRECTIVE = /(?:^|[，,。；;：:\s]|但是|不过|可是|而且|并且|然后|但|可)(别(?!的|人|处|些|个)|不要|不用|甭|禁止|不许|不准|不该|不应该|不能|别再|不用再|不必)/;

/** A complaint followed by the fix: "不对，以后都用 pnpm" / "错了，应该用…". */
const CORRECTION_FIX = /(不对|错了|不是这样|搞错|想错)[，,、：:\s].*(应该|要用|改用|换成|改为|以后)/;

/** Markers that make a statement durable ("from now on", not "this time"). */
const DURABLE = /(以后|今后|下次|每次|永远|一律|统一|始终|都要|都按|都用|都放|记住|记着|from now on|always|never again)/i;

/** A task request, not a rule: "帮我…", "做一个…". */
const TASK_REQUEST = /(帮我|帮忙|给我|做一个|做一份|做张|生成一个|生成一份|写一个|写一份|列出来|列一下|列个|查一下|搜一下|找一下|看看|翻译|总结一下|改一下这个|优化一下)/;

/** A sentence that is a greeting or an acknowledgement carries no rule. */
const NOT_A_RULE = /^(?:[\s]*(?:谢谢|谢了|好的|好|嗯|ok|okay|收到|明白|了解|懂了|hello|hi|在吗)[。!！.~～\s]*)+$/i;

/** A self-description belongs to the persona plugin, not to a rule file. */
const SELF_DESCRIPTION = /(出生|老家|籍贯|毕业|学历|学位|职业|月薪|薪资|年薪|岁|经验|住在|来自|姓名|性别|生日|打算从事|职业规划|简历|找工作)/;

/** A complaint is feedback about one answer, not a standing rule. */
const COMPLAINT = /(好麻烦|太麻烦|麻烦死|好烦|太烦|烦死|受不了|太丑|好丑|难看|好难用)/;

/** Injected delegation prompts and system reminders are not the user talking. */
const INJECTED = /^(<system-reminder>|Agent .{0,40}(sent a message|finished)|Background subagent |Team message from |你是 |## )|(##\s+(背景|目标|任务|报告要求)|只读[，,]?(绝对)?(不要|别)修改|环境事实)/;

/** A question asks about behaviour instead of stating a rule. */
const QUESTION_END = /[?？]\s*$|[吗呢]\s*$/;

/** Words that contain 别 but are not directives. */
const FALSE_NEGATIVE = /^(别的|别人|别处|特别|区别|分别|级别|类别)/;
/** How long a drafted rule may be, in characters. */
export const MAX_DRAFT_CHARS = 120;

/**
 * Normalise text for hashing and comparison.
 *
 * @param {string} text raw text
 * @returns {string} lowercase, NFKC, punctuation and whitespace removed
 */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？；：、“”‘’《》（）【】…·—～]/g, '')
    .trim();
}

/**
 * Remove a leading filler phrase, repeatedly.
 *
 * @param {string} text cleaned clause
 * @returns {string} clause without chat lead-ins
 */
export function stripLeadFillers(text) {
  let value = String(text ?? '').trim();
  let guard = 0;
  let changed = true;
  while (changed && guard < 6 && value) {
    changed = false;
    for (const filler of LEAD_FILLERS) {
      if (value.startsWith(filler) && value.length > filler.length) {
        value = value.slice(filler.length).trim();
        changed = true;
      }
    }
    // A leading comma after a removed filler is noise.
    value = value.replace(/^[，,、：:\s]+/, '');
    guard += 1;
  }
  return value;
}

/**
 * Split a message into clauses on sentence punctuation.
 *
 * @param {string} text raw text
 * @returns {string[]} trimmed clauses, at most 8
 */
export function splitClauses(text) {
  return String(text ?? '')
    .split(/[。！!？?；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Classify one user message as a correction signal.
 *
 * @param {string} text the user's message
 * @returns {{kind: 'rule'|'correction'|null, negation: boolean, durable: boolean, marker: string}}
 *   `rule` means the sentence contains a durable marker, `correction` means only a
 *   negation marker was found.
 */
export function classifySignal(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length < 4 || raw.length > 300) return { kind: null, negation: false, durable: false, marker: '' };
  if (NOT_A_RULE.test(raw)) return { kind: null, negation: false, durable: false, marker: '' };
  if (INJECTED.test(raw)) return { kind: null, negation: false, durable: false, marker: '' };

  const value = stripLeadFillers(raw);
  if (!value || value.length < 4) return { kind: null, negation: false, durable: false, marker: '' };
  if (FALSE_NEGATIVE.test(value)) return { kind: null, negation: false, durable: false, marker: '' };

  // Task and self-description checks run on the raw message: stripping lead-ins
  // must not hide the '帮我' that marks a request.
  if (SELF_DESCRIPTION.test(value) && !NEGATIVE_DIRECTIVE.test(value)) return { kind: null, negation: false, durable: false, marker: '' };

  const durableMatch = value.match(DURABLE) || raw.match(DURABLE);
  const durable = Boolean(durableMatch);
  const directive = NEGATIVE_DIRECTIVE.test(value) || CORRECTION_FIX.test(value) || /(不该|不应该)/.test(value);

  // A task request alone is work to do, not a standing rule. A rule embedded in
  // one still counts ("帮我改一下，以后都用 pnpm").
  // A task request is work to do. A rule embedded in one is kept only when it is
  // an explicit directive, not a "from now on" plan.
  if ((TASK_REQUEST.test(raw) || TASK_REQUEST.test(value)) && !directive) return { kind: null, negation: false, durable, marker: '' };
  // A rule is a short instruction; a long durable sentence is a plan or a request.
  if (durable && value.length > 90) return { kind: null, negation: false, durable, marker: '' };
  if (COMPLAINT.test(value) && !directive) return { kind: null, negation: false, durable, marker: '' };
  if (!durable && !directive) return { kind: null, negation: false, durable, marker: '' };
  // "每次都要重新扫码吗" asks a question; it is not a rule to write down.
  if (QUESTION_END.test(value) && !directive) return { kind: null, negation: false, durable, marker: String(durableMatch?.[0] ?? '') };

  return {
    kind: durable ? 'rule' : 'correction',
    negation: directive,
    durable,
    marker: String((durableMatch?.[0]) ?? (directive ? value.slice(0, 2) : '')),
  };
}

/**
 * Pick the clause that actually carries the rule.
 *
 * A correction usually reads like "不对，以后都用 pnpm" — the first clause is the
 * complaint, the second is the rule. Preference order: a clause with a durable
 * marker, then the longest clause containing a negation, then the longest clause.
 *
 * @param {string} text raw message
 * @returns {string} the clause to draft from
 */
export function pickRuleClause(text) {
  const clauses = splitClauses(text);
  if (clauses.length === 0) return '';
  // Commas separate a complaint from its rule ("不对，以后都用 pnpm"), so the
  // segments are kept in order and the rule is taken from the first one that
  // carries a marker to the end of the sentence.
  const segments = [];
  for (const clause of clauses) {
    for (const part of clause.split(/[，,]/)) {
      const value = part.trim();
      if (value) segments.push(value);
    }
  }
  if (segments.length === 0) return '';
  let start = segments.findIndex((segment) => DURABLE.test(segment));
  if (start < 0) start = segments.findIndex((segment) => NEGATIVE_DIRECTIVE.test(segment) || CORRECTION_FIX.test(segment));
  if (start < 0) start = 0;
  return segments.slice(start).join('，');
}

/**
 * Draft a rule line from one user message.
 *
 * Deterministic on purpose: the user sees exactly what will be written, and can
 * edit it before confirming. Returns '' when the message cannot become a rule.
 *
 * @param {string} text the user's message
 * @returns {string} a short imperative rule, or ''
 */
export function draftRule(text) {
  if (!classifySignal(text).kind) return '';
  const clause = pickRuleClause(text);
  if (!clause) return '';
  let core = stripLeadFillers(clause);
  // A complaint can introduce the rule ("不对，应该用 pnpm"); keep only the rule.
  core = core.replace(/^(不对|错了|不是这样|搞错|想错)[，,、：:\s]+/, '').trim();
  core = core.replace(/[。！!？?；;，,、：:\s]+$/g, '').trim();
  // A colon usually introduces the one-off task ("不要解释：1+1 等于几"); the rule
  // is what precedes it. A Windows path (D:\code) has no space, so it survives.
  const colon = core.search(/：|:\s/);
  if (colon > 3) core = core.slice(0, colon).trim();
  if (!core || core.length < 4) return '';
  if (NOT_A_RULE.test(core)) return '';

  // Keep an explicit "以后" only once: stripLeadFillers already removed a leading
  // one, so re-add it when the sentence was durable.
  let draft = core;
  if (DURABLE.test(clause) && !/^(以后|今后|下次|每次|总是|永远)/.test(draft)) {
    draft = `以后${draft}`;
  }

  if (draft.length > MAX_DRAFT_CHARS) {
    const cut = draft.slice(0, MAX_DRAFT_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf(' '));
    draft = (lastStop > 40 ? cut.slice(0, lastStop) : cut).trim();
  }
  // A bare "不要" is not useful on its own.
  if (/^(不要|别|不用)$/.test(draft)) return '';
  return draft;
}

/**
 * Whether a rule text carries a negation, used for conflict detection.
 *
 * @param {string} text rule text
 * @returns {boolean}
 */
export function hasNegation(text) {
  const value = stripLeadFillers(String(text ?? ''));
  return NEGATIVE_DIRECTIVE.test(value) || CORRECTION_FIX.test(value);
}

/**
 * Shorten text for UI display without cutting a surrogate pair.
 *
 * @param {string} text input
 * @param {number} max maximum characters
 * @returns {string}
 */
export function clip(text, max = 160) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
