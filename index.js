// Hidden self-review for the final answer.
//
// The idea: a long answer is produced once and sent straight to the user, with no
// chance to re-read it. Humans do not work that way — after solving a problem they
// restate the answer and check it. This plugin gives the model the same second pass
// without asking the user's client to hold anything:
//
//   1. `llm/stream` is a waterfall around every model call. The host, not the
//      provider, owns the bytes that reach the browser, so the draft can be held here.
//   2. While the final answer streams, text chunks are buffered. Reasoning chunks,
//      tool-call chunks and status chunks pass through immediately, and the moment a
//      tool call appears the buffer is flushed and the step becomes passthrough —
//      only a step that ends with a plain `stop` is a candidate answer.
//   3. On `stop` the buffered answer is sent to a second, fresh, minimal-context call
//      (question + draft + optional tool evidence). That call re-derives the answer
//      instead of proofreading it.
//   4. `{"verdict":"ok"}` releases the buffered answer unchanged. A concrete defect
//      comes back as `{"verdict":"fix","answer":...}` and replaces the draft before
//      the client ever sees it. Any failure releases the draft unchanged.
//
// The cost model is the point: the review request carries the question and the
// answer, not the whole agent context, and the draft itself costs nothing extra —
// it is not regenerated, only held.
//
// The settings are a schemastery `Config`: the Loader validates the row config and
// fills defaults before `apply`, and the Host projects the same schema into the form
// the Plugins page renders (Plugin configuration). One source of truth for both.

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Plugin settings; the Host derives the live settings form from these volatile fields. */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .volatile()
    .description('Master switch. When off, every answer is released without a review.'),
  minChars: z
    .number()
    .min(0)
    .default(120)
    .volatile()
    .description('Answers shorter than this many characters are not reviewed.'),
  maxChars: z
    .number()
    .min(1)
    .default(30000)
    .volatile()
    .description('Answers longer than this are released unreviewed; a full rewrite would be unreliable.'),
  reviewModel: z
    .string()
    .default('')
    .volatile()
    .description('Reviewer route as "provider/model". Empty uses the same route as the answer.'),
  digestChars: z
    .number()
    .min(0)
    .default(4000)
    .volatile()
    .description('Characters of tool-call evidence sent with the draft. 0 disables the digest.'),
  timeoutMs: z
    .number()
    .min(1000)
    .default(60000)
    .volatile()
    .description('Review deadline in milliseconds; the draft is released when it expires.'),
  subagents: z
    .boolean()
    .default(false)
    .volatile()
    .description("Also review delegated subagents' final answers."),
  debug: z.boolean().default(false).volatile().description('Append one JSON line per review to the debug log.'),
  debugFile: z
    .string()
    .default('')
    .volatile()
    .description('Debug log path. Empty uses the system temp directory.'),
})

/** Defaults derived from the schema; volatile fields arrive as live boxes. */
const DEFAULTS = Config['~standard'].validate({}).value

/** Read one config field, unwrapping a live `Volatile` box. */
function field(config, key) {
  const box = config !== null && typeof config === 'object' ? config[key] : undefined
  const value = box !== null && typeof box === 'object' && typeof box.get === 'function' ? box.get() : box
  if (value !== undefined) return value
  const fallback = DEFAULTS[key]
  return fallback !== null && typeof fallback === 'object' && typeof fallback.get === 'function' ? fallback.get() : fallback
}

/** Snapshot the live config for one model call; a volatile field may change between calls. */
function snapshot(config) {
  return {
    enabled: field(config, 'enabled') !== false,
    minChars: Number(field(config, 'minChars')),
    maxChars: Number(field(config, 'maxChars')),
    reviewModel: String(field(config, 'reviewModel') ?? '').trim(),
    digestChars: Number(field(config, 'digestChars')),
    timeoutMs: Number(field(config, 'timeoutMs')),
    subagents: field(config, 'subagents') === true,
    debug: field(config, 'debug') === true,
    debugFile: String(field(config, 'debugFile') ?? ''),
  }
}

/** Fixed reviewer instructions. Kept in English so it shares no prefix with user text. */
const REVIEW_SYSTEM = `You are an independent verifier. A second model produced the DRAFT ANSWER below for the USER REQUEST. You cannot see its reasoning or how it got there; you see only what the user is about to read.

Do the work the draft's author could not do: derive the answer yourself from the request, then compare. Look for concrete defects only:
- factual errors, invented specifics (names, numbers, APIs, file paths, quotations)
- arithmetic, unit, date or logic mistakes; contradictions between parts of the answer
- an explicit constraint in the request that the answer ignores or violates
- code that would not run, or whose explanation contradicts the code
- a conclusion that does not follow from the evidence in the answer or in TURN EVIDENCE

Return exactly one of these two shapes and nothing else. No Markdown fence, no commentary before or after it.

Shape A, the draft is acceptable:
{"verdict":"ok"}

Shape B, you found at least one concrete defect you can repair. The JSON line carries only the verdict; the corrected answer follows it as raw text between the two markers, exactly as it should reach the user, with its own line breaks unescaped:
{"verdict":"fix"}
<<<ANSWER
the complete corrected answer
ANSWER>>>

Never put the answer inside the JSON string: a JSON string cannot carry the unescaped line breaks a real answer needs. When you use Shape B, put one short line per defect in an "issues" array on the JSON line if it helps: {"verdict":"fix","issues":["..."]}

Rules:
- Return "ok" unless you can point at a specific defect. A different approach, extra detail, or a style you would not choose is NOT a defect.
- When fixing, repair only what is wrong. Preserve the draft's structure, wording, formatting, examples and level of detail; do not shorten it, do not add new sections, do not introduce facts that are not in the draft or in TURN EVIDENCE.
- "answer" must be the whole replacement text ready to send to the user, never a diff, a summary, or a comment about the draft.
- If a defect may exist but you cannot correct it without information you do not have, return "ok". A wrong rewrite is worse than an unchanged draft.
- If the draft is empty or clearly not a final answer, return "ok".`

/** Merge the row config over the defaults, coercing each field's type. */
/** Join the text blocks of one message or content array. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

/** The most recent human request in the frozen request messages. */
function lastUserText(messages, limit = 8000) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message !== null && typeof message === 'object' && message.role === 'user') {
      const text = textOf(message.content).trim()
      if (text.length > 0) return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text
    }
  }
  return ''
}

/**
 * Compact evidence of what the turn actually did, most recent calls first so the
 * budget is spent on the tail that the final answer usually relies on.
 * @param messages - the frozen request messages.
 * @param budget - total characters of formatted digest to produce.
 * @returns formatted lines, or '' when the turn made no tool calls.
 */
function toolDigest(messages, budget) {
  if (!Array.isArray(messages) || budget <= 0) return ''
  const names = new Map()
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.id === 'string') {
        names.set(block.id, typeof block.name === 'string' ? block.name : 'tool')
      }
    }
  }
  const lines = []
  let spent = 0
  for (let i = messages.length - 1; i >= 0 && spent < budget; i -= 1) {
    const message = messages[i]
    if (message === null || typeof message !== 'object' || message.role !== 'tool') continue
    const name = names.get(message.source?.callId) ?? 'tool'
    const body = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (body.length === 0) continue
    const room = Math.max(120, Math.min(600, budget - spent))
    const clipped = body.length > room ? `${body.slice(0, room)}…` : body
    const line = `- ${name}: ${clipped}`
    lines.push(line)
    spent += line.length
  }
  return lines.reverse().join('\n')
}

/** Render the single review request body. */
function reviewUserText(question, draft, digest) {
  const section = (title, body) => `${title}\n<<<\n${body}\n>>>`
  const parts = [section('USER REQUEST', question), section('DRAFT ANSWER', draft)]
  if (digest.length > 0) parts.push(section('TURN EVIDENCE (tool calls this turn; may be partial)', digest))
  return parts.join('\n\n')
}

/** Escape raw control characters that a model left inside JSON string literals. */
function sanitizeJson(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of text) {
    if (!inString) {
      out += char
      if (char === '"') inString = true
      continue
    }
    if (escaped) {
      escaped = false
      out += char
      continue
    }
    if (char === '\\') {
      escaped = true
      out += char
      continue
    }
    if (char === '"') {
      inString = false
      out += char
      continue
    }
    const code = char.codePointAt(0)
    if (code !== undefined && code < 0x20) {
      if (char === '\n') out += '\\n'
      else if (char === '\r') out += '\\r'
      else if (char === '\t') out += '\\t'
      else out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += char
  }
  return out
}

/** Read the raw answer between the Shape B markers. */
function delimitedAnswer(text) {
  const closed = /<<<ANSWER[^\S\r\n]*\r?\n([\s\S]*?)\r?\nANSWER>>>/.exec(text)
  if (closed !== null) return closed[1]
  const open = /<<<ANSWER[^\S\r\n]*\r?\n([\s\S]*)$/.exec(text)
  if (open !== null) return open[1].replace(/\s*ANSWER>>>\s*$/, '')
  return undefined
}

/** Parse the reviewer protocol, tolerating a model that still answers in JSON. */
function parseVerdict(text) {
  let body = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)
  if (fence !== null) body = fence[1].trim()
  const firstLine = body.split('\n', 1)[0].trim()
  let value
  for (const candidate of [body, sanitizeJson(body), firstLine, sanitizeJson(firstLine)]) {
    try {
      value = JSON.parse(candidate)
      break
    } catch {
      /* try the next reading */
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (/^\{\s*"verdict"\s*:\s*"fix"/.test(body)) {
      const answer = delimitedAnswer(body)
      if (answer !== undefined && answer.trim().length > 0) return { verdict: 'fix', answer, issues: [] }
    }
    return { verdict: 'ok' }
  }
  if (value.verdict !== 'fix') return { verdict: 'ok' }
  const issues = Array.isArray(value.issues) ? value.issues.filter((issue) => typeof issue === 'string') : []
  if (typeof value.answer === 'string' && value.answer.trim().length > 0) {
    return { verdict: 'fix', answer: value.answer, issues }
  }
  const inline = delimitedAnswer(body)
  if (inline !== undefined && inline.trim().length > 0) return { verdict: 'fix', answer: inline, issues }
  return { verdict: 'ok' }
}

/** Read one review stream to its text answer; throws on a non-stop terminal outcome. */
async function collectReview(stream) {
  let text = ''
  let finished = false
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && text.length === 0) text = chunk.block.text
    else if (chunk.type === 'finish') {
      finished = true
      if (chunk.reason.kind !== 'stop') {
        throw new Error(`reviewer finished with ${chunk.reason.kind}`)
      }
    }
  }
  if (!finished) throw new Error('reviewer emitted no terminal finish')
  return text
}

/** Resolve the reviewer route: an explicit `provider/model` or the answer's own route. */
function routeOf(config, options) {
  const override = config.reviewModel
  if (override.length === 0) return { provider: options.provider, model: options.model }
  const slash = override.indexOf('/')
  if (slash <= 0 || slash === override.length - 1) return { provider: options.provider, model: options.model }
  return { provider: override.slice(0, slash), model: override.slice(slash + 1) }
}

/** Append one structured trace line; a probe must never break the answer path. */
function trace(config, record) {
  if (!config.debug) return
  try {
    const path = config.debugFile.length > 0 ? config.debugFile : join(tmpdir(), 'dsh-self-review.log')
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`)
  } catch {
    /* tracing is best-effort */
  }
}

/** Whether a Host header names this machine's loopback interface. */
function isLoopback(host) {
  if (!host) return false
  const lower = String(host).toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** Refuse cross-site callers: the Host header is the one a rebinding page cannot forge. */
function sameOrigin(request) {
  if (!isLoopback(request.headers.host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** Write one JSON response; the route owns its full lifecycle. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Register the read-only status route the Client half polls while a turn runs.
 * It reports only whether this session's final answer is currently held, so a page
 * can show "self-checking" without exposing any answer text.
 * @param host - context that owns the web server.
 * @param reviewing - live per-session review map.
 * @returns the route disposer.
 */
function registerStatusRoute(host, reviewing) {
  return host.webServer.register({
    kind: 'exact',
    path: '/dsh-self-review/state',
    handler: (request, response) => {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'forbidden' })
        return
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId') || ''
      const active = reviewing.get(sessionId)
      sendJson(response, 200, active === undefined ? { reviewing: false } : { reviewing: true, ...active })
    },
  })
}

/** Whether this exact request is a live agent-loop call worth reviewing. */
function liveSession(ctx, options) {
  if (options === null || typeof options !== 'object') return undefined
  if (options.sessionId === undefined || options.purpose !== undefined) return undefined
  // Agent-loop requests always carry a tool history; hand-built calls (session
  // titles, compaction, reviewers) do not, even when they borrow a session id.
  if (options.toolHistory === undefined) return undefined
  try {
    return ctx.agents.get(options.sessionId)?.session
  } catch {
    return undefined
  }
}

/**
 * Run the reviewer over one held draft.
 * @returns the replacement text, or undefined to release the draft unchanged.
 */
async function reviewDraft(ctx, config, options, draft) {
  const question = lastUserText(options.messages)
  if (question.length === 0) return undefined
  const digest = toolDigest(options.messages, config.digestChars)
  const route = routeOf(config, options)
  const deadline = AbortSignal.timeout(config.timeoutMs)
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: REVIEW_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: reviewUserText(question, draft, digest) }] }],
    temperature: 0,
    signal,
  })
  const verdict = parseVerdict(await collectReview(stream))
  if (verdict.verdict !== 'fix') return undefined
  if (verdict.answer.trim() === draft.trim()) return undefined
  trace(config, { draftChars: draft.length, verdict: 'fix', issues: verdict.issues, correctedChars: verdict.answer.length })
  return verdict.answer
}

/**
 * Wrap one model stream: hold the text, let everything else through, and decide at
 * `finish`. The draft is only buffered until the step proves it is a final answer
 * (a `stop` with no tool calls); a tool call flushes it immediately.
 */
function guardStream(ctx, config, reviewing, options, next) {
  return (async function* stream() {
    const sessionKey = options.sessionId === undefined ? '' : String(options.sessionId)
    const held = []
    const text = []
    let index = -1
    let blocks = 0
    let passthrough = false
    let usage

    function* release() {
      for (const chunk of held) yield chunk
      held.length = 0
    }

    for await (const chunk of next()) {
      switch (chunk.type) {
        case 'block-start': {
          if (chunk.blockType === 'text') {
            index = index === -1 ? chunk.index : index
            if (passthrough) {
              yield chunk
              continue
            }
            blocks += 1
            held.push(chunk)
            continue
          }
          if (chunk.blockType === 'tool-call') {
            passthrough = true
            yield* release()
            yield chunk
            continue
          }
          yield chunk
          continue
        }
        case 'text-delta': {
          if (index === -1) index = chunk.index
          if (passthrough) {
            yield chunk
            continue
          }
          text.push(chunk.text)
          held.push(chunk)
          continue
        }
        case 'block-end': {
          if (chunk.block?.type === 'text') {
            if (passthrough) {
              yield chunk
              continue
            }
            // A non-streaming adapter may deliver the whole text only here.
            if (text.length === 0 && typeof chunk.block.text === 'string') text.push(chunk.block.text)
            held.push(chunk)
            continue
          }
          yield chunk
          continue
        }
        case 'tool-call-delta': {
          passthrough = true
          yield* release()
          yield chunk
          continue
        }
        case 'usage': {
          usage = chunk
          continue
        }
        case 'finish': {
          const draft = text.join('')
          const eligible =
            !passthrough &&
            blocks === 1 &&
            index !== -1 &&
            chunk.reason.kind === 'stop' &&
            draft.trim().length >= config.minChars &&
            draft.length <= config.maxChars
          let replacement
          let failed = false
          if (eligible) {
            const started = Date.now()
            if (sessionKey.length > 0) reviewing.set(sessionKey, { startedAt: started, draftChars: draft.length })
            try {
              replacement = await reviewDraft(ctx, config, options, draft)
            } catch (error) {
              failed = true
              trace(config, {
                draftChars: draft.length,
                verdict: 'error',
                ms: Date.now() - started,
                error: error instanceof Error ? error.message : String(error),
              })
            } finally {
              reviewing.delete(sessionKey)
            }
            if (replacement === undefined && !failed) {
              trace(config, { draftChars: draft.length, verdict: 'ok', ms: Date.now() - started })
            }
          }
          if (replacement !== undefined) {
            yield { type: 'block-start', index, blockType: 'text' }
            yield { type: 'text-delta', index, text: replacement }
            yield { type: 'block-end', index, block: { type: 'text', text: replacement } }
          } else {
            yield* release()
          }
          if (usage !== undefined) yield usage
          yield chunk
          continue
        }
        default: {
          yield chunk
        }
      }
    }
  })()
}

export const name = 'self-review'

export const inject = ['agents', 'llm']

export function apply(ctx, config = {}) {
  const reviewing = new Map()
  ctx.effect(() =>
    ctx.on(
      'llm/stream',
      (options, next) => {
        // Read live: a settings-form edit updates these boxes without a remount.
        const settings = snapshot(config)
        if (!settings.enabled) return next()
        const session = liveSession(ctx, options)
        if (session === undefined) return next()
        if (session.header?.origin === 'subagent' && !settings.subagents) return next()
        return guardStream(ctx, settings, reviewing, options, next)
      },
      { global: true, prepend: true },
    ),
  )
  // The status route is optional: a profile without a web server keeps reviewing.
  ctx.inject(['webServer'], (host) => {
    host.effect(() => registerStatusRoute(host, reviewing))
  })
}
