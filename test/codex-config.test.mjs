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

test('codex config can force HTTP responses transport', () => {
  const httpCfg = {
    codexNetworkAccess: true,
    codexResponsesWebSockets: false,
  };
  assert.deepEqual(buildCodexCliConfigArgs(httpCfg), [
    '-c',
    'features.responses_websockets=false',
    '-c',
    'features.responses_websockets_v2=false',
  ]);
  assert.deepEqual(codexConfig(httpCfg), {
    features: {
      responses_websockets: false,
      responses_websockets_v2: false,
    },
    sandbox_workspace_write: {
      network_access: true,
    },
  });
});

test('codex config can force ChatGPT provider onto HTTP responses wire api', () => {
  const httpProviderCfg = {
    codexNetworkAccess: true,
    codexResponsesWebSockets: false,
    codexForceResponsesHttp: true,
    codexHttpProviderId: 'chatgpt_http',
    codexHttpProviderName: 'ChatGPT HTTP',
    codexHttpProviderBaseUrl: 'https://chatgpt.com/backend-api/codex',
  };

  assert.deepEqual(buildCodexCliConfigArgs(httpProviderCfg), [
    '-c',
    'features.responses_websockets=false',
    '-c',
    'features.responses_websockets_v2=false',
    '-c',
    'model_provider="chatgpt_http"',
    '-c',
    'model_providers.chatgpt_http.name="ChatGPT HTTP"',
    '-c',
    'model_providers.chatgpt_http.base_url="https://chatgpt.com/backend-api/codex"',
    '-c',
    'model_providers.chatgpt_http.wire_api="responses"',
    '-c',
    'model_providers.chatgpt_http.requires_openai_auth=true',
    '-c',
    'model_providers.chatgpt_http.supports_websockets=false',
  ]);
  assert.deepEqual(codexConfig(httpProviderCfg), {
    features: {
      responses_websockets: false,
      responses_websockets_v2: false,
    },
    model_provider: 'chatgpt_http',
    model_providers: {
      chatgpt_http: {
        name: 'ChatGPT HTTP',
        base_url: 'https://chatgpt.com/backend-api/codex',
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: false,
      },
    },
    sandbox_workspace_write: {
      network_access: true,
    },
  });
});
