/**
 * dsh-self-review — Client half.
 *
 * A compact activity in the composer toolbar that appears only while this
 * Session's final answer is being held for the second-pass check. The Host owns
 * the truth; this half polls its read-only status route while the turn runs.
 * Polling stops the moment the turn is no longer running, so an idle Session
 * costs nothing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-self-review',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useEffect, useState } = React
    const h = React.createElement

    /** Harness locale service, captured in `apply`. */
    let locale = null

    /** Read the active locale id from whichever snapshot shape the service has. */
    function readLocaleId() {
      try {
        const snapshot = locale ? locale.getLocale() : null
        if (typeof snapshot === 'string') return snapshot
        if (snapshot && typeof snapshot === 'object') return snapshot.active || snapshot.locale || snapshot.id || ''
      } catch {
        /* an unknown snapshot shape reads as the default */
      }
      return ''
    }

    /** Re-render when Settings → General → Language changes. */
    function useLocaleId() {
      const [id, setId] = useState(readLocaleId)
      useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        const listener = () => setId(readLocaleId())
        listener()
        return locale.subscribe(listener)
      }, [])
      return id
    }

    /**
     * Poll the Host while the Session runs.
     * @param sessionId - the Session whose answer may be held.
     * @param running - whether the Session is inside a turn.
     * @returns whether the Host currently holds a review for this Session.
     */
    function useReviewing(sessionId, running) {
      const [reviewing, setReviewing] = useState(false)
      useEffect(() => {
        if (!running || typeof sessionId !== 'string' || sessionId.length === 0) {
          setReviewing(false)
          return undefined
        }
        let alive = true
        let timer = 0
        const tick = async () => {
          try {
            const response = await fetch(`/dsh-self-review/state?sessionId=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            const payload = response.ok ? await response.json() : null
            if (alive) setReviewing(payload !== null && payload.reviewing === true)
          } catch {
            if (alive) setReviewing(false)
          }
          if (alive) timer = window.setTimeout(tick, 350)
        }
        tick()
        return () => {
          alive = false
          window.clearTimeout(timer)
        }
      }, [sessionId, running])
      return reviewing
    }

    /** A small ring that rotates without a stylesheet. */
    function Spinner() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true, style: { flex: 'none', display: 'block' } },
        h('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.25, strokeWidth: 2 }),
        h(
          'path',
          { d: 'M8 2a6 6 0 0 1 6 6', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
          h('animateTransform', {
            attributeName: 'transform',
            type: 'rotate',
            from: '0 8 8',
            to: '360 8 8',
            dur: '0.9s',
            repeatCount: 'indefinite',
          }),
        ),
      )
    }

    /** Toolbar activity: visible only while the answer is held for review. */
    function Indicator(props) {
      const { sessionId, useSessionStatus } = props
      const running = useSessionStatus((snapshot) => snapshot.get(sessionId)?.running === true)
      const reviewing = useReviewing(sessionId, running)
      const localeId = useLocaleId()
      if (!reviewing) return null
      const zh = String(localeId).toLowerCase().startsWith('zh')
      return h(
        'div',
        {
          role: 'status',
          'aria-live': 'polite',
          'data-self-review': 'reviewing',
          title: zh ? '回答已生成，正在独立复核' : 'The answer is being independently reviewed before it is shown',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h(Spinner),
        h('span', null, zh ? '自检中' : 'Self-checking'),
      )
    }

    /* -------------------------------------------------- settings card */

    /** The Host serves this settings namespace (the plugin row id). */
    const SETTINGS_NS = 'self-review'
    // The bundle page renders `plugins.bundle.config` above its rows, so the form sits
    // directly under the plugin description instead of one click deeper.
    const SETTINGS_SLOT = 'plugins.bundle.config'
    const SETTINGS_KEY = 'dsh-self-review'

    /** Field copy; the slot's translator wins, this is the fallback. */
    const SETTINGS_TEXT = {
      en: {
        description: 'Holds each final answer for an independent second-pass check before it is shown.',
        enabled: 'Enabled',
        enabledHint: 'When off, every answer is released without a review.',
        minChars: 'Minimum answer length',
        minCharsHint: 'Answers shorter than this many characters are not reviewed.',
        maxChars: 'Maximum answer length',
        maxCharsHint: 'Longer answers are released unreviewed; a full rewrite would be unreliable.',
        reviewModel: 'Reviewer model',
        reviewModelHint: 'provider/model. Empty uses the same route as the answer.',
        digestChars: 'Tool evidence budget',
        digestCharsHint: 'Characters of tool-call evidence sent with the draft. 0 disables it.',
        timeoutMs: 'Review deadline (ms)',
        timeoutMsHint: 'The draft is released when the deadline expires.',
        subagents: 'Review subagents',
        subagentsHint: "Also review delegated subagents' final answers.",
        debug: 'Debug log',
        debugHint: 'Append one JSON line per review to the log file.',
        debugFile: 'Debug log path',
        debugFileHint: 'Empty uses the system temp directory.',
        overridden: 'Overridden',
        reset: 'Reset',
        invalidNumber: 'Enter a number, or leave blank for the default.',
        invalidText: 'Enter text, or leave blank for the default.',
        unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
        readOnly: 'This deployment stores settings read-only.',
        save: 'Save',
        saving: 'Saving…',
        saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      },
      zh: {
        description: '最终回答送达前先扣住，交给一次独立的二次调用复核，只放出校验后的文本。',
        enabled: '启用',
        enabledHint: '关闭后所有回答都不复核，直接放行。',
        minChars: '最短复核长度',
        minCharsHint: '短于这个字数的回答不复核。',
        maxChars: '最长复核长度',
        maxCharsHint: '长于这个字数的回答原样放行（整段重写不可靠）。',
        reviewModel: '复核模型',
        reviewModelHint: 'provider/model；留空表示与回答同路由。',
        digestChars: '工具证据预算',
        digestCharsHint: '随草稿发送的工具调用摘要字符数，0 表示不发送。',
        timeoutMs: '复核超时（毫秒）',
        timeoutMsHint: '超时后放行原草稿。',
        subagents: '复核子代理',
        subagentsHint: '是否也复核被委派子代理的最终回答。',
        debug: '调试日志',
        debugHint: '每次复核往日志文件写一行 JSON。',
        debugFile: '日志路径',
        debugFileHint: '留空使用系统临时目录。',
        overridden: '已覆盖',
        reset: '恢复默认',
        invalidNumber: '请填数字；留空表示使用默认值。',
        invalidText: '请填文本；留空表示使用默认值。',
        unavailable: '该插件当前未加载，暂时无法配置。',
        readOnly: '本部署的设置为只读。',
        save: '保存',
        saving: '保存中…',
        saveFailed: '本部署没有接受这些值，已保留供你修改。',
      },
    }

    /** Boolean field descriptor; the primitives ship number/text helpers only. */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : value === false ? 'false' : ''),
        parse: (text) => {
          const trimmed = text.trim().toLowerCase()
          if (trimmed === '') return { kind: 'clear' }
          if (trimmed === 'true' || trimmed === '1') return { kind: 'set', value: true }
          if (trimmed === 'false' || trimmed === '0') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    /** One number or text row rendered by the shared settings form. */
    function valueRow(props, state, copy, name, numeric) {
      return h(primitives.SettingsValueField, {
        key: name,
        id: `self-review-setting-${name}`,
        label: copy(name),
        hint: copy(`${name}Hint`),
        overriddenLabel: copy('overridden'),
        resetLabel: copy('reset'),
        invalidLabel: copy(numeric ? 'invalidNumber' : 'invalidText'),
        numeric,
        disabled: !state.writable,
        ...state[name],
        onEdit: (text) => props.edit(name, text),
        onReset: () => props.resetField(name),
      })
    }

    /** One boolean row: a checkbox staged through the same form model. */
    function switchRow(props, state, copy, name) {
      return h(
        'div',
        { key: name, style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 0' } },
        h(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            id: `self-review-setting-${name}`,
            checked: state[name] !== undefined && state[name].text === 'true',
            disabled: !state.writable,
            onChange: (event) => props.edit(name, event.target.checked ? 'true' : 'false'),
          }),
          h('span', { style: { fontSize: '13px' } }, copy(name)),
        ),
        h(
          'span',
          { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
          copy(`${name}Hint`),
        ),
      )
    }

    /** Keep a card failure from taking the whole Plugins page down. */
    class CardBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-self-review] the settings card failed to render', error)
        }
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    /** The bundle row's settings page. */
    function SettingsCard(props) {
      const localeId = useLocaleId()
      const copy = (key) => {
        const zh = String(localeId).toLowerCase().startsWith('zh')
        return (zh ? SETTINGS_TEXT.zh : SETTINGS_TEXT.en)[key] ?? key
      }
      if (props.view === 'summary') return copy('description')
      const state = props.useSelfReviewCard((snapshot) => snapshot)
      return h(
        CardBoundary,
        null,
        h(
          primitives.SettingsForm,
          {
            labels: {
              unavailable: copy('unavailable'),
              readOnly: copy('readOnly'),
              saveFailed: copy('saveFailed'),
              save: copy('save'),
              saving: copy('saving'),
            },
            state,
            onSave: props.save,
            onDiscard: props.discard,
          },
          switchRow(props, state, copy, 'enabled'),
          valueRow(props, state, copy, 'minChars', true),
          valueRow(props, state, copy, 'maxChars', true),
          valueRow(props, state, copy, 'reviewModel', false),
          valueRow(props, state, copy, 'digestChars', true),
          valueRow(props, state, copy, 'timeoutMs', true),
          switchRow(props, state, copy, 'subagents'),
          switchRow(props, state, copy, 'debug'),
          valueRow(props, state, copy, 'debugFile', false),
        ),
      )
    }

    return {
      // `configForms` is the Host-derived form service; waiting for it as a real
      // service dependency is what the shipped settings cards do, and it keeps the
      // card registration correct even when modules load in another order.
      inject: ['slots', 'configForms'],
      apply(ctx) {
        locale = ctx.get ? ctx.get('locale') : ctx.locale
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            { name: 'conversation.input.activity', id: 'self-review-status' },
            Indicator,
          ),
        )
        const forms = ctx.configForms
        if (forms === undefined || forms === null) return
        const form = new primitives.SettingsFormModel(forms.get(SETTINGS_NS), [
          settingsBooleanField('enabled'),
          primitives.settingsNumberField('minChars'),
          primitives.settingsNumberField('maxChars'),
          primitives.settingsTextField('reviewModel'),
          primitives.settingsNumberField('digestChars'),
          primitives.settingsNumberField('timeoutMs'),
          settingsBooleanField('subagents'),
          settingsBooleanField('debug'),
          primitives.settingsTextField('debugFile'),
        ])
        const store = form.bind(() => ({
          ...form.shell(),
          enabled: form.field('enabled'),
          minChars: form.field('minChars'),
          maxChars: form.field('maxChars'),
          reviewModel: form.field('reviewModel'),
          digestChars: form.field('digestChars'),
          timeoutMs: form.field('timeoutMs'),
          subagents: form.field('subagents'),
          debug: form.field('debug'),
          debugFile: form.field('debugFile'),
        }))
        ctx.effect(() => () => form.dispose(), 'self-review: settings form subscription')
        ctx.effect(
          () =>
            forms.whileServed([SETTINGS_NS], () =>
              ctx.slots.inject(SETTINGS_SLOT, () =>
                ctx.slots.register(
                  {
                    name: SETTINGS_SLOT,
                    key: SETTINGS_KEY,
                    inject: () => ({
                      hooks: { selfReviewCard: store },
                      ...form.actions(),
                    }),
                  },
                  SettingsCard,
                ),
              ),
            ),
          'self-review: settings card',
        )
      },
    }
  },
})
