// -----------------------------------------------------------------------------
// OpenAI chat completions of the Gladys core <-> the OpenAI Responses API.
//
// The core speaks the Chat Completions dialect. This integration calls the
// Responses API instead: the GPT-6 models only call tools with reasoning
// through it (api/docs/guides/latest-model, "Tool calling", checked
// 2026-11-05). The translation:
//   - system / developer / user / assistant messages become `message` input
//     items; text parts `input_text`, images (data URLs) `input_image`;
//   - an assistant tool call becomes a `function_call` item
//     `{ call_id, name, arguments }`, its result a `function_call_output`
//     item `{ call_id, output }`;
//   - tools are flat `{ type: 'function', name, description, parameters }`,
//     sent with `strict: false`: the Responses API would otherwise rewrite
//     the schemas of the core into strict mode (every property required),
//     which changes what the model sends for optional arguments;
//   - the answer (`output` items) becomes one chat completion.
//
// Reasoning items: with `store: false`, a reasoning model returns its
// reasoning as opaque `reasoning` items with `encrypted_content`, which
// OpenAI asks to pass back with the function call outputs of the same turn
// (api/docs/guides/reasoning, "Keeping reasoning items in context"). The
// core keeps only the OpenAI fields, so these items are kept here, in
// memory, keyed by the call id of the first function call they preceded, and
// put back before that call when the core sends the turn again. Unknown
// (the integration restarted, a history made by another provider): the call
// goes without them, which OpenAI accepts at some cost in quality. The `id`
// of a function call item is never sent: OpenAI would then demand the
// reasoning item that came with it.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ERROR_KINDS, OpenAiError } from './openai-api.js';

/** The bounds the core applies to a completion (validateAiCompletion). */
const MAX_TOOL_CALLS = 20;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_ID = 128;
/** Ids the core writes when a tool call had none: never sent to OpenAI. */
const PLACEHOLDER_IDS = new Set(['unknown', 'tool_call_unknown']);
/** What a function call without a result gets: OpenAI refuses a lone call. */
export const MISSING_OUTPUT = '{"error":"no result"}';

/**
 * @description A short stable hash.
 * @param {string} value - The value.
 * @returns {string} 24 hex characters.
 */
function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * @description The memory of reasoning items: bounded, entries expire.
 * @param {object} [options] - Options.
 * @param {number} [options.max] - Entries kept at most.
 * @param {number} [options.ttlMs] - Life of an entry.
 * @param {() => number} [options.now] - Clock.
 * @returns {{ remember: Function, recall: Function, size: Function }} The store.
 */
export function createReasoningStore({ max = 500, ttlMs = 6 * 3600_000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    /**
     * @param {string} callId - The call id of the first function call.
     * @param {Array<object>} items - The reasoning items before it.
     */
    remember(callId, items) {
      if (!callId || !Array.isArray(items) || items.length === 0) {
        return;
      }
      entries.delete(callId);
      entries.set(callId, { items, at: now() });
      while (entries.size > max) {
        entries.delete(entries.keys().next().value);
      }
    },
    recall(callId) {
      const entry = entries.get(callId);
      if (!entry) {
        return undefined;
      }
      if (now() - entry.at > ttlMs) {
        entries.delete(callId);
        return undefined;
      }
      return entry.items;
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * @description The text of a content (string or list of parts).
 * @param {unknown} content - An OpenAI content.
 * @returns {string} The text parts joined.
 */
export function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

/**
 * @description Whether a request carries an image.
 * @param {Array<object>} messages - OpenAI messages.
 * @returns {boolean} True when a user message has an image part.
 */
export function hasImages(messages) {
  return (messages ?? []).some(
    (message) =>
      Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url'),
  );
}

/**
 * @description The content of a user message: a string, or input parts when
 * it carries an image.
 * @param {unknown} content - The OpenAI content.
 * @returns {string|Array<object>} The Responses content.
 */
function userContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) {
        parts.push({ type: 'input_text', text: part });
      }
    } else if (part?.type === 'text' && typeof part.text === 'string') {
      if (part.text) {
        parts.push({ type: 'input_text', text: part.text });
      }
    } else if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && url) {
        const detail = part.image_url?.detail;
        parts.push({
          type: 'input_image',
          image_url: url,
          detail: ['low', 'high', 'auto'].includes(detail) ? detail : 'auto',
        });
      }
    }
  }
  if (parts.length === 0) {
    return '';
  }
  return parts.every((part) => part.type === 'input_text')
    ? parts.map((part) => part.text).join('\n')
    : parts;
}

/**
 * @description The arguments of a tool call as the JSON string OpenAI wants.
 * @param {unknown} value - A string or an object.
 * @returns {string} JSON.
 */
function argumentsString(value) {
  if (typeof value === 'string') {
    return value.trim() ? value : '{}';
  }
  return JSON.stringify(value ?? {});
}

/**
 * @description A tool call id the core gave, or null when it is a placeholder.
 * @param {unknown} id - The id.
 * @returns {string|null} The id.
 */
function realId(id) {
  if (typeof id !== 'string' || !id || PLACEHOLDER_IDS.has(id)) {
    return null;
  }
  return id;
}

/**
 * @description OpenAI messages -> Responses `input` items.
 *
 * OpenAI refuses a function call without its output and an output without
 * its call (HTTP 400). The core normally sends them paired; a cut history or
 * a placeholder id should not cost the whole answer, so: a placeholder id
 * gets a stable made-up one (the tool results then take the calls in order),
 * a call left without a result gets {@link MISSING_OUTPUT}, and a result
 * whose call is unknown is dropped.
 * @param {Array<object>} messages - The messages of the core.
 * @param {object} [reasoning] - The reasoning store.
 * @returns {Array<object>} The input items.
 */
export function toResponsesInput(messages, reasoning = createReasoningStore()) {
  const input = [];
  // Calls of the last assistant turn still waiting for their output.
  let pending = [];
  const answered = new Set();

  const closePending = () => {
    for (const callId of pending) {
      if (!answered.has(callId)) {
        input.push({ type: 'function_call_output', call_id: callId, output: MISSING_OUTPUT });
      }
    }
    pending = [];
    answered.clear();
  };

  (messages ?? []).forEach((message, position) => {
    switch (message?.role) {
      case 'system':
      case 'developer': {
        closePending();
        const text = textOf(message.content);
        if (text) {
          input.push({ type: 'message', role: message.role, content: text });
        }
        break;
      }
      case 'user': {
        closePending();
        const content = userContent(message.content);
        if (content.length > 0) {
          input.push({ type: 'message', role: 'user', content });
        }
        break;
      }
      case 'assistant': {
        closePending();
        const text = textOf(message.content);
        if (text) {
          input.push({ type: 'message', role: 'assistant', content: text });
        }
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        calls.forEach((call, index) => {
          const name = String(call?.function?.name ?? '');
          if (!name) {
            return;
          }
          const callId = realId(call?.id) ?? `call_${hash(`${position}-${index}`)}`;
          if (pending.length === 0) {
            for (const item of reasoning.recall(callId) ?? []) {
              input.push(item);
            }
          }
          input.push({
            type: 'function_call',
            call_id: callId,
            name,
            arguments: argumentsString(call?.function?.arguments),
          });
          pending.push(callId);
        });
        break;
      }
      case 'tool': {
        const id = realId(message.tool_call_id);
        const callId =
          id && pending.includes(id) ? id : pending.find((value) => !answered.has(value));
        if (!callId || answered.has(callId)) {
          // A result without its call: OpenAI would refuse the whole request.
          break;
        }
        answered.add(callId);
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: typeof message.content === 'string' ? message.content : textOf(message.content),
        });
        break;
      }
      default:
        // An unknown role is dropped: OpenAI would refuse the whole request.
        break;
    }
  });
  closePending();
  return input;
}

/**
 * @description OpenAI chat tools -> Responses function tools.
 * @param {Array<object>} tools - The tools of the core.
 * @returns {Array<object>} The tools.
 */
export function toResponsesTools(tools) {
  return (tools ?? [])
    .filter((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string')
    .map((tool) => {
      const parameters = tool.function.parameters;
      const out = {
        type: 'function',
        name: tool.function.name,
        parameters:
          parameters && typeof parameters === 'object' && !Array.isArray(parameters)
            ? parameters
            : { type: 'object', properties: {} },
        strict: false,
      };
      if (typeof tool.function.description === 'string' && tool.function.description) {
        out.description = tool.function.description;
      }
      return out;
    });
}

/**
 * @description OpenAI chat tool_choice -> Responses tool_choice.
 * @param {unknown} choice - `auto`, `none`, `required` or `{ type, function }`.
 * @returns {string|object|undefined} The value to send, undefined for the default.
 */
export function toResponsesToolChoice(choice) {
  if (choice === 'required' || choice === 'any') {
    return 'required';
  }
  if (choice === 'auto' || choice === 'none') {
    return choice;
  }
  if (choice && typeof choice === 'object' && typeof choice.function?.name === 'string') {
    return { type: 'function', name: choice.function.name };
  }
  return undefined;
}

/**
 * @description The chat usage of a Responses usage. Reasoning tokens are
 * billed as output and already counted in `output_tokens`.
 * @param {object} usage - The Responses usage.
 * @returns {object} `{ prompt_tokens, completion_tokens, total_tokens }`.
 */
export function toOpenAiUsage(usage) {
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const prompt = number(usage?.input_tokens);
  const completion = number(usage?.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: number(usage?.total_tokens) || prompt + completion,
  };
}

/**
 * @description A Responses `Response` -> the chat completion the core reads.
 * The reasoning items before the first function call are remembered on the
 * way.
 * @param {object} response - The Response object.
 * @param {object} [options] - Options.
 * @param {object} [options.reasoning] - The reasoning store.
 * @param {string} [options.model] - The model id (for the completion).
 * @returns {object} `{ id, object, model, choices: [{ message, finish_reason }],
 * usage, openai_status }` — `openai_status` is `completed`, or the reason of
 * an incomplete answer (`max_output_tokens`, `content_filter`…), or `refusal`.
 */
export function toOpenAiCompletion(response, { reasoning = createReasoningStore(), model } = {}) {
  if (response?.status === 'failed') {
    const message = String(response?.error?.message ?? 'the response failed');
    throw new OpenAiError(ERROR_KINDS.SERVER, `OpenAI could not answer: ${message.slice(0, 300)}`);
  }
  const output = Array.isArray(response?.output) ? response.output : [];
  const responseId = String(response?.id ?? hash(JSON.stringify(output)));

  let text = '';
  let refusal = '';
  const toolCalls = [];
  let reasoningItems = [];
  let firstCallSeen = false;
  output.forEach((item, index) => {
    if (item?.type === 'reasoning') {
      if (!firstCallSeen && typeof item.encrypted_content === 'string') {
        // Only what the API needs to accept it again.
        reasoningItems.push({
          type: 'reasoning',
          id: item.id,
          summary: Array.isArray(item.summary) ? item.summary : [],
          encrypted_content: item.encrypted_content,
        });
      }
      return;
    }
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
        } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
          refusal += part.refusal;
        }
      }
      return;
    }
    if (item?.type !== 'function_call' || !TOOL_NAME.test(String(item.name ?? ''))) {
      return;
    }
    if (toolCalls.length >= MAX_TOOL_CALLS) {
      return;
    }
    const id =
      typeof item.call_id === 'string' && item.call_id && item.call_id.length <= MAX_ID
        ? item.call_id
        : `call_${hash(`${responseId}-${index}`)}`;
    if (!firstCallSeen) {
      firstCallSeen = true;
      reasoning.remember(id, reasoningItems);
      reasoningItems = [];
    }
    toolCalls.push({
      id,
      type: 'function',
      function: { name: item.name, arguments: argumentsString(item.arguments) },
    });
  });

  let status = 'completed';
  if (response?.status === 'incomplete') {
    status = String(response?.incomplete_details?.reason ?? 'incomplete');
  } else if (!text && toolCalls.length === 0 && refusal) {
    status = 'refusal';
  }

  let finish = 'stop';
  if (status === 'max_output_tokens') {
    finish = 'length';
  } else if (status === 'content_filter' || status === 'refusal') {
    finish = 'content_filter';
  } else if (toolCalls.length > 0) {
    finish = 'tool_calls';
  }

  const message = { role: 'assistant', content: text || (toolCalls.length > 0 ? null : '') };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: responseId,
    object: 'chat.completion',
    model: response?.model ?? model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: toOpenAiUsage(response?.usage),
    openai_status: status,
    openai_refusal: refusal || undefined,
  };
}
