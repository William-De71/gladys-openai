# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [0.1.0] - 2026-11-05

### Added

- **ai:** the Gladys AI provider on OpenAI (Responses API, your own API key): the chat and its tool calls, the intent router, the scene "ask the AI" action and the weekly digest
- **models:** GPT-6.1 Terra, GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna, GPT-5.6 Terra and GPT-5.6 Luna, or any other OpenAI model id; a chat model and a fast router model; reasoning effort for the chat model
- **reasoning:** the encrypted reasoning items are passed back with the tool results of a turn, so the model keeps its reasoning across tool calls
- **scenes:** triggers when the assistant fails (key refused, credits or spend limit, rate limit, model unavailable, API unreachable) and when it answers again
- **widgets:** requests and tokens of the day and of the month, tokens per day over 30 days, last answer and last error
- **configuration:** "Test the connection" button; connection status checked without spending tokens; requests sent with storage off (`store: false`)
- **i18n:** English, French, German and Spanish for the manifest, the runtime texts, the documentation and the README

[0.1.0]: https://github.com/William-De71/gladys-openai/releases/tag/v0.1.0
