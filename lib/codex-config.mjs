export function buildCodexCliConfigArgs(cfg = {}) {
  const args = [];
  for (const [key, value] of Object.entries(codexConfigOverrides(cfg))) {
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
