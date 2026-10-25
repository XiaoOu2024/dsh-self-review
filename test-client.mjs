// Client-half smoke test: module registration and slot wiring, no browser.
import assert from 'node:assert/strict'

let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => {
      definition = def
    },
  },
}

await import('./client.js')

assert.equal(definition.id, 'dsh-self-review')

const React = {
  createElement: () => null,
  useEffect: () => {},
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
}

const plugin = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module: ${name}`)
})

assert.deepEqual(plugin.inject, ['slots'])

let registration
const locale = { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
const ctx = {
  get: (name) => (name === 'locale' ? locale : undefined),
  slots: {
    inject: (slot, install) => {
      assert.equal(slot, 'conversation.input.activity')
      return install()
    },
    register: (options, component) => {
      registration = { options, component }
      return () => {}
    },
  },
}

plugin.apply(ctx)

assert.equal(registration.options.name, 'conversation.input.activity')
assert.equal(registration.options.id, 'self-review-status')
assert.equal(typeof registration.component, 'function')

console.log('client smoke ok: registers conversation.input.activity#self-review-status')
