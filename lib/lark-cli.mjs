export function buildLarkCliArgs(args, options = {}) {
  const profile = String(options.profile || '').trim();
  return profile ? ['--profile', profile, ...args] : [...args];
}

export function parseLarkProfileList(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

export function resolveLarkBotIdentity({ profiles = [], profile = '', appId = '' } = {}) {
  const explicitAppId = String(appId || '').trim();
  const explicitProfile = String(profile || '').trim();
  const selected = explicitAppId
    ? null
    : profiles.find((item) => item.name === explicitProfile || item.appId === explicitProfile)
      || (!explicitProfile ? profiles.find((item) => item.active) : null)
      || null;

  const resolvedAppId = explicitAppId || String(selected?.appId || '').trim();
  const resolvedProfile = explicitProfile || String(selected?.name || '').trim();
  const key = resolvedAppId
    ? `app:${resolvedAppId}`
    : resolvedProfile
      ? `profile:${resolvedProfile}`
      : 'profile:active';

  return {
    profile: resolvedProfile,
    appId: resolvedAppId,
    key,
  };
}

export function safeLarkBotLockKey(value) {
  return String(value || 'profile:active')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'profile-active';
}
