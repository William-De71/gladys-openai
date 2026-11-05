import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiCompletion } from '@gladysassistant/integration-sdk';
import {
  createReasoningStore,
  hasImages,
  MISSING_OUTPUT,
  textOf,
  toOpenAiCompletion,
  toOpenAiUsage,
  toResponsesInput,
  toResponsesToolChoice,
  toResponsesTools,
} from '../src/convert.js';
import { callItem, messageItem, reasoningItem, responded } from './helpers/fake-openai.js';

test('the messages of a tool-calling turn of the core convert to Responses items', () => {
  const input = toResponsesInput([
    { role: 'system', content: 'You are Gladys.' },
    { role: 'user', content: 'Allume le salon' },
    {
      role: 'assistant',
      content: 'Je regarde.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'device_set_value', arguments: '{"room":"salon"}' },
        },
        {
          id: 'call_2',
          type: 'function',
          function: { name: 'device_get_state', arguments: { room: 'salon' } },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: '{"on":true}' }] },
    { role: 'user', content: 'Merci' },
    { role: 'function', content: 'legacy' },
  ]);
  assert.deepEqual(input, [
    { type: 'message', role: 'system', content: 'You are Gladys.' },
    { type: 'message', role: 'user', content: 'Allume le salon' },
    { type: 'message', role: 'assistant', content: 'Je regarde.' },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'device_set_value',
      arguments: '{"room":"salon"}',
    },
    {
      type: 'function_call',
      call_id: 'call_2',
      name: 'device_get_state',
      arguments: '{"room":"salon"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    { type: 'function_call_output', call_id: 'call_2', output: '{"on":true}' },
    { type: 'message', role: 'user', content: 'Merci' },
  ]);
  assert.ok(
    input.every((item) => item.id === undefined),
    'no item id: OpenAI would then demand the reasoning item stored with it',
  );
});

test('placeholder ids, missing results and orphan results never break the pairing', () => {
  const input = toResponsesInput([
    { role: 'user', content: 'x' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'unknown', type: 'function', function: { name: 'a', arguments: '' } },
        { id: 'tool_call_unknown', type: 'function', function: { name: 'b', arguments: '{}' } },
        { id: 'call_3', type: 'function', function: { name: 'c', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'unknown', content: 'A done' },
    { role: 'tool', tool_call_id: 'nobody', content: 'B done' },
    { role: 'user', content: 'and?' },
    { role: 'tool', tool_call_id: 'call_9', content: 'orphan' },
  ]);
  const calls = input.filter((item) => item.type === 'function_call');
  const outputs = input.filter((item) => item.type === 'function_call_output');
  assert.equal(calls.length, 3);
  assert.match(calls[0].call_id, /^call_[0-9a-f]{24}$/);
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  assert.equal(calls[0].arguments, '{}', 'empty arguments become an empty object');
  assert.deepEqual(
    outputs.map((item) => [item.call_id, item.output]),
    [
      [calls[0].call_id, 'A done'],
      [calls[1].call_id, 'B done'],
      ['call_3', MISSING_OUTPUT],
    ],
    'results take the calls in order; a call left alone gets a placeholder result',
  );
  assert.ok(
    input.indexOf(outputs[2]) < input.findIndex((item) => item.content === 'and?'),
    'the placeholder result comes before the next user message',
  );
  assert.ok(!input.some((item) => item.output === 'orphan'), 'an orphan result is dropped');
  // The ids made up for placeholders are stable from one request to the next.
  assert.deepEqual(
    toResponsesInput([
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'unknown', type: 'function', function: { name: 'a', arguments: '' } }],
      },
    ])[1].call_id,
    calls[0].call_id,
  );
});

test('images: data URLs become input images, an empty message no item', () => {
  const input = toResponsesInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Qui est à la porte ?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==', detail: 'low' } },
        { type: 'image_url', image_url: 'https://example.com/a.jpg' },
      ],
    },
    { role: 'user', content: '' },
    { role: 'user', content: [{ type: 'text', text: 'a' }, 'b'] },
  ]);
  assert.deepEqual(input, [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Qui est à la porte ?' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AA==', detail: 'low' },
        { type: 'input_image', image_url: 'https://example.com/a.jpg', detail: 'auto' },
      ],
    },
    { type: 'message', role: 'user', content: 'a\nb' },
  ]);
  assert.equal(hasImages([{ role: 'user', content: [{ type: 'image_url' }] }]), true);
  assert.equal(hasImages([{ role: 'user', content: 'x' }]), false);
});

test('reasoning: remembered from an answer, put back before the same calls', () => {
  const reasoning = createReasoningStore();
  const completion = toOpenAiCompletion(
    responded([
      reasoningItem('ENC-1'),
      messageItem('Je lance.'),
      callItem('a', {}, 'call_A'),
      reasoningItem('ENC-2'),
      callItem('b', { x: 2 }, 'call_B'),
    ]),
    { reasoning },
  );
  const message = completion.choices[0].message;
  assert.equal(message.content, 'Je lance.');
  assert.deepEqual(
    message.tool_calls.map((call) => [call.id, call.function.name, call.function.arguments]),
    [
      ['call_A', 'a', '{}'],
      ['call_B', 'b', '{"x":2}'],
    ],
  );
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(validateAiCompletion(completion), []);

  const input = toResponsesInput(
    [
      { role: 'user', content: 'x' },
      { role: 'assistant', ...message },
      { role: 'tool', tool_call_id: 'call_A', content: 'ok' },
      { role: 'tool', tool_call_id: 'call_B', content: 'ok' },
    ],
    reasoning,
  );
  assert.deepEqual(
    input.map((item) => item.type),
    [
      'message',
      'message',
      'reasoning',
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
    ],
  );
  assert.deepEqual(input[2], {
    type: 'reasoning',
    id: 'rs_0193',
    summary: [],
    encrypted_content: 'ENC-1',
  });
});

test('a call never seen goes without reasoning; the store is bounded and forgets', () => {
  const input = toResponsesInput(
    [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_Z', type: 'function', function: { name: 'a', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_Z', content: 'ok' },
    ],
    createReasoningStore(),
  );
  assert.ok(!input.some((item) => item.type === 'reasoning'));

  let now = 0;
  const store = createReasoningStore({ max: 2, ttlMs: 1000, now: () => now });
  store.remember('a', [{ type: 'reasoning' }]);
  store.remember('b', [{ type: 'reasoning' }]);
  store.remember('c', [{ type: 'reasoning' }]);
  assert.equal(store.size(), 2);
  assert.equal(store.recall('a'), undefined);
  assert.equal(store.recall('c').length, 1);
  store.remember('d', []);
  store.remember('e', undefined);
  assert.equal(store.size(), 2);
  now = 2000;
  assert.equal(store.recall('c'), undefined);
});

test('tools: flat functions, strict mode left off, a schema always set', () => {
  const schema = {
    type: 'object',
    properties: { room: { type: 'string', enum: ['salon'] } },
    required: ['room'],
  };
  assert.deepEqual(
    toResponsesTools([
      { type: 'function', function: { name: 'a', description: 'Do A', parameters: schema } },
      { type: 'function', function: { name: 'b' } },
      { type: 'other' },
    ]),
    [
      { type: 'function', name: 'a', description: 'Do A', parameters: schema, strict: false },
      {
        type: 'function',
        name: 'b',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
    ],
  );
  assert.deepEqual(toResponsesTools(undefined), []);
});

test('tool_choice: the same words, a named function flattened', () => {
  assert.equal(toResponsesToolChoice('required'), 'required');
  assert.equal(toResponsesToolChoice('any'), 'required');
  assert.equal(toResponsesToolChoice('auto'), 'auto');
  assert.equal(toResponsesToolChoice('none'), 'none');
  assert.deepEqual(toResponsesToolChoice({ type: 'function', function: { name: 'x' } }), {
    type: 'function',
    name: 'x',
  });
  assert.equal(toResponsesToolChoice(undefined), undefined);
});

test('answers: statuses, refusals, bounds of the core, usage', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    callItem(i === 0 ? 'bad name!' : 'tool', {}, `call_${i}`),
  );
  const completion = toOpenAiCompletion(
    responded(many, {
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    }),
  );
  assert.equal(completion.choices[0].message.tool_calls.length, 20);
  assert.equal(completion.choices[0].message.content, null);
  assert.deepEqual(validateAiCompletion(completion), []);
  assert.deepEqual(completion.usage, {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  });

  const cut = toOpenAiCompletion(
    responded([messageItem('a')], {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }),
  );
  assert.equal(cut.choices[0].finish_reason, 'length');
  assert.equal(cut.openai_status, 'max_output_tokens');
  const filtered = toOpenAiCompletion(
    responded([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
  );
  assert.equal(filtered.choices[0].finish_reason, 'content_filter');
  assert.equal(filtered.choices[0].message.content, '');
  const refused = toOpenAiCompletion(
    responded([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
      },
    ]),
  );
  assert.equal(refused.openai_status, 'refusal');
  assert.equal(refused.openai_refusal, 'I cannot help with that.');
  assert.equal(refused.choices[0].finish_reason, 'content_filter');
  assert.throws(
    () => toOpenAiCompletion({ status: 'failed', error: { message: 'boom' } }),
    /could not answer: boom/,
  );
  assert.deepEqual(toOpenAiUsage(undefined), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

test('textOf reads strings and text parts', () => {
  assert.equal(textOf('a'), 'a');
  assert.equal(textOf([{ type: 'text', text: 'a' }, 'b', { type: 'image_url' }]), 'ab');
  assert.equal(textOf(null), '');
});
