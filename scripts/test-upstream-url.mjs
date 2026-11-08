// Regression for upstream URL shaping: the regular OpenAI-compatible base gets /v1, Azure deployment
// paths must be left alone (inserting /v1 there breaks the request with a 404).
import assert from 'node:assert/strict';
import { withV1 } from '../server/upstream.mjs';

assert.equal(withV1('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
assert.equal(withV1('https://api.deepseek.com/'), 'https://api.deepseek.com/v1');
assert.equal(withV1('https://api.openai.com/v1'), 'https://api.openai.com/v1');
assert.equal(
  withV1('https://r.openai.azure.com/openai/deployments/d/'),
  'https://r.openai.azure.com/openai/deployments/d',
);
assert.equal(
  withV1('https://r.services.ai.azure.com/openai/deployments/d'),
  'https://r.services.ai.azure.com/openai/deployments/d',
);
assert.equal(withV1('https://example.com/openai/deployments/d'), 'https://example.com/openai/deployments/d/v1');

console.log('withV1: all good');
