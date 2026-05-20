import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autoGroupSessionName,
  ensureAutoGroupSession,
  shouldIgnorePlainGroupMessage,
} from '../lib/session-routing.mjs';

const cfg = {
  autoCreateGroupSessions: true,
  autoGroupSessionPrefix: 'group',
  defaultBackend: 'codex-app-server',
  defaultAgent: 'codex',
  defaultWorkdir: '/Users/admin',
  defaultCommand: 'codex --no-alt-screen',
  groupRequireCommand: true,
};

test('autoGroupSessionName is stable and safe for chat ids', () => {
  const first = autoGroupSessionName('oc_0f9f0998e49ba24cbc4ce7eed52feba8', 'Feishu Group');
  const second = autoGroupSessionName('oc_0f9f0998e49ba24cbc4ce7eed52feba8', 'Feishu Group');

  assert.equal(first, second);
  assert.match(first, /^feishu-group-[a-f0-9]{10}$/);
});

test('ensureAutoGroupSession creates and binds a new group session once', () => {
  const state = { sessions: {}, routes: { chats: {}, threads: {}, users: {} } };
  const event = { chat_type: 'group', chat_id: 'oc_new_group' };

  const created = ensureAutoGroupSession(state, event, cfg, { now: '2026-05-20T00:00:00.000Z' });
  const repeated = ensureAutoGroupSession(state, event, cfg, { now: '2026-05-20T00:01:00.000Z' });

  assert.equal(created.changed, true);
  assert.equal(created.sessionName, autoGroupSessionName('oc_new_group', 'group'));
  assert.equal(state.routes.chats.oc_new_group.defaultSession, created.sessionName);
  assert.equal(state.sessions[created.sessionName].backend, 'codex-app-server');
  assert.equal(state.sessions[created.sessionName].sourceChatId, 'oc_new_group');
  assert.equal(repeated.changed, false);
  assert.equal(Object.keys(state.sessions).length, 1);
});

test('plain group messages are allowed when auto group sessions are enabled', () => {
  assert.equal(shouldIgnorePlainGroupMessage({ chat_type: 'group' }, cfg), false);
  assert.equal(
    shouldIgnorePlainGroupMessage({ chat_type: 'group' }, { ...cfg, autoCreateGroupSessions: false }),
    true,
  );
  assert.equal(shouldIgnorePlainGroupMessage({ chat_type: 'p2p' }, cfg), false);
});
