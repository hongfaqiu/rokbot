// "I'll get back to you" follow-through for local turns.
//
// Two ways a bot tells the user it will report back and then never does:
// 1. Its background work finishes and wakes it (runBackgroundWake), but the wake is a hidden,
//    silence-allowed turn: an answer written as plain assistant text is never shown. User turns
//    on this Host post such plain text (PR #21), so models learn that plain text works, and then
//    the one answer the user is waiting for is swallowed.
// 2. It promised a later report but nothing is running that would wake it (no background
//    subagent, background command or routine), for example because its Task call failed.
// The prompts below are the single nudge the Host sends in each case.

export const WAKE_PLAIN_TEXT_NUDGE_PROMPT =
  '[Delivery check] Your answer to that background result was plain assistant text, which the user never sees: ' +
  'only a real SendToUser tool call reaches them. If it is a result, answer or status the user is waiting on ' +
  '(for example something you told them you would report back on), send it now with SendToUser, leading with the ' +
  'concrete thing that finished. If it was only a note to yourself and nobody is waiting on it, end your turn now ' +
  'with no text and no SendToUser.';

export const UNBACKED_PROMISE_NUDGE_PROMPT =
  '[Follow-up check] Your last message told the user you would report back later, but nothing is running that will wake you: ' +
  'no background subagent, background command or routine is pending for this conversation, so no later turn will ' +
  'happen on its own and the user would wait forever. If you can finish the work now, do it and send the result ' +
  'with SendToUser. If you cannot, tell the user plainly with SendToUser what is and is not pending (for example ' +
  'start the background task or routine now, or ask them to check back). If your last message already fully ' +
  'answered them and nothing is actually pending, end your turn now with no text and no SendToUser.';

// A time or completion condition that turns "I'll tell you" into a promise about later.
const EN_LATER = String.raw`(?:later|soon|shortly|momentarily|in a (?:moment|minute|sec(?:ond)?|bit|few (?:minutes|moments|seconds))|once|when|after|as soon as|the moment)`;
const EN_FUTURE_I = String.raw`(?:i'?ll|i will|i'?m going to|i am going to|i shall|we'?ll|we will)`;
const EN_REPORT = String.raw`(?:let you know|tell you|update you|ping you|notify you|message you|send (?:you|it|them|the (?:results?|answer|details|report))|share (?:it|them|the (?:results?|answer|details)))`;

const EN_PATTERNS = [
  /\b(?:get|come) back to you\b/i,
  /\breport back\b/i,
  /\bcircle back\b/i,
  /\bfollow up with you\b/i,
  /\b(?:stand by|hang tight|give me a (?:moment|minute|sec(?:ond)?|bit))\b/i,
  new RegExp(String.raw`\b${EN_FUTURE_I}\b[^.!?\n]{0,80}\b${EN_REPORT}\b[^.!?\n]{0,60}\b${EN_LATER}\b`, 'i'),
  new RegExp(String.raw`\b${EN_LATER}\b[^.!?\n]{0,60}\b${EN_FUTURE_I}\b[^.!?\n]{0,40}\b${EN_REPORT}\b`, 'i'),
  // A message that ends on "let me check (on that)": the check is the next thing, and it never runs.
  /\blet me (?:check|look into|look|find out|dig into|verify|confirm)\b[^.!?\n]{0,40}[.!…]*\s*$/i,
];

const ZH_REPORT = '(?:告诉|通知|回复|告知|同步给?|发给|反馈给?|联系)(?:你|您)|汇报|回报|反馈结果';
const ZH_PATTERNS = [
  new RegExp(`(?:稍后|稍候|待会儿?|等会儿?|一会儿?|过会儿?|回头|随后|晚点|马上|很快)[^。！？\\n]{0,20}(?:${ZH_REPORT})`),
  new RegExp(`(?:完成|结束|做完|跑完|好了|搞定|出结果|有结果|有消息|有进展|弄好)(?:之后|以后|后|了|时)?[^。！？\\n]{0,20}(?:${ZH_REPORT})`),
  /请(?:稍等|稍候)|稍等(?:一下|片刻)?|等我(?:一下|查|看|确认)/,
  /我(?:先|去|这就)(?:查|看|确认|检查|核实)(?:一下|下)?[^。！？\n]{0,10}[。！…]*\s*$/,
];

/** True when a user-visible message promises a later report ("I'll get back to you", "稍后告诉你"). */
export function promisesLaterReport(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!value) return false;
  return EN_PATTERNS.some((re) => re.test(value)) || ZH_PATTERNS.some((re) => re.test(value));
}

// Tools that arrange a later wake on their own (a routine, a reminder, a scheduled wakeup).
const SCHEDULING_TOOL_RE = /routine|automation|schedul|remind|wakeup|wake_up|cron|timer/i;

/** True when one of this turn's tool calls schedules future work that will wake the bot. */
export function schedulesFutureWork(toolNames) {
  if (!Array.isArray(toolNames)) return false;
  return toolNames.some((name) => typeof name === 'string' && SCHEDULING_TOOL_RE.test(name));
}
