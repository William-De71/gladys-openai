import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  effortFor,
  modelName,
  normalizeConfig,
  resolveModel,
} from '../src/config.js';

test('defaults fill an empty or broken configuration', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  const config = normalizeConfig({
    api_key: '  abc  ',
    model: 'gpt-4o',
    fast_model: 'custom',
    custom_model: 'bad id with spaces',
    reasoning: 'max',
    max_tokens: '999999',
  });
  assert.equal(config.api_key, 'abc');
  assert.equal(config.model, 'gpt-6.1-terra', 'an unknown model falls back');
  assert.equal(config.fast_model, 'custom');
  assert.equal(config.custom_model, '', 'an id that cannot be a model id is ignored');
  assert.equal(config.reasoning, 'low');
  assert.equal(config.max_tokens, 128000);
  assert.equal(normalizeConfig({ max_tokens: 'x' }).max_tokens, 16000);
  assert.equal(normalizeConfig({ max_tokens: '' }).max_tokens, 16000, 'an emptied field');
  assert.equal(normalizeConfig({ max_tokens: null }).max_tokens, 16000);
  assert.equal(normalizeConfig({ max_tokens: 10 }).max_tokens, 2048);
});

test('a select set to "custom" calls the custom id, null when it is empty', () => {
  const config = normalizeConfig({ model: 'custom', custom_model: ' gpt-5.5-2026-04-23 ' });
  assert.equal(resolveModel(config, 'model'), 'gpt-5.5-2026-04-23');
  assert.equal(resolveModel(config, 'fast_model'), 'gpt-6-luna');
  assert.equal(
    resolveModel(
      normalizeConfig({ model: 'custom', custom_model: 'ft:gpt-6-luna:acme::abc' }),
      'model',
    ),
    'ft:gpt-6-luna:acme::abc',
    'a fine-tuned model id',
  );
  assert.equal(resolveModel(normalizeConfig({ model: 'custom' }), 'model'), null);
  assert.equal(modelName('gpt-6.1-terra'), 'GPT-6.1 Terra');
  assert.equal(modelName('gpt-5.5'), 'gpt-5.5');
});

test('reasoning effort: only values each model accepts', () => {
  const levels = ['none', 'low', 'medium', 'high'];
  // GPT-6 Astra and GPT-6.1 Sol cannot turn reasoning off.
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol']) {
    assert.deepEqual(
      levels.map((level) => effortFor(id, level)),
      ['low', 'low', 'medium', 'high'],
      id,
    );
  }
  for (const id of ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.deepEqual(
      levels.map((level) => effortFor(id, level)),
      levels,
      id,
    );
  }
  // Custom: as asked, except none which is not sent.
  assert.equal(effortFor('gpt-5.5', 'medium'), 'medium');
  assert.equal(effortFor('gpt-5.5', 'none'), undefined);
});
