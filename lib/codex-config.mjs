export function buildCodexCliConfigArgs(cfg = {}) {
  const args = [];
  for (const [key, value] of Object.entries({
    ...codexConfigOverrides(cfg),
    ...codexFeatureCliOverrides(cfg),
    ...codexProviderCliOverrides(cfg),
  })) {
    args.push('-c', `${key}=${tomlValue(value)}`);
  }
  return args;
}

export function buildCodexThreadParams(cfg = {}) {
  return compactObject({
    model: cfg.codexModel,
    modelProvider: cfg.codexModelProvider,
    serviceTier: cfg.codexServiceTier,
    approvalPolicy: cfg.codexApprovalPolicy,
    sandbox: cfg.codexSandbox,
    config: codexConfig(cfg),
  });
}

export function buildCodexTurnParams(cfg = {}) {
  return compactObject({
    model: cfg.codexModel,
    serviceTier: cfg.codexServiceTier,
    effort: cfg.codexReasoningEffort,
  });
}

export function codexConfig(cfg = {}) {
  return {
    ...codexConfigOverrides(cfg),
    ...codexFeatureConfig(cfg),
    ...codexProviderConfig(cfg),
    sandbox_workspace_write: {
      network_access: Boolean(cfg.codexNetworkAccess),
    },
  };
}

function codexConfigOverrides(cfg) {
  return compactObject({
    profile: cfg.codexProfile,
    model: cfg.codexModel,
    model_provider: cfg.codexModelProvider,
    service_tier: cfg.codexServiceTier,
    model_reasoning_effort: cfg.codexReasoningEffort,
  });
}

function codexFeatureCliOverrides(cfg) {
  return compactObject({
    'features.responses_websockets': cfg.codexResponsesWebSockets,
    'features.responses_websockets_v2': cfg.codexResponsesWebSockets,
  });
}

function codexFeatureConfig(cfg) {
  const features = compactObject({
    responses_websockets: cfg.codexResponsesWebSockets,
    responses_websockets_v2: cfg.codexResponsesWebSockets,
  });
  return Object.keys(features).length ? { features } : {};
}

function codexProviderCliOverrides(cfg) {
  if (!shouldForceResponsesHttpProvider(cfg)) return {};
  const providerId = codexHttpProviderId(cfg);
  return {
    model_provider: providerId,
    [`model_providers.${providerId}.name`]: cfg.codexHttpProviderName || 'ChatGPT HTTP',
    [`model_providers.${providerId}.base_url`]: codexHttpProviderBaseUrl(cfg),
    [`model_providers.${providerId}.wire_api`]: 'responses',
    [`model_providers.${providerId}.requires_openai_auth`]: true,
    [`model_providers.${providerId}.supports_websockets`]: false,
  };
}

function codexProviderConfig(cfg) {
  if (!shouldForceResponsesHttpProvider(cfg)) return {};
  const providerId = codexHttpProviderId(cfg);
  return {
    model_provider: providerId,
    model_providers: {
      [providerId]: {
        name: cfg.codexHttpProviderName || 'ChatGPT HTTP',
        base_url: codexHttpProviderBaseUrl(cfg),
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: false,
      },
    },
  };
}

function shouldForceResponsesHttpProvider(cfg) {
  return (
    cfg.codexResponsesWebSockets === false &&
    cfg.codexForceResponsesHttp === true &&
    !cfg.codexModelProvider
  );
}

function codexHttpProviderId(cfg) {
  return sanitizeProviderId(cfg.codexHttpProviderId || 'chatgpt_http');
}

function codexHttpProviderBaseUrl(cfg) {
  return cfg.codexHttpProviderBaseUrl || 'https://chatgpt.com/backend-api/codex';
}

function sanitizeProviderId(value) {
  return String(value || 'chatgpt_http').replace(/[^A-Za-z0-9_]/g, '_') || 'chatgpt_http';
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}

function tomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}
