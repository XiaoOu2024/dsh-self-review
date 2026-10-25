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
  Component: class {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState() {}
  },
}

/** Minimal stand-ins for the browser primitives module. */
const primitives = {
  SettingsForm: () => null,
  SettingsValueField: () => null,
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
    }
    bind(project) {
      return () => project()
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
    }
    field(name) {
      return { text: '', overridden: false, invalid: false, name }
    }
    actions() {
      return { edit() {}, resetField() {}, save() {}, discard() {} }
    }
    dispose() {}
  },
  settingsNumberField: (field) => ({ field, format: (value) => String(value), parse: () => undefined }),
  settingsTextField: (field) => ({ field, format: (value) => String(value), parse: () => undefined }),
}

const plugin = definition.factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected module: ${name}`)
})

assert.deepEqual(plugin.inject, ['slots'])

const registrations = []
const locale = { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
const slots = {
  inject: (slot, install) => {
    assert.ok(['conversation.input.activity', 'plugins.row.config'].includes(slot), slot)
    return install()
  },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}

let formModel
const configForms = {
  get: (ns) => {
    assert.equal(ns, 'self-review')
    return { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', writable: true }) }
  },
  whileServed: (namespaces, install) => {
    assert.deepEqual(namespaces, ['self-review'])
    return install()
  },
}

const ctx = {
  get: (name) => (name === 'locale' ? locale : undefined),
  slots,
  inject: (deps, install) => {
    assert.deepEqual([...deps].sort(), ['configForms', 'slots'])
    return install({
      configForms,
      slots,
      effect: (installEffect) => {
        const dispose = installEffect()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    })
  },
}

plugin.apply(ctx)

assert.equal(registrations.length, 2)

const indicator = registrations.find((entry) => entry.options.name === 'conversation.input.activity')
assert.equal(indicator.options.id, 'self-review-status')
assert.equal(typeof indicator.component, 'function')

const card = registrations.find((entry) => entry.options.name === 'plugins.row.config')
assert.equal(card.options.key, 'dsh-self-review#self-review')
assert.equal(typeof card.component, 'function')

const injected = card.options.inject()
assert.equal(typeof injected.hooks.selfReviewCard, 'function')
for (const action of ['edit', 'resetField', 'save', 'discard']) {
  assert.equal(typeof injected[action], 'function', action)
}

console.log('client smoke ok: indicator + plugins.row.config#dsh-self-review#self-review')
