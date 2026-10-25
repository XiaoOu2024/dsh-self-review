# Changelog

## 0.4.2 — settings on the bundle page

- The settings card registers at `plugins.bundle.config` (key `dsh-self-review`) instead of the
  row slot, so the form sits directly under the plugin description instead of one click deeper.

## 0.4.1 — the settings form actually renders

- DSH has no schema-to-form renderer: a bundle must ship a client card. This adds one at
  `plugins.row.config` (key `dsh-self-review#self-review`) built on the shipped primitives
  (`SettingsFormModel`, `SettingsForm`, `SettingsValueField`), with checkbox rows for the three
  switches and number/text rows for the rest.
- The client module now injects `ui-settings` and `ui-plugin-manager` so the page and its form
  service exist before the card registers.
- A render failure inside the card is contained by an error boundary and leaves the page usable.
- The Host republishes the client artifact on every activation (`clientModules.rebuilt`), so a
  linked package's client edits reach the browser on the next page load without a reinstall or the
  dev build watcher.
- The client half waits for `configForms` as a real service dependency instead of an optional
  context injection, matching the shipped settings cards.

## 0.4.0 — settings form

- Settings are declared as a schemastery `Config`; every field is volatile, so the Host
  derives the Plugin configuration form and edits apply live without a remount.
- The bundle patch no longer pins defaults: the schema is the single source of truth, and
  the Loader fills them before `apply`.
- The stream guard reads the live config per model call, so switching `enabled` off and on
  again takes effect without reloading the plugin.
- New dependency: `@deepseek-ai/schemastery` (pure JS, no build step).

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
