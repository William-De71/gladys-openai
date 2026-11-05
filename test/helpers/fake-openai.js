// -----------------------------------------------------------------------------
// A fake OpenAI API on 127.0.0.1, for the tests: real HTTP, no network.
//
// Every request is recorded (`requests`); the answer of each route comes from
// a queue of handlers (`reply(route, handler)`), or a default one. A handler
// returns `{ status, body, headers }`. The fixtures follow the API reference
// of POST /v1/responses and GET /v1/models/{model}
// (developers.openai.com/api/reference, checked 2026-11-05): they are not
// captured from the real API.
//
// `node --test` also runs this file: nothing starts on import.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';

export const API_KEY = 'sk-proj-TestOpenAiKey0123456789abcdefghij';

/**
 * @description An assistant message output item.
 * @param {string} text - The text.
 * @returns {object} The item.
 */
export function messageItem(text) {
  return {
    type: 'message',
    id: 'msg_0193',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

/**
 * @description A function call output item.
 * @param {string} name - The function.
 * @param {object} args - The arguments.
 * @param {string} [callId] - The call id.
 * @returns {object} The item.
 */
export function callItem(name, args, callId = 'call_unLAR8MvFNptuiZK6K6HCy5k') {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

/**
 * @description A reasoning output item (store: false, encrypted).
 * @param {string} [secret] - The encrypted content.
 * @returns {object} The item.
 */
export function reasoningItem(secret = 'gAAAAABencrypted') {
  return { type: 'reasoning', id: 'rs_0193', summary: [], encrypted_content: secret };
}

/**
 * @description A Response object.
 * @param {Array<object>} [output] - The output items.
 * @param {object} [extra] - `{ status, incomplete_details, usage, model }`.
 * @returns {object} The body.
 */
export function responded(output = [messageItem('Bonjour !')], extra = {}) {
  return {
    id: extra.id ?? 'resp_0193',
    object: 'response',
    created_at: 1762380000,
    status: extra.status ?? 'completed',
    error: null,
    incomplete_details: extra.incomplete_details ?? null,
    model: extra.model ?? 'gpt-6.1-terra',
    output,
    store: false,
    usage: extra.usage ?? {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 },
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 1280,
    },
  };
}

/**
 * @description An OpenAI error body.
 * @param {string} message - The message.
 * @param {object} [fields] - `{ type, code, param }`.
 * @returns {object} The body.
 */
export function openAiError(
  message,
  { type = 'invalid_request_error', code = null, param = null } = {},
) {
  return { error: { message, type, param, code } };
}

/**
 * @description Start the fake API.
 * @returns {Promise<object>} `{ url, requests, reply, close }`.
 */
export async function startFakeOpenAi() {
  const requests = [];
  const queues = new Map();
  const defaults = {
    'POST responses': () => ({ status: 200, body: responded() }),
    'GET model': (request) => ({
      status: 200,
      body: { id: request.model, object: 'model', created: 1762380000, owned_by: 'openai' },
    }),
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const path = decodeURIComponent(req.url);
      const model = /^\/v1\/models\/([^/]+)$/.exec(path)?.[1];
      let route = `${req.method} ${path}`;
      if (model) {
        route = `${req.method} model`;
      } else if (path === '/v1/responses') {
        route = `${req.method} responses`;
      }
      const auth = String(req.headers.authorization ?? '');
      const request = {
        route,
        path,
        model,
        apiKey: auth.startsWith('Bearer ') ? auth.slice(7) : null,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(request);
      let answer;
      if (request.apiKey !== API_KEY) {
        answer = {
          status: 401,
          body: openAiError(
            `Incorrect API key provided: ${String(request.apiKey).slice(0, 8)}****${String(request.apiKey).slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys.`,
            { code: 'invalid_api_key' },
          ),
        };
      } else {
        const queue = queues.get(route);
        const handler = queue?.length ? queue.shift() : defaults[route];
        answer = handler
          ? handler(request)
          : { status: 404, body: openAiError('Not found', { code: 'not_found' }) };
      }
      res.writeHead(answer.status, {
        'Content-Type': 'application/json',
        ...(answer.headers ?? {}),
      });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    /**
     * @description Queue the answer of the next request of a route.
     * @param {string} route - "POST responses" or "GET model".
     * @param {Function|object} handler - `(request) => answer`, or the answer.
     */
    reply(route, handler) {
      if (!queues.has(route)) {
        queues.set(route, []);
      }
      queues.get(route).push(typeof handler === 'function' ? handler : () => handler);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
