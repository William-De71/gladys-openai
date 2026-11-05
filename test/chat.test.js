import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_CHAT_PURPOSES, validateAiCompletion } from '@gladysassistant/integration-sdk';
import { buildRequest, createChatHandler, useOf } from '../src/chat.js';
import { normalizeConfig } from '../src/config.js';
import { createReasoningStore } from '../src/convert.js';
import { createOpenAiClient, ERROR_KINDS } from '../src/openai-api.js';
import {
  API_KEY,
  callItem,
  messageItem,
  openAiError,
  reasoningItem,
  responded,
  startFakeOpenAi,
} from './helpers/fake-openai.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'device_set_value',
      description: 'Set a value',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const setup = async (t, raw = {}) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const config = normalizeConfig({ api_key: API_KEY, ...raw });
  const client = createOpenAiClient({
    getApiKey: () => config.api_key,
    baseUrl: api.url,
    sleep: async () => {},
  });
  const recorded = { success: [], error: [], failures: [], successes: 0 };
  const usage = {
    recordSuccess: (entry) => recorded.success.push(entry),
    recordError: (entry) => recorded.error.push(entry),
  };
  const reasoning = createReasoningStore();
  const handler = createChatHandler({
    client,
    getConfig: () => config,
    usage,
    reasoning,
    onFailure: (err, context) => recorded.failures.push({ kind: err.kind, ...context }),
    onSuccess: () => {
      recorded.successes += 1;
    },
  });
  return { api, handler, recorded, config, reasoning };
};

test('the router gets the fast model without reasoning; the chat the main model with tools', async (t) => {
  const { api, handler, recorded } = await setup(t);
  await handler({
    messages: [
      { role: 'system', content: 'Classify' },
      { role: 'user', content: 'Allume' },
    ],
    purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION,
  });
  const router = api.requests[0].body;
  assert.equal(router.model, 'gpt-6-luna');
  assert.deepEqual(router.reasoning, { effort: 'none' });
  assert.equal(router.tools, undefined);
  assert.deepEqual(router.input[0], { type: 'message', role: 'system', content: 'Classify' });
  assert.equal(router.store, false);
  assert.equal(router.prompt_cache_key, 'gladys-router');

  const answer = await handler({
    messages: [{ role: 'user', content: 'Allume le salon' }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 2000,
    purpose: AI_CHAT_PURPOSES.CHAT,
    categories: ['devices'],
  });
  const chat = api.requests[1].body;
  assert.equal(chat.model, 'gpt-6.1-terra');
  assert.deepEqual(chat.reasoning, { effort: 'low' });
  assert.equal(chat.tool_choice, 'required');
  assert.equal(chat.tools[0].name, 'device_set_value');
  assert.equal(chat.tools[0].strict, false);
  assert.equal(chat.max_output_tokens, 16000, 'the configured budget');
  assert.equal(chat.prompt_cache_key, 'gladys-chat');
  assert.equal(chat.purpose, undefined);
  assert.equal(chat.categories, undefined);
  assert.equal(chat.temperature, undefined, 'refused by reasoning models');
  assert.deepEqual(validateAiCompletion(answer), []);
  assert.equal(answer.choices[0].message.content, 'Bonjour !');
  assert.equal(answer.openai_status, undefined, 'internal fields stay inside');
  assert.deepEqual(
    recorded.success.map((entry) => entry.use),
    ['router', 'chat'],
  );
  assert.equal(recorded.successes, 2);
});

test('a model that cannot turn reasoning off gets low; an unknown one gets nothing', () => {
  const known = buildRequest(
    { messages: [{ role: 'user', content: 'x' }], purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION },
    normalizeConfig({ api_key: 'k', fast_model: 'custom', custom_model: 'gpt-6.1-sol' }),
  );
  assert.equal(known.model, 'gpt-6.1-sol');
  assert.deepEqual(known.reasoning, { effort: 'low' }, 'a listed model typed by hand');
  const body = buildRequest(
    { messages: [{ role: 'user', content: 'x' }], purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION },
    normalizeConfig({ api_key: 'k', fast_model: 'custom', custom_model: 'gpt-6.2-nova' }),
  );
  assert.equal(body.reasoning, undefined, 'an unknown model asked for none gets nothing');
  const sol = buildRequest(
    { messages: [{ role: 'user', content: 'x' }], purpose: 'chat' },
    normalizeConfig({ api_key: 'k', model: 'gpt-6.1-sol', reasoning: 'none' }),
  );
  assert.deepEqual(sol.reasoning, { effort: 'low' });
});

test('the purposes are counted as router, digest or chat', () => {
  assert.equal(useOf(AI_CHAT_PURPOSES.INTENT_CLASSIFICATION), 'router');
  assert.equal(useOf(AI_CHAT_PURPOSES.WEEKLY_DIGEST), 'digest');
  assert.equal(useOf(AI_CHAT_PURPOSES.CHAT), 'chat');
  assert.equal(useOf(undefined), 'chat');
});

test('no tools: neither tools nor tool_choice is sent; no message at all is refused', () => {
  const body = buildRequest(
    { messages: [{ role: 'user', content: 'x' }], tools: [], tool_choice: 'auto' },
    normalizeConfig({ api_key: 'k' }),
  );
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.throws(
    () => buildRequest({ messages: [] }, normalizeConfig({ api_key: 'k' })),
    (err) => err.kind === ERROR_KINDS.REQUEST,
  );
});

test('the reasoning of a tool call comes back when the core sends the turn again', async (t) => {
  const { api, handler } = await setup(t);
  api.reply('POST responses', {
    status: 200,
    body: responded([reasoningItem('ENC-A'), callItem('device_set_value', { value: 1 }, 'call_A')]),
  });
  const first = await handler({
    messages: [{ role: 'user', content: 'Allume' }],
    tools: TOOLS,
    purpose: 'chat',
  });
  const call = first.choices[0].message.tool_calls[0];
  assert.equal(call.id, 'call_A');
  assert.equal(call.function.arguments, '{"value":1}');
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(first.choices[0].message.content, null);

  await handler({
    messages: [
      { role: 'user', content: 'Allume' },
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_A', content: 'done' },
    ],
    tools: TOOLS,
    purpose: 'chat',
  });
  const { input } = api.requests[1].body;
  assert.deepEqual(input.slice(1), [
    { type: 'reasoning', id: 'rs_0193', summary: [], encrypted_content: 'ENC-A' },
    {
      type: 'function_call',
      call_id: 'call_A',
      name: 'device_set_value',
      arguments: '{"value":1}',
    },
    { type: 'function_call_output', call_id: 'call_A', output: 'done' },
  ]);
});

test('a custom model that refuses the reasoning effort is asked again without it, then never', async (t) => {
  const { api, handler } = await setup(t, { model: 'custom', custom_model: 'gpt-4.1' });
  api.reply('POST responses', {
    status: 400,
    body: openAiError(
      "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      {
        param: 'reasoning.effort',
        code: 'unsupported_parameter',
      },
    ),
  });
  const answer = await handler({
    messages: [{ role: 'user', content: 'Bonjour' }],
    purpose: 'chat',
  });
  assert.equal(answer.choices[0].message.content, 'Bonjour !');
  assert.deepEqual(api.requests[0].body.reasoning, { effort: 'low' });
  assert.equal(api.requests[1].body.reasoning, undefined);
  await handler({ messages: [{ role: 'user', content: 'Encore' }], purpose: 'chat' });
  assert.equal(api.requests[2].body.reasoning, undefined);
});

test('failures are thrown (the core names them), counted and reported once each', async (t) => {
  const { api, handler, recorded } = await setup(t);
  api.reply('POST responses', {
    status: 429,
    body: openAiError('You exceeded your current quota.', {
      type: 'insufficient_quota',
      code: 'credit_balance_exhausted',
    }),
  });
  await assert.rejects(
    handler({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' }),
    (err) => err.kind === ERROR_KINDS.BILLING,
  );
  assert.deepEqual(recorded.failures, [{ kind: 'billing', use: 'chat', model: 'gpt-6.1-terra' }]);
  assert.equal(recorded.error[0].kind, 'billing');
  assert.equal(api.requests.length, 1, 'a billing failure is not retried');

  api.reply('POST responses', {
    status: 400,
    body: openAiError('Invalid image data.', { param: 'input' }),
  });
  await assert.rejects(
    handler({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } }],
        },
      ],
      purpose: 'chat',
    }),
    /Invalid image data.*carried an image/,
  );
});

test('an answer cut before any text fails clearly; a cut text is still returned', async (t) => {
  const { api, handler } = await setup(t);
  api.reply('POST responses', {
    status: 200,
    body: responded([reasoningItem()], {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }),
  });
  await assert.rejects(
    handler({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' }),
    /cut at max_tokens \(16000\)/,
  );
  api.reply('POST responses', {
    status: 200,
    body: responded([messageItem('Le début')], {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }),
  });
  const answer = await handler({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' });
  assert.equal(answer.choices[0].message.content, 'Le début');
  assert.equal(answer.choices[0].finish_reason, 'length');
});

test('a refusal, a filtered or an empty answer fail with their reason', async (t) => {
  const { api, handler, recorded } = await setup(t);
  api.reply('POST responses', {
    status: 200,
    body: responded([
      { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] },
    ]),
  });
  await assert.rejects(
    handler({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' }),
    (err) => err.kind === ERROR_KINDS.REQUEST && /refused to answer: No\./.test(err.message),
  );
  assert.equal(recorded.failures[0].kind, 'request');
  api.reply('POST responses', {
    status: 200,
    body: responded([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
  });
  await assert.rejects(
    handler({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' }),
    (err) => err.kind === ERROR_KINDS.REQUEST && /content_filter/.test(err.message),
  );
  api.reply('POST responses', { status: 200, body: responded([]) });
  await assert.rejects(
    handler({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' }),
    (err) => err.kind === ERROR_KINDS.SERVER && /empty answer/.test(err.message),
  );
});

test('a custom model without id fails without calling OpenAI', async (t) => {
  const { api, handler } = await setup(t, { fast_model: 'custom' });
  await assert.rejects(
    handler({
      messages: [{ role: 'user', content: 'x' }],
      purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION,
    }),
    (err) => err.kind === ERROR_KINDS.MODEL,
  );
  assert.equal(api.requests.length, 0);
});
