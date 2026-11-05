// -----------------------------------------------------------------------------
// The AI provider: one chat completion in, one out, answered by OpenAI.
//
// The whole agentic loop (prompts, tools, history) stays in the Gladys core:
// this handler picks the model, translates the request (convert.js), calls
// the Responses API and translates the answer back. It runs no tool.
//
// What each `purpose` gets:
//   - `intent-classification` (the router, before every chat turn): the fast
//     model with the least reasoning it accepts, under 18 s (the core waits
//     20 s);
//   - `chat`, `weekly-digest` and anything else: the main model at the
//     reasoning level of the configuration, under 110 s (the core waits 120 s).
//
// `store: false` on every request: OpenAI does not keep the response for
// later retrieval (it is stored 30 days by default otherwise). The abuse
// monitoring logs of OpenAI still apply.
// -----------------------------------------------------------------------------

import { AI_CHAT_PURPOSES, createLogger } from '@gladysassistant/integration-sdk';
import { MAX_TOKENS_MAX, effortFor, modelName, resolveModel } from './config.js';
import {
  createReasoningStore,
  hasImages,
  toOpenAiCompletion,
  toResponsesInput,
  toResponsesToolChoice,
  toResponsesTools,
} from './convert.js';
import { ERROR_KINDS, OpenAiError } from './openai-api.js';

const logger = createLogger({ name: 'chat' });

export const CHAT_TIMEOUT_MS = 110_000;
export const ROUTER_TIMEOUT_MS = 18_000;

/**
 * @description The use counted for a purpose.
 * @param {string} purpose - The `purpose` of the request.
 * @returns {string} `router`, `digest` or `chat`.
 */
export function useOf(purpose) {
  if (purpose === AI_CHAT_PURPOSES.INTENT_CLASSIFICATION) {
    return 'router';
  }
  if (purpose === AI_CHAT_PURPOSES.WEEKLY_DIGEST) {
    return 'digest';
  }
  return 'chat';
}

/**
 * @description Build the Responses request of a core request.
 * @param {object} request - `{ messages, tools?, tool_choice?, max_tokens?, purpose }`.
 * @param {object} config - The normalized config.
 * @param {object} [options] - Options.
 * @param {object} [options.reasoning] - The reasoning store.
 * @param {Set<string>} [options.noReasoning] - Models that refused `reasoning`.
 * @returns {object} The body, with `model`.
 */
export function buildRequest(
  request,
  config,
  { reasoning = createReasoningStore(), noReasoning = new Set() } = {},
) {
  const use = useOf(request?.purpose);
  const router = use === 'router';
  const model = resolveModel(config, router ? 'fast_model' : 'model');
  if (!model) {
    throw new OpenAiError(
      ERROR_KINDS.MODEL,
      'The configuration chooses a custom model but the custom model id is empty',
    );
  }
  const input = toResponsesInput(request?.messages, reasoning);
  if (input.length === 0) {
    throw new OpenAiError(ERROR_KINDS.REQUEST, 'The request carries no message to answer');
  }
  const body = {
    model,
    input,
    // The caller's `max_tokens` is sized for an answer without reasoning;
    // the limit of the Responses API counts the reasoning too.
    max_output_tokens: Math.min(
      MAX_TOKENS_MAX,
      Math.max(config.max_tokens, Number(request?.max_tokens) || 0),
    ),
    store: false,
    // Requests of one use share their long prefix (prompt, tools): the same
    // key routes them to the same cache.
    prompt_cache_key: `gladys-${use}`,
  };
  const tools = toResponsesTools(request?.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = toResponsesToolChoice(request?.tool_choice);
    if (choice) {
      body.tool_choice = choice;
    }
  }
  if (!noReasoning.has(model)) {
    const effort = effortFor(model, router ? 'none' : config.reasoning);
    if (effort !== undefined) {
      body.reasoning = { effort };
    }
  }
  return body;
}

/**
 * @description Whether a refusal is about the reasoning parameter (a custom
 * model without reasoning, or an effort it does not know).
 * @param {unknown} err - The error.
 * @returns {boolean} True for a 400 that names it.
 */
function refusedReasoning(err) {
  return (
    err instanceof OpenAiError && err.kind === ERROR_KINDS.REQUEST && /reasoning/i.test(err.message)
  );
}

/**
 * @description Create the `onAiChat` handler.
 * @param {object} options - Options.
 * @param {object} options.client - The OpenAI client (openai-api.js).
 * @param {() => object} options.getConfig - The normalized config.
 * @param {object} [options.usage] - The usage store (usage.js).
 * @param {object} [options.reasoning] - The reasoning store (convert.js).
 * @param {(err: OpenAiError, context: object) => void} [options.onFailure] - Failure hook (scene trigger).
 * @param {() => void} [options.onSuccess] - Success hook.
 * @param {() => number} [options.now] - Clock.
 * @returns {(request: object) => Promise<object>} The handler.
 */
export function createChatHandler({
  client,
  getConfig,
  usage,
  reasoning = createReasoningStore(),
  onFailure = () => {},
  onSuccess = () => {},
  now = Date.now,
}) {
  // Models that refused `reasoning` (a custom model without it): never sent
  // to them again until the integration restarts.
  const noReasoning = new Set();

  return async function onAiChat(request) {
    const config = getConfig();
    const use = useOf(request?.purpose);
    const budget = use === 'router' ? ROUTER_TIMEOUT_MS : CHAT_TIMEOUT_MS;
    const started = now();
    const left = () => Math.max(1000, budget - (now() - started));
    let model;
    try {
      let body = buildRequest(request, config, { reasoning, noReasoning });
      model = body.model;
      let response;
      try {
        response = await client.createResponse(body, { timeoutMs: left() });
      } catch (err) {
        if (!body.reasoning || !refusedReasoning(err)) {
          throw err;
        }
        logger.warn(`${body.model} refused the reasoning effort: sent without it from now on`);
        noReasoning.add(body.model);
        body = buildRequest(request, config, { reasoning, noReasoning });
        response = await client.createResponse(body, { timeoutMs: left() });
      }

      const {
        openai_status: status,
        openai_refusal: refusal,
        ...out
      } = toOpenAiCompletion(response, { reasoning, model });
      const message = out.choices[0].message;
      const ms = now() - started;

      if (!message.content && !message.tool_calls) {
        if (status === 'max_output_tokens') {
          throw new OpenAiError(
            ERROR_KINDS.REQUEST,
            `The answer was cut at max_tokens (${body.max_output_tokens}) before any text: raise it in the configuration or lower the reasoning`,
          );
        }
        if (status === 'refusal') {
          throw new OpenAiError(
            ERROR_KINDS.REQUEST,
            `${modelName(model)} refused to answer: ${String(refusal).slice(0, 200)}`,
          );
        }
        if (status === 'content_filter') {
          throw new OpenAiError(
            ERROR_KINDS.REQUEST,
            'OpenAI stopped the answer (content_filter): rephrase the request',
          );
        }
        throw new OpenAiError(ERROR_KINDS.SERVER, `OpenAI returned an empty answer (${status})`);
      }
      if (status === 'max_output_tokens') {
        logger.warn(
          `The answer hit max_tokens (${body.max_output_tokens}): raise it in the configuration`,
        );
      }
      logger.info(
        `${request?.purpose ?? 'chat'}: ${modelName(model)} answered in ${(ms / 1000).toFixed(1)} s` +
          ` (${out.usage.prompt_tokens} in, ${out.usage.completion_tokens} out` +
          `${message.tool_calls ? `, ${message.tool_calls.length} tool call(s)` : ''})`,
      );
      usage?.recordSuccess({ use, model, usage: out.usage, ms });
      onSuccess();
      return out;
    } catch (err) {
      const error =
        err instanceof OpenAiError
          ? err
          : new OpenAiError(ERROR_KINDS.SERVER, err?.message ?? String(err));
      if (hasImages(request?.messages) && error.kind === ERROR_KINDS.REQUEST) {
        error.message += ' (the request carried an image)';
      }
      logger.warn(`${request?.purpose ?? 'chat'} failed (${error.kind}): ${error.message}`);
      usage?.recordError({ use, model, kind: error.kind, message: error.message });
      onFailure(error, { use, model });
      throw error;
    }
  };
}
