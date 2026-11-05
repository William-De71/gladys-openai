# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** that makes the **GPT models of
OpenAI** the AI provider of a Gladys instance: a Node.js service (Node 22+,
ESM, no build step) in its own sandboxed Docker container, talking to Gladys
through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to the official OpenAI API (`https://api.openai.com/v1`, **Responses
API**) with the administrator's own API key. Runtime dependency: the SDK only
(plain `fetch`, no OpenAI client). `type: "ai"`, Gladys 5.3.0+,
`transports: ["cloud"]`, `categories: ["assistants"]`. Not affiliated with
OpenAI.

The contract (SDK README, "AI providers"): one Chat Completions request in
(`messages`, `tools`, `tool_choice`, `max_tokens`, `purpose`, `categories`,
no `model`), one chat completion out. The agentic loop (prompts, tools,
history) runs in the core; this integration only picks the model and
translates to and from the Responses API. Why not Chat Completions, which the
core already speaks: the GPT-6 models only call tools with reasoning through
Responses (api/docs/guides/latest-model, checked 2026-11-05). **Never tested
with a real OpenAI key**: request and response shapes follow the API
reference (developers.openai.com/api/reference, `.md` pages), checked on
2026-11-05.

## Commands

```bash
npm install
npm test                                  # node --test; a fake OpenAI API on 127.0.0.1
node --test test/chat.test.js             # one file
UPDATE_BASELINE=1 npm test                # rewrite test/fixtures/manifest.baseline.json (on purpose only)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store . --skip-image-check   # store checks
scripts/build-cover.sh                    # cover.jpg from docs/assets/cover.svg
docs/illustrations/render.sh              # docs/assets/widgets.<lang>.png
node .github/scripts/release.mjs next     # the version the next release would get
```

## Architecture

```
index.js               SDK wiring only (new GladysIntegration + createApp)
src/app.js             every handler: onAiChat, test button, widget, configuration,
                       status following the requests
src/chat.js            the AI provider: model per purpose, reasoning effort, retry
                       without it when refused, refusals, cut / filtered answers,
                       usage, hooks
src/convert.js         Chat Completions <-> Responses: message / function_call /
                       function_call_output items (paired by call_id), input_image,
                       flat tools with strict: false, tool_choice, reasoning items
                       (memory by call id)
src/openai-api.js      fetch client: POST /responses, GET /models/{id}; Bearer header,
                       deadline, retries on 429 / 5xx / network with Retry-After,
                       billing 429 never retried, error kinds, keys masked
src/events.js          triggers: error (once per failure kind), recovered
src/usage.js           /data/usage.json: requests and tokens per local day, 62 days
src/widgets.js         the usage widget
src/connection.js      status (GET models/{id}, no token spent) and the test button
src/config.js          models, reasoning efforts per model, custom model id, max_tokens
src/i18n.js            runtime texts, en / fr / de / es
src/time.js            local days and times (TZ of Gladys, Intl only)
test/helpers/fake-openai.js     the fake API (responses, models, 401 on a bad key)
.github/scripts/release.mjs     version, changelog, bump (tested in test/)
```

## Rules

- **Every key users store is forever**: the keys of `config_schema` and the
  values of the `model` / `fast_model` / `reasoning` selects (a model id
  leaves the list only when OpenAI shuts the model down), `actions`, the
  widget, the triggers (fields, options, variables). `test/structure.test.js`
  compares them to `test/fixtures/manifest.baseline.json`: never update it to
  make a test pass without a documented migration.
- **Deadlines of the core**: the ack is awaited 20 s for
  `intent-classification`, 120 s otherwise; the handler gives up at 18 s and
  110 s. Retries (rate limit, 5xx, network) only while the deadline leaves
  room; a wait longer than 8 s (Retry-After) fails at once. A **billing 429**
  (`insufficient_quota`, `credit_balance_exhausted`, spend limits) is never
  retried: kind `billing`.
- **Never fall back silently**: a failure throws (the core names it to the
  user); never answer from another provider, never return an empty turn.
- **The router reasons the least its model accepts** (`effortFor(model,
'none')`): it must answer fast. Only efforts a model accepts are sent
  (`MODELS[id].effort`); GPT-6 Astra and GPT-6.1 Sol refuse `none`. `xhigh`
  and `max` are not offered (too slow for 110 s). Never send `temperature`,
  `top_p` or `logprobs` (refused when reasoning is on).
- **Reasoning items**: with `store: false` the answer carries `reasoning`
  items with `encrypted_content`; those before the first function call are
  remembered (`createReasoningStore`, by call id, 6 h, 500 entries) and put
  back before that call when the core resends the turn. Never send the `id`
  of a `function_call` item: OpenAI would then demand its reasoning item.
- **Calls and results stay paired**: OpenAI refuses a lone `function_call` or
  a lone `function_call_output`. Placeholder ids of the core (`unknown`,
  `tool_call_unknown`) get a stable made-up id, results take the open calls in
  order, a call left alone gets `MISSING_OUTPUT`, an orphan result is dropped.
- **Tools go with `strict: false`**: without it, the Responses API rewrites
  the schemas of the core into strict mode (every property required), which
  changes the arguments of optional parameters.
- **`store: false`** on every request (Responses stores 30 days by default),
  and a `prompt_cache_key` per use (`gladys-chat`, `gladys-router`…).
- **The completion is bounded like the core does** (`validateAiCompletion`):
  `content` a string or null, at most 20 tool calls, names
  `^[a-zA-Z0-9_-]{1,64}$`, `arguments` a JSON string, ids at most 128
  characters. Internal fields (`openai_status`, `openai_refusal`) never leave
  `chat.js`.
- **Scene events** once per transition: `error` when the failure kind changes,
  `recovered` at the first answer after. A refused request (`request` kind:
  HTTP 400, a refusal, a content filter) starts nothing and does not change
  the status.
- **No web search action**: OpenAI requires web results to be displayed with
  their citations as prominent, clickable links (guides/tools-web-search); a
  scene that reads the answer aloud or sends it by SMS cannot. Do not add the
  `web_search` tool without a way to honour it.
- **The API key** is a `secret`: never logged, never in /data, never in an
  error message (`maskKeys` hides `sk-…` and `Bearer …`: a 401 quotes the
  ends of the refused key).
- **The container rootfs is read-only.** Write only under `/data` (usage
  counters, written at most every 10 s and at shutdown).
- **Four languages.** Every user-facing text (manifest, `src/i18n.js`,
  `docs/*.md`, README) exists in en, fr, de, es; `test/i18n.test.js` checks it.
  German says "du", Spanish "usted".
- **Widget images.** After any change to a widget content, run
  `docs/illustrations/render.sh` again and look at the four PNG files.
- **Logo**: the OpenAI blossom (simple-icons, CC0 path) names the service
  only; keep the "not affiliated" notices.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, the lockfile or the manifest, nor the `docker_image` tag.
  Below 1.0.0 until the maintainer runs Release with `release-as: 1.0.0`.
- **Changelog.** Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Commits and PR titles** follow Conventional Commits, in English.
- **Forum drafts** (`.github/forum-*.md`) are never committed.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

## Pitfalls

- A wrong or revoked key is a 401 `invalid_api_key`. A 403 is a country
  OpenAI does not serve (auth) or a project without access to a model
  (model). A 404 `model_not_found` is a model that does not exist or is shut.
- `GET /models/{id}` succeeds even when the project cannot pay: only the test
  button proves it.
- `max_output_tokens` counts the reasoning: an `incomplete` answer with
  `max_output_tokens` may carry no text at all.
- A refusal is an `output_text`-less message with a `refusal` part, not an
  HTTP error.
- `AbortSignal.timeout` does not keep the process alive: a test that waits on
  it needs its own timer.
- `node --test` also runs `test/helpers/`: nothing starts on import.
- The validator of the Gladys core creates `gladys-development.duckdb` in the
  current folder: run it from elsewhere.
