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

    return {
      inject: ['slots'],
      apply(ctx) {
        locale = ctx.get ? ctx.get('locale') : ctx.locale
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            { name: 'conversation.input.activity', id: 'self-review-status' },
            Indicator,
          ),
        )
      },
    }
  },
})
