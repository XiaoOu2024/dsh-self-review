// Protocol tests for the hidden self-review stream guard, with no real model call.
import assert from 'node:assert/strict'
import { apply } from './index.js'

const draft =
  'The answer is 4 because 2 + 2 = 4. This paragraph is long enough to pass the minimum length check in the test configuration.'

/** Normalize one chunk log into the text the client would receive. */
function visibleText(chunks) {
  return chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
}

/** Build the request options of a live agent-loop call. */
function loopOptions(overrides = {}) {
  return {
    sessionId: 'session-1',
    provider: 'test-provider',
    model: 'test-model',
    toolHistory: { tools: [], updates: [] },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is 2 + 2? Explain.' }] },
    ],
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** The chunks of a plain final answer: reasoning, text, usage, stop. */
function answerChunks(text = draft) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Let me add.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me add.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: text.slice(0, 10) },
    { type: 'text-delta', index: 1, text: text.slice(10) },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The chunks of a step that calls a tool instead of answering. */
function toolChunks() {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Let me check the file.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Let me check the file.' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{"path":"a"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Reviewer chunks that carry one text block with the given body. */
function reviewerChunks(body) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: body },
    { type: 'block-end', index: 0, block: { type: 'text', text: body } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Install the plugin against a fake context and run one stream through it.
 * @returns the emitted chunks plus the reviewer requests that were observed.
 */
async function run({ chunks = answerChunks(), reviewer = '{"verdict":"ok"}', config = {}, options = loopOptions(), subagent = false } = {}) {
  let listener
  const reviewerOptions = []
  const ctx = {
    agents: {
      get: (id) =>
        id === 'session-1'
          ? { session: { header: subagent ? { origin: 'subagent' } : {} } }
          : undefined,
    },
    llm: {
      stream: (request) => {
        reviewerOptions.push(request)
        const body = typeof reviewer === 'function' ? reviewer(request) : reviewer
        if (body instanceof Error) throw body
        return (async function* () {
          yield* reviewerChunks(body)
        })()
      },
    },
    effect: (install) => install(),
    on: (name, fn) => {
      assert.equal(name, 'llm/stream')
      listener = fn
      return () => {}
    },
    inject: () => {},
  }
  apply(ctx, { minChars: 0, debug: false, ...config })
  const wrapped = listener(options, () =>
    (async function* () {
      yield* chunks
    })(),
  )
  const emitted = []
  for await (const chunk of wrapped) emitted.push(chunk)
  return { emitted, reviewerOptions }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('ok verdict releases the draft unchanged and streams reasoning first', async () => {
  const { emitted, reviewerOptions } = await run()
  assert.equal(reviewerOptions.length, 1)
  assert.equal(visibleText(emitted), draft)
  assert.equal(emitted[0].type, 'block-start')
  assert.equal(emitted[0].blockType, 'reasoning')
  assert.equal(emitted.at(-1).type, 'finish')
  assert.equal(emitted.filter((chunk) => chunk.type === 'usage').length, 1)
})

test('fix verdict replaces the draft before the client sees any text', async () => {
  const corrected = 'The answer is 5 because 2 + 2 + 1 = 5.'
  const { emitted } = await run({
    reviewer: JSON.stringify({ verdict: 'fix', issues: ['arithmetic'], answer: corrected }),
  })
  assert.equal(visibleText(emitted), corrected)
  assert.ok(!visibleText(emitted).includes('2 + 2 = 4'))
  // Exactly one text block, opened and closed.
  assert.equal(emitted.filter((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text').length, 1)
  assert.equal(emitted.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text').length, 1)
})

test('a tool-call step flushes the held text immediately and never calls the reviewer', async () => {
  const { emitted, reviewerOptions } = await run({ chunks: toolChunks() })
  assert.equal(reviewerOptions.length, 0)
  assert.equal(visibleText(emitted), 'Let me check the file.')
  assert.ok(emitted.some((chunk) => chunk.type === 'tool-call-delta'))
})

test('hand-built calls without a tool history are not reviewed', async () => {
  const { emitted, reviewerOptions } = await run({
    options: loopOptions({ sessionId: undefined, toolHistory: undefined }),
  })
  assert.equal(reviewerOptions.length, 0)
  assert.equal(visibleText(emitted), draft)
})

test('purpose-tagged calls (compaction, titles) are not reviewed', async () => {
  const { emitted, reviewerOptions } = await run({ options: loopOptions({ purpose: 'session-title' }) })
  assert.equal(reviewerOptions.length, 0)
  assert.equal(visibleText(emitted), draft)
})

test('subagent answers are skipped unless enabled', async () => {
  const skipped = await run({ subagent: true })
  assert.equal(skipped.reviewerOptions.length, 0)
  const reviewed = await run({ subagent: true, config: { subagents: true } })
  assert.equal(reviewed.reviewerOptions.length, 1)
})

test('reviewer failure releases the draft unchanged', async () => {
  const { emitted } = await run({ reviewer: () => new Error('boom') })
  assert.equal(visibleText(emitted), draft)
  assert.equal(emitted.at(-1).type, 'finish')
})

test('a delimiter-shaped fix replaces a multi-line answer verbatim', async () => {
  const corrected = 'Line one.\n\nLine two with a "quote" and a\\n literal.\n- bullet'
  const { emitted } = await run({
    reviewer: `{"verdict":"fix","issues":["wrong"]}\n<<<ANSWER\n${corrected}\nANSWER>>>`,
  })
  assert.equal(visibleText(emitted), corrected)
})

test('a JSON fix with raw newlines inside the string is salvaged', async () => {
  const corrected = 'first line\nsecond line'
  const { emitted } = await run({
    reviewer: `{"verdict":"fix","issues":["wrong"],"answer":"${corrected}"}`,
  })
  assert.equal(visibleText(emitted), corrected)
})

test('a bare fix line followed by the delimiter block still parses', async () => {
  const { emitted } = await run({ reviewer: '{"verdict":"fix"}\n<<<ANSWER\nrepaired body\nANSWER>>>' })
  assert.equal(visibleText(emitted), 'repaired body')
})

test('ok with surrounding prose still counts as ok', async () => {
  const { emitted } = await run({ reviewer: '{"verdict":"ok"}\nNo defects found.' })
  assert.equal(visibleText(emitted), draft)
})

test('a malformed reviewer answer releases the draft unchanged', async () => {
  const { emitted } = await run({ reviewer: 'not json' })
  assert.equal(visibleText(emitted), draft)
})

test('short answers skip the reviewer', async () => {
  const { emitted, reviewerOptions } = await run({
    chunks: answerChunks('ok'),
    config: { minChars: 100 },
  })
  assert.equal(reviewerOptions.length, 0)
  assert.equal(visibleText(emitted), 'ok')
})

test('non-stop terminal outcomes release the draft unchanged', async () => {
  const chunks = answerChunks()
  chunks[chunks.length - 1] = { type: 'finish', reason: { kind: 'max-tokens' } }
  const { emitted, reviewerOptions } = await run({ chunks })
  assert.equal(reviewerOptions.length, 0)
  assert.equal(visibleText(emitted), draft)
})

test('the reviewer sees the question, the draft and the tool digest', async () => {
  const options = loopOptions({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is 2 + 2?' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-9', name: 'calc', arguments: '{}' }] },
      { role: 'tool', source: { kind: 'tool', callId: 'call-9' }, content: [{ type: 'text', text: '4' }] },
    ],
  })
  const { reviewerOptions } = await run({ options })
  const body = reviewerOptions[0].messages[0].content[0].text
  assert.match(body, /USER REQUEST\n<<<\nWhat is 2 \+ 2\?/)
  assert.match(body, /DRAFT ANSWER/)
  assert.match(body, /TURN EVIDENCE/)
  assert.match(body, /calc: 4/)
})

test('the reviewer route can be overridden by provider/model', async () => {
  const { reviewerOptions } = await run({ config: { reviewModel: 'cheap-model/flash' } })
  assert.equal(reviewerOptions[0].provider, 'cheap-model')
  assert.equal(reviewerOptions[0].model, 'flash')
})

test('a disabled plugin passes the stream through, and a volatile flip applies live', async () => {
  let listener
  let reviews = 0
  const enabled = { value: false, get() { return this.value } }
  const ctx = {
    agents: { get: () => ({ session: { header: {} } }) },
    llm: {
      stream: () => {
        reviews += 1
        return (async function* () {
          yield* reviewerChunks('{"verdict":"ok"}')
        })()
      },
    },
    effect: (install) => install(),
    on: (name, fn) => {
      listener = fn
      return () => {}
    },
    inject: () => {},
  }
  apply(ctx, { enabled })
  const runOnce = async () => {
    const out = []
    for await (const chunk of listener(loopOptions(), () =>
      (async function* () {
        yield* answerChunks()
      })(),
    )) {
      out.push(chunk)
    }
    return out
  }
  const off = await runOnce()
  assert.equal(reviews, 0)
  assert.equal(visibleText(off), draft)
  enabled.value = true
  const on = await runOnce()
  assert.equal(reviews, 1)
  assert.equal(visibleText(on), draft)
})

/** Invoke the status route with one fake request. */
function callRoute(handler, headers, sessionId) {
  const response = {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
  handler({ headers, url: `/dsh-self-review/state?sessionId=${encodeURIComponent(sessionId)}` }, response)
  return response
}

test('the Host status route reports a held review and refuses a foreign caller', async () => {
  let listener
  let handler
  let releaseReview
  const gate = new Promise((resolve) => {
    releaseReview = resolve
  })
  const ctx = {
    agents: { get: (id) => (id === 'session-1' ? { session: { header: {} } } : undefined) },
    llm: {
      stream: () =>
        (async function* () {
          await gate
          yield* reviewerChunks('{"verdict":"ok"}')
        })(),
    },
    effect: (install) => install(),
    on: (name, fn) => {
      listener = fn
      return () => {}
    },
    inject: (deps, cb) =>
      cb({
        effect: (install) => install(),
        webServer: {
          register: (route) => {
            handler = route.handler
            return () => {}
          },
        },
      }),
  }
  apply(ctx, { minChars: 0, debug: false })

  const wrapped = listener(loopOptions(), () =>
    (async function* () {
      yield* answerChunks()
    })(),
  )
  const consumed = (async () => {
    for await (const chunk of wrapped) void chunk
  })()

  // Wait until the reviewer is actually running behind the held stream.
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && handler !== undefined) {
    if (JSON.parse(callRoute(handler, { host: '127.0.0.1:3080' }, 'session-1').body).reviewing) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(handler !== undefined, true)
  assert.equal(JSON.parse(callRoute(handler, { host: '127.0.0.1:3080' }, 'session-1').body).reviewing, true)

  releaseReview()
  await consumed
  assert.equal(JSON.parse(callRoute(handler, { host: '127.0.0.1:3080' }, 'session-1').body).reviewing, false)
  assert.equal(callRoute(handler, { host: 'evil.example:3080' }, 'session-1').status, 403)
})

let failures = 0
for (const { name: label, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`)
process.exitCode = failures === 0 ? 0 : 1
