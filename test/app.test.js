// The whole integration against the fake Gladys of the SDK
// (`@gladysassistant/integration-sdk/testing`) and a fake OpenAI API
// (test/helpers/fake-openai.js), a real HTTP server on 127.0.0.1. No test
// touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import {
  AI_CHAT_PURPOSES,
  validateAiCompletion,
  validateWidgetContent,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, createApp } from '../src/app.js';
import { TRIGGERS } from '../src/events.js';
import { WIDGETS } from '../src/widgets.js';
import { API_KEY, openAiError, startFakeOpenAi } from './helpers/fake-openai.js';

const start = async (t, config = { api_key: API_KEY }) => {
  const api = await startFakeOpenAi();
  const dir = await mkdtemp(join(tmpdir(), 'openai-app-'));
  const gladys = createFakeGladys({ config });
  const app = createApp(gladys, {
    baseUrl: api.url,
    sleep: async () => {},
    usageFile: join(dir, 'usage.json'),
    timeZone: 'Europe/Paris',
  });
  await gladys.connect();
  await app.whenReady();
  t.after(async () => {
    app.usage.stop();
    await gladys.disconnect?.();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { api, gladys, app };
};

test('connects: checks both models without spending a token, status OK', async (t) => {
  const { api, gladys } = await start(t);
  assert.deepEqual(
    api.requests.map((r) => r.path),
    ['/v1/models/gpt-6.1-terra', '/v1/models/gpt-6-luna'],
  );
  assert.equal(
    gladys.fake.connectionStatus?.connected ?? gladys.fake.connectionStatuses.at(-1)?.connected,
    true,
  );
});

test('without a key: status explains it, nothing is called', async (t) => {
  const { api, gladys } = await start(t, {});
  assert.equal(api.requests.length, 0);
  const status = gladys.fake.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(JSON.stringify(status), /platform\.openai\.com/);
});

test('answers the AI requests of the core with valid completions', async (t) => {
  const { api, gladys } = await start(t);
  const ack = await gladys.fake.aiChat({
    messages: [{ role: 'user', content: 'Bonjour' }],
    tools: [
      { type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } },
    ],
    tool_choice: 'auto',
    purpose: AI_CHAT_PURPOSES.CHAT,
  });
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(validateAiCompletion(ack.data), []);
  assert.equal(ack.data.choices[0].message.content, 'Bonjour !');
  assert.equal(api.requests.at(-1).body.tool_choice, 'auto');
});

test('a failing provider: the ack fails, one error event, status down, then recovery', async (t) => {
  const { api, gladys } = await start(t);
  for (let i = 0; i < 3; i += 1) {
    api.reply('POST responses', {
      status: 401,
      body: openAiError('Your API key has been revoked.', { code: 'invalid_api_key' }),
    });
  }
  for (let i = 0; i < 3; i += 1) {
    const ack = await gladys.fake.aiChat({
      messages: [{ role: 'user', content: 'x' }],
      purpose: 'chat',
    });
    assert.equal(ack.success, false);
  }
  await tick();
  const errors = gladys.fake.sceneEvents.filter(
    (event) => (event.key ?? event.event_key) === TRIGGERS.ERROR,
  );
  assert.equal(errors.length, 1, JSON.stringify(gladys.fake.sceneEvents));
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, false);
  const ack = await gladys.fake.aiChat({
    messages: [{ role: 'user', content: 'x' }],
    purpose: 'chat',
  });
  assert.equal(ack.success, true);
  await tick();
  assert.ok(
    gladys.fake.sceneEvents.some((event) => (event.key ?? event.event_key) === TRIGGERS.RECOVERED),
  );
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, true);
});

test('the test button names a project without credit', async (t) => {
  const { api, gladys } = await start(t);
  api.reply('POST responses', {
    status: 429,
    body: openAiError('You exceeded your current quota.', {
      type: 'insufficient_quota',
      code: 'credit_balance_exhausted',
    }),
  });
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Chat — OpenAI refuses to run GPT-6\.1 Terra: no credit left/);
  assert.match(ack.data.message.en, /Router — GPT-6 Luna answered in/);
  const tests = api.requests.filter((request) => request.route === 'POST responses');
  assert.deepEqual(
    tests.map((request) => request.body.reasoning),
    [{ effort: 'none' }, { effort: 'none' }],
  );
  assert.ok(tests.every((request) => request.body.store === false));
});

test('the test button answers with each model and its time', async (t) => {
  const { gladys } = await start(t);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  assert.equal(ack.success, true);
  const text = ack.data.message.fr;
  assert.match(text, /Discussion — GPT-6\.1 Terra a répondu en/);
  assert.match(text, /Routeur — GPT-6 Luna a répondu en/);
});

test('the widget counts what was asked, valid in every language', async (t) => {
  const { gladys } = await start(t);
  await gladys.fake.aiChat({
    messages: [{ role: 'user', content: 'x' }],
    purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION,
  });
  await gladys.fake.aiChat({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' });
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await gladys.fake.widgetGet(WIDGETS.USAGE, { language });
    assert.equal(ack.success, true);
    assert.deepEqual(validateWidgetContent(ack.data.content), [], language);
    assert.equal(ack.data.content.components.find((c) => c.type === 'value').value, 2);
  }
});

test('a new configuration is applied and checked at once', async (t) => {
  const { api, gladys, app } = await start(t);
  api.reply('GET model', {
    status: 404,
    body: openAiError('The model `gpt-9-preview` does not exist', { code: 'model_not_found' }),
  });
  await gladys.fake.configUpdated({
    api_key: API_KEY,
    model: 'custom',
    custom_model: 'gpt-9-preview',
  });
  assert.equal(app.getConfig().model, 'custom');
  const status = gladys.fake.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(JSON.stringify(status), /gpt-9-preview/);
});
