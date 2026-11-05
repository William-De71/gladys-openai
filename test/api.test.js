import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codeOf,
  createOpenAiClient,
  ERROR_KINDS,
  errorMessageOf,
  kindOfStatus,
  maskKeys,
  OpenAiError,
  parseRetryAfter,
} from '../src/openai-api.js';
import { API_KEY, openAiError, startFakeOpenAi } from './helpers/fake-openai.js';

const client = (api, options = {}) => {
  const waits = [];
  const instance = createOpenAiClient({
    getApiKey: () => options.key ?? API_KEY,
    baseUrl: api.url,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { instance, waits };
};

const HI = { model: 'gpt-6-luna', input: 'hi', store: false };

test('sends the key as a Bearer token, never in the URL', async (t) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const { instance } = client(api);
  const body = await instance.createResponse(HI);
  assert.equal(body.output[0].content[0].text, 'Bonjour !');
  assert.equal(api.requests[0].apiKey, API_KEY);
  assert.equal(api.requests[0].path, '/v1/responses');
  assert.deepEqual(api.requests[0].body, HI);
  assert.ok(!api.requests[0].path.includes(API_KEY));
  const model = await instance.getModel('gpt-6-luna');
  assert.equal(model.id, 'gpt-6-luna');
  assert.equal(api.requests[1].path, '/v1/models/gpt-6-luna');
});

test('no key: fails before any request', async (t) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const { instance } = client(api, { key: '' });
  await assert.rejects(
    instance.createResponse(HI),
    (err) => err instanceof OpenAiError && err.kind === ERROR_KINDS.AUTH,
  );
  assert.equal(api.requests.length, 0);
});

test('HTTP failures become error kinds, the key never in the message', async (t) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const { instance } = client(api, { key: 'sk-proj-WrongKey0123456789abcdefghijkl' });
  await assert.rejects(
    instance.createResponse(HI),
    (err) =>
      err.kind === ERROR_KINDS.AUTH &&
      /HTTP 401 invalid_api_key: Incorrect API key provided/.test(err.message) &&
      !err.message.includes('WrongKey') &&
      !err.message.includes('ijkl'),
  );
  const good = client(api).instance;
  api.reply('GET model', {
    status: 404,
    body: openAiError('The model `gpt-9` does not exist or you do not have access to it.', {
      code: 'model_not_found',
    }),
  });
  await assert.rejects(good.getModel('gpt-9'), (err) => err.kind === ERROR_KINDS.MODEL);
  api.reply('POST responses', {
    status: 400,
    body: openAiError(
      "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      {
        param: 'reasoning.effort',
      },
    ),
  });
  await assert.rejects(
    good.createResponse(HI),
    (err) => err.kind === ERROR_KINDS.REQUEST && /reasoning\.effort/.test(err.message),
  );
  api.reply('POST responses', {
    status: 403,
    body: openAiError('Country, region, or territory not supported', {
      code: 'unsupported_country_region_territory',
    }),
  });
  await assert.rejects(good.createResponse(HI), (err) => err.kind === ERROR_KINDS.AUTH);
  api.reply('POST responses', { status: 200, body: 'not json' });
  await assert.rejects(
    good.createResponse(HI, { retries: false }),
    (err) => err.kind === ERROR_KINDS.SERVER,
  );
});

test('a billing 429 fails at once: waiting never brings credits back', async (t) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const { instance, waits } = client(api);
  for (const code of ['credit_balance_exhausted', 'project_spend_limit_exceeded']) {
    api.reply('POST responses', {
      status: 429,
      body: openAiError('You exceeded your current quota.', { type: 'insufficient_quota', code }),
    });
    await assert.rejects(
      instance.createResponse(HI),
      (err) => err.kind === ERROR_KINDS.BILLING && err.code === code,
    );
  }
  assert.equal(api.requests.length, 2);
  assert.deepEqual(waits, []);
});

test('429 and 5xx are retried with Retry-After or backoff, then give up', async (t) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const { instance, waits } = client(api);
  api.reply('POST responses', {
    status: 429,
    headers: { 'retry-after': '2' },
    body: openAiError('Rate limit reached for requests', {
      type: 'requests',
      code: 'rate_limit_exceeded',
    }),
  });
  api.reply('POST responses', {
    status: 503,
    body: openAiError('The model is temporarily overloaded', {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
    }),
  });
  const body = await instance.createResponse(HI);
  assert.equal(body.status, 'completed');
  assert.deepEqual(waits, [2000, 2000]);
  for (let i = 0; i < 3; i += 1) {
    api.reply('POST responses', {
      status: 429,
      body: openAiError('Slow down', { type: 'rate_limit_error', code: 'slow_down' }),
    });
  }
  await assert.rejects(instance.createResponse(HI), (err) => err.kind === ERROR_KINDS.RATE_LIMIT);
  assert.equal(api.requests.length, 6);
  // The connection check never retries.
  api.reply('GET model', {
    status: 500,
    body: openAiError('server error', { type: 'server_error' }),
  });
  await assert.rejects(instance.getModel('x'), (err) => err.kind === ERROR_KINDS.SERVER);
  assert.equal(api.requests.length, 7);
});

test('a wait that would not fit in the deadline fails at once with the real reason', async (t) => {
  const api = await startFakeOpenAi();
  t.after(api.close);
  const { instance, waits } = client(api);
  api.reply('POST responses', {
    status: 429,
    headers: { 'retry-after': '37' },
    body: openAiError('Rate limit reached for tokens per min', { code: 'rate_limit_exceeded' }),
  });
  await assert.rejects(
    instance.createResponse(HI, { timeoutMs: 18_000 }),
    (err) => err.kind === ERROR_KINDS.RATE_LIMIT,
  );
  assert.deepEqual(waits, []);
});

test('an unreachable API and a timeout are named as such', async () => {
  const unreachable = createOpenAiClient({
    getApiKey: () => 'k',
    baseUrl: 'http://127.0.0.1:9/v1',
    sleep: async () => {},
  });
  await assert.rejects(
    unreachable.createResponse(HI, { retries: false }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const slow = createOpenAiClient({
    getApiKey: () => 'k',
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  // AbortSignal.timeout does not keep the process alive: this timer does.
  const hold = setTimeout(() => {}, 1000);
  await assert.rejects(
    slow.createResponse(HI, { timeoutMs: 50, retries: false }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
  clearTimeout(hold);
});

test('error bodies and Retry-After are read safely, keys masked', () => {
  assert.equal(
    errorMessageOf({ error: { message: 'Incorrect API key provided: sk-proj-****abcd.' } }),
    'Incorrect API key provided: sk-***.',
  );
  assert.equal(maskKeys('Authorization: Bearer sk-abc123'), 'Authorization: Bearer ***');
  assert.equal(errorMessageOf('x'.repeat(500)).length, 300);
  assert.equal(codeOf(openAiError('m', { code: 'model_not_found' })), 'model_not_found');
  assert.equal(codeOf({ error: 'flat' }), '');
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(kindOfStatus(402), ERROR_KINDS.BILLING);
  assert.equal(
    kindOfStatus(429, openAiError('quota', { type: 'insufficient_quota' })),
    ERROR_KINDS.BILLING,
  );
  assert.equal(
    kindOfStatus(403, openAiError('You do not have access to the model gpt-6-astra')),
    ERROR_KINDS.MODEL,
  );
  assert.equal(kindOfStatus(403, openAiError('Forbidden')), ERROR_KINDS.AUTH);
  assert.equal(kindOfStatus(429), ERROR_KINDS.RATE_LIMIT);
  assert.equal(kindOfStatus(500), ERROR_KINDS.SERVER);
  assert.equal(kindOfStatus(400), ERROR_KINDS.REQUEST);
});
