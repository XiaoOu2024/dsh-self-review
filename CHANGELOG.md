# Changelog

## 0.3.0 — first public release

- Hold the final answer at the `llm/stream` waterfall and release only the verified text.
- Independent, minimal-context review call (question + draft + optional tool digest); fail-open on
  timeout, error or unexpected reviewer output.
- `verdict=fix` replaces the draft before the client sees it; `verdict=ok` releases it unchanged.
- Client half: a compact "self-checking" activity in the composer toolbar, driven by a read-only
  loopback status route (`GET /dsh-self-review/state`).
- `engines.dsh` pins the tested runtime (`=0.2.1-rc.2`).
- 18 protocol tests + a client-registration smoke test.

## 0.2.0

- Delimiter-based reviewer protocol (`{"verdict":"fix"}` + `<<<ANSWER … ANSWER>>>`), tolerant of raw
  newlines inside a JSON answer string.
- Host status route and client indicator groundwork.

## 0.1.0

- Initial stream guard: buffer text, passthrough on tool calls, review on `stop`.
