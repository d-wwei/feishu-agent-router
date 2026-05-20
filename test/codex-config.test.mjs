import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexCliConfigArgs,
  buildCodexThreadParams,
  buildCodexTurnParams,
  codexConfig,
} from '../lib/codex-config.mjs';

const cfg = {
  codexProfile: 'codex-provider-3p',
  codexModel: 'gpt-5.5',
  codexModelProvider: 'codexThirdPartyProvider',
  codexServiceTier: '',
  codexReasoningEffort: 'medium',
  codexApprovalPolicy: 'never',
  codexSandbox: 'danger-full-access',
  codexNetworkAccess: true,
};

test('codex app-server cli args force configured provider and model', () => {
  assert.deepEqual(buildCodexCliConfigArgs(cfg), [
    '-c',
    'profile="codex-provider-3p"',
    '-c',
    'model="gpt-5.5"',
    '-c',
    'model_provider="codexThirdPartyProvider"',
    '-c',
    'model_reasoning_effort="medium"',
  ]);
});

test('codex thread params carry explicit modelProvider override', () => {
  assert.deepEqual(buildCodexThreadParams(cfg), {
    model: 'gpt-5.5',
    modelProvider: 'codexThirdPartyProvider',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    config: {
      profile: 'codex-provider-3p',
      model: 'gpt-5.5',
      model_provider: 'codexThirdPartyProvider',
      model_reasoning_effort: 'medium',
      sandbox_workspace_write: {
        network_access: true,
      },
    },
  });
});

test('codex turn params do not include unsupported modelProvider field', () => {
  assert.deepEqual(buildCodexTurnParams(cfg), {
    model: 'gpt-5.5',
    effort: 'medium',
  });
});

test('codex config keeps network access explicit when no provider override is set', () => {
  assert.deepEqual(codexConfig({ codexNetworkAccess: false }), {
    sandbox_workspace_write: {
      network_access: false,
    },
  });
});
