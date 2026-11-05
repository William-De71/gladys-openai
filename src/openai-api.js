// -----------------------------------------------------------------------------
// Client of the OpenAI API (https://api.openai.com/v1), with the
// administrator's own API key.
//
// Plain fetch, no SDK: two endpoints only —
//   - POST /v1/responses        the assistant (convert.js)
//   - GET  /v1/models/{id}      the connection check (no token spent)
//
// The key travels in the `Authorization: Bearer` header, never in a URL nor a
// log. Every call runs under a deadline. A rate limit (429 without a billing
// code), a 5xx or a network failure is retried while the deadline leaves room
// for it, honouring Retry-After; a billing 429 (credits exhausted, spend
// limit) and anything else fail at once with an OpenAiError that says what
// went wrong without echoing the key.
// -----------------------------------------------------------------------------

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** The error kinds, also the `kind` variable of the `error` scene trigger. */
export const ERROR_KINDS = {
  AUTH: 'auth',
  BILLING: 'billing',
  MODEL: 'model',
  RATE_LIMIT: 'rate_limit',
  REQUEST: 'request',
  SERVER: 'server',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
};

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;
const MAX_ATTEMPTS = 3;

/**
 * The `error.code` values of a 429 that are about money, not speed
 * (api/docs/guides/error-codes, checked 2026-11-05): retrying never helps.
 */
const BILLING_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'billing_hard_limit_reached',
  'billing_not_active',
]);

export class OpenAiError extends Error {
  /**
   * @param {string} kind - One of ERROR_KINDS.
   * @param {string} message - What went wrong (never the key).
   * @param {object} [details] - `{ status, code, retryAfterMs }`.
   */
  constructor(kind, message, { status = null, code = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'OpenAiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @description The `error.code` (or `error.type`) of an OpenAI error body.
 * @param {unknown} body - The parsed body.
 * @returns {string} `invalid_api_key`, `insufficient_quota`…, or ''.
 */
export function codeOf(body) {
  const error = body?.error;
  if (!error || typeof error !== 'object') {
    return '';
  }
  return String(error.code ?? error.type ?? '');
}

/**
 * @description The kind of an HTTP failure.
 * @param {number} status - The HTTP status.
 * @param {unknown} [body] - The parsed body.
 * @returns {string} One of ERROR_KINDS.
 */
export function kindOfStatus(status, body = null) {
  const code = codeOf(body);
  const type = String(body?.error?.type ?? '');
  const message = String(body?.error?.message ?? '');
  if (status === 401) {
    return ERROR_KINDS.AUTH;
  }
  if (BILLING_CODES.has(code) || type === 'insufficient_quota' || status === 402) {
    return ERROR_KINDS.BILLING;
  }
  if (status === 404 || code === 'model_not_found') {
    return ERROR_KINDS.MODEL;
  }
  if (status === 403) {
    // A project without access to a model says so in a 403 too.
    return /model/i.test(message) && !/country|region|territory/i.test(message)
      ? ERROR_KINDS.MODEL
      : ERROR_KINDS.AUTH;
  }
  if (status === 429) {
    return ERROR_KINDS.RATE_LIMIT;
  }
  if (status >= 500) {
    return ERROR_KINDS.SERVER;
  }
  return ERROR_KINDS.REQUEST;
}

/**
 * @description The message of an error body, short and without secrets.
 * @param {unknown} body - The parsed body, or the raw text.
 * @returns {string} The message.
 */
export function errorMessageOf(body) {
  let message = '';
  if (typeof body === 'string') {
    message = body;
  } else if (body && typeof body === 'object') {
    const candidate = body.error?.message ?? body.message ?? body.error;
    if (typeof candidate === 'string') {
      message = candidate;
    } else if (candidate !== undefined && candidate !== null) {
      message = JSON.stringify(candidate);
    }
  }
  return maskKeys(message).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * @description Hide anything that looks like an OpenAI key. A 401 quotes the
 * beginning and the end of the key it refused ("Incorrect API key provided:
 * sk-proj-****abcd").
 * @param {string} text - A text.
 * @returns {string} The text without key.
 */
export function maskKeys(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_*-]{4,}/g, 'sk-***')
    .replace(/(Bearer\s+)\S+/gi, '$1***');
}

/**
 * @description Milliseconds asked by a Retry-After header.
 * @param {string|null} value - The header.
 * @param {number} now - Now (ms).
 * @returns {number|null} Milliseconds, null when absent or unreadable.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * @description Build a client.
 * @param {object} options - Options.
 * @param {() => string} options.getApiKey - The current API key.
 * @param {string} [options.baseUrl] - The API root (tests point it to a fake).
 * @param {typeof fetch} [options.fetchImpl] - fetch.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waiting (tests skip it).
 * @param {() => number} [options.now] - Clock.
 * @returns {object} `{ createResponse, getModel }`.
 */
export function createOpenAiClient({
  getApiKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const root = baseUrl.replace(/\/+$/, '');

  /**
   * @description One HTTP call, retried on 429 / 5xx / network while the
   * deadline allows.
   * @param {string} method - GET or POST.
   * @param {string} path - Path under /v1.
   * @param {object} [options] - `{ body, timeoutMs, retries }`.
   * @returns {Promise<object>} The parsed JSON body.
   */
  async function request(method, path, { body, timeoutMs = 30_000, retries = true } = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new OpenAiError(ERROR_KINDS.AUTH, 'No OpenAI API key in the configuration');
    }
    const deadline = now() + timeoutMs;
    let lastError = null;
    for (let attempt = 1; attempt <= (retries ? MAX_ATTEMPTS : 1); attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        break;
      }
      try {
        return await once(method, path, body, apiKey, remaining);
      } catch (err) {
        lastError = err;
        const retryable =
          err.kind === ERROR_KINDS.RATE_LIMIT ||
          err.kind === ERROR_KINDS.SERVER ||
          err.kind === ERROR_KINDS.UNREACHABLE;
        if (!retryable || !retries || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        const wait = err.retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempt - 1);
        // A long wait asked by OpenAI, or no room left for the wait and a
        // useful answer: fail now, with the real reason, rather than later
        // with a timeout.
        if (wait > RETRY_MAX_MS || now() + wait + 1000 >= deadline) {
          throw err;
        }
        await sleep(wait);
      }
    }
    throw (
      lastError ??
      new OpenAiError(ERROR_KINDS.TIMEOUT, `No answer within ${Math.round(timeoutMs / 1000)} s`)
    );
  }

  async function once(method, path, body, apiKey, timeoutMs) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new OpenAiError(
          ERROR_KINDS.TIMEOUT,
          `No answer within ${Math.round(timeoutMs / 1000)} s`,
        );
      }
      throw new OpenAiError(
        ERROR_KINDS.UNREACHABLE,
        `Cannot reach the OpenAI API (${err?.cause?.code ?? err?.message ?? 'network error'})`,
      );
    }
    const text = await response.text().catch(() => '');
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message = errorMessageOf(parsed ?? text) || response.statusText || 'error';
      const code = codeOf(parsed) || null;
      throw new OpenAiError(
        kindOfStatus(response.status, parsed),
        `HTTP ${response.status}${code ? ` ${code}` : ''}: ${message}`,
        {
          status: response.status,
          code,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
        },
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new OpenAiError(
        ERROR_KINDS.SERVER,
        'The OpenAI API answered something that is not JSON',
        { status: response.status },
      );
    }
    return parsed;
  }

  return {
    /**
     * @description POST /v1/responses.
     * @param {object} body - A Responses API request (with `model`).
     * @param {object} [options] - `{ timeoutMs, retries }`.
     * @returns {Promise<object>} The Response object.
     */
    createResponse(body, options) {
      return request('POST', '/responses', { ...options, body });
    },
    /**
     * @description GET /v1/models/{model}: is this model open to the key? It
     * does not prove that the project can pay for an answer: only the test
     * button does.
     * @param {string} model - The model id.
     * @param {object} [options] - `{ timeoutMs }`.
     * @returns {Promise<object>} The model object.
     */
    getModel(model, options) {
      return request('GET', `/models/${encodeURIComponent(model)}`, {
        timeoutMs: 15_000,
        ...options,
        retries: false,
      });
    },
  };
}
