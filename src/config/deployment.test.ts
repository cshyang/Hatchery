// Deployment config resolution — run: npx tsx src/config/deployment.test.ts
// Load-bearing: absent env MUST reproduce the original literals (an existing deployment is
// unchanged), and env MUST override them (a new account relocates without a code edit).

import assert from 'node:assert/strict';
import { createTestRunner } from '../shared/test-utils';
import { deploymentConfig, isKnownTeam } from './deployment';

const { test, run } = createTestRunner();

test('falls back to the original literals when env is empty', async () => {
  const cfg = deploymentConfig({});
  assert.deepEqual(cfg.knownTeamIds, ['T0B6VB415TQ']);
  assert.equal(cfg.slackBotId, 'U0B6UB2E5HT');
  assert.equal(cfg.slackTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('env overrides every account-coupled value', async () => {
  const cfg = deploymentConfig({
    KNOWN_TEAM_IDS: ' T_NEW , T_TWO ',
    SLACK_BOT_ID: 'U_NEW',
    SLACK_DEFAULT_TOKEN_REF: 'SLACK_BOT_TOKEN_ACME',
  });
  assert.deepEqual(cfg.knownTeamIds, ['T_NEW', 'T_TWO']);
  assert.equal(cfg.slackBotId, 'U_NEW');
  assert.equal(cfg.slackTokenRef, 'SLACK_BOT_TOKEN_ACME');
});

test('blank / whitespace env values fall back, never produce empty config', async () => {
  const cfg = deploymentConfig({ KNOWN_TEAM_IDS: '  ', SLACK_BOT_ID: '', SLACK_DEFAULT_TOKEN_REF: '   ' });
  assert.deepEqual(cfg.knownTeamIds, ['T0B6VB415TQ']);
  assert.equal(cfg.slackBotId, 'U0B6UB2E5HT');
  assert.equal(cfg.slackTokenRef, 'SLACK_BOT_TOKEN_DEFAULT');
});

test('isKnownTeam gates on the env-resolved allowlist', async () => {
  assert.equal(isKnownTeam({}, 'T0B6VB415TQ'), true); // default workspace
  assert.equal(isKnownTeam({}, 'T_SOME_OTHER_WORKSPACE'), false);
  assert.equal(isKnownTeam({}, ''), false);
  assert.equal(isKnownTeam({ KNOWN_TEAM_IDS: 'T_NEW' }, 'T_NEW'), true); // relocated workspace
  assert.equal(isKnownTeam({ KNOWN_TEAM_IDS: 'T_NEW' }, 'T0B6VB415TQ'), false); // old id no longer allowed
});

run();
