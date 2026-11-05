// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the administrator in Gladys from the `config_schema` of the
// manifest; the SDK fetches it (`gladys.getConfig()`) and notifies every
// change (`gladys.onConfigUpdated()`). This module provides the defaults and
// normalizes what arrives, so the rest of the code never deals with
// `undefined`, a number typed as a string, or a model the select no longer
// offers.
// -----------------------------------------------------------------------------

/**
 * The OpenAI models offered in the Configuration screen. The ids are the
 * exact API ids (developers.openai.com/api/docs/models, checked 2026-11-05):
 * they are stored by users, so an id leaves this list only when OpenAI shuts
 * the model down. `custom` hands the choice to the free `custom_model` field.
 *
 * `effort`: the `reasoning.effort` values the model accepts, among those the
 * configuration offers (`xhigh` and `max` exist but are too slow for a home
 * assistant). GPT-6 Astra and GPT-6.1 Sol cannot turn reasoning off.
 */
export const MODELS = {
  'gpt-6.1-terra': {
    name: 'GPT-6.1 Terra',
    effort: ['none', 'low', 'medium', 'high'],
  },
  'gpt-6.1-sol': {
    name: 'GPT-6.1 Sol',
    effort: ['low', 'medium', 'high'],
  },
  'gpt-6-astra': {
    name: 'GPT-6 Astra',
    effort: ['low', 'medium', 'high'],
  },
  'gpt-6-luna': {
    name: 'GPT-6 Luna',
    effort: ['none', 'low', 'medium', 'high'],
  },
  'gpt-5.6-terra': {
    name: 'GPT-5.6 Terra',
    effort: ['none', 'low', 'medium', 'high'],
  },
  'gpt-5.6-luna': {
    name: 'GPT-5.6 Luna',
    effort: ['none', 'low', 'medium', 'high'],
  },
};

export const CUSTOM_MODEL = 'custom';

/** The reasoning levels of the configuration (`reasoning` select), least first. */
export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high'];

/** A model id typed by hand: what OpenAI API ids look like. */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$/;

/** Bounds of the `max_tokens` field, mirrored by the manifest. */
export const MAX_TOKENS_MIN = 2048;
export const MAX_TOKENS_MAX = 128000;

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  // The OpenAI API key. A `secret` field: no default, never logged.
  api_key: '',
  // The model of the chat, the scene `ai.ask` action and the weekly digest.
  model: 'gpt-6.1-terra',
  // The model of the intent router, which runs before every chat turn and must
  // answer within 20 s: a fast, cheap model is the right one there.
  fast_model: 'gpt-6-luna',
  // The id used by a select set to "custom" (a newer model, a snapshot…).
  custom_model: '',
  // How hard the chat model reasons.
  reasoning: 'low',
  // Output budget of one answer, reasoning included.
  max_tokens: 16000,
};

/**
 * @description Merge the user config with the defaults.
 * @param {Record<string, unknown>} [raw] - Config returned by the SDK.
 * @returns {object} The normalized config.
 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  const customModel = String(config.custom_model ?? '').trim();
  return {
    api_key: String(config.api_key ?? '').trim(),
    model: pickModel(config.model, DEFAULT_CONFIG.model),
    fast_model: pickModel(config.fast_model, DEFAULT_CONFIG.fast_model),
    custom_model: MODEL_ID_PATTERN.test(customModel) ? customModel : '',
    reasoning: EFFORT_LEVELS.includes(config.reasoning)
      ? config.reasoning
      : DEFAULT_CONFIG.reasoning,
    max_tokens: clampInteger(config.max_tokens, MAX_TOKENS_MIN, MAX_TOKENS_MAX),
  };
}

/**
 * @description The model id to call for a select value.
 * @param {object} config - The normalized config.
 * @param {'model'|'fast_model'} key - Which select.
 * @returns {string|null} The API model id, null when "custom" has no id.
 */
export function resolveModel(config, key) {
  const value = config[key];
  if (value === CUSTOM_MODEL) {
    return config.custom_model || null;
  }
  return value;
}

/**
 * @description The display name of a model id.
 * @param {string} id - An API model id.
 * @returns {string} "GPT-6.1 Terra", or the id itself.
 */
export function modelName(id) {
  return MODELS[id]?.name ?? id;
}

/**
 * @description The `reasoning.effort` to send for a model.
 * @param {string} id - The API model id.
 * @param {string} level - The wanted level (`none`, `low`, `medium`, `high`).
 * @returns {string|undefined} The value to send, undefined to let the model
 * choose (a custom model asked for its least reasoning: older models refuse
 * `none`, non-reasoning ones refuse the parameter).
 */
export function effortFor(id, level) {
  const accepted = MODELS[id]?.effort;
  if (!accepted) {
    // A custom model: send the level as asked, except `none`. A refusal is
    // caught by the chat handler, which retries without the parameter.
    return level === 'none' ? undefined : level;
  }
  if (accepted.includes(level)) {
    return level;
  }
  // The closest level above: Astra and 6.1 Sol start at low.
  const wanted = EFFORT_LEVELS.indexOf(level);
  const above = accepted.find((value) => EFFORT_LEVELS.indexOf(value) >= wanted);
  return above ?? accepted[accepted.length - 1];
}

/**
 * @description A select value kept when known, else the default.
 * @param {unknown} value - The value.
 * @param {string} fallback - The default.
 * @returns {string} A model key or "custom".
 */
function pickModel(value, fallback) {
  if (value === CUSTOM_MODEL || (typeof value === 'string' && value in MODELS)) {
    return value;
  }
  return fallback;
}

/**
 * @description An integer within bounds.
 * @param {unknown} value - The value.
 * @param {number} min - The minimum.
 * @param {number} max - The maximum.
 * @returns {number} The integer.
 */
function clampInteger(value, min, max) {
  // An emptied field arrives as '' or null: Number('') is 0, not "unset".
  const number = value === '' || value === null ? NaN : Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return DEFAULT_CONFIG.max_tokens;
  }
  return Math.min(max, Math.max(min, number));
}
