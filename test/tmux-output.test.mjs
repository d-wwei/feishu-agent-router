import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantOutput } from '../lib/tmux-output.mjs';

test('extracts Codex TUI error after current Feishu prompt without returning the screen chrome', () => {
  const after = [
    '╭──────────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.132.0)                   │',
    '╰──────────────────────────────────────────────╯',
    '',
    '› [Feishu message]',
    '  session: main',
    '  sender_open_id: ou_sender',
    '  chat_id: oc_chat',
    '  [User message]',
    '  leaf 给了新包，你来测试一下',
    '',
    '',
    '■ Missing environment variable: `AZURE_OPENAI_API_KEY`.',
    '',
    '',
    '› Find and fix a bug in @filename',
    '',
    '  gpt-5.5 high · ~/Documents/moomoo rust opend',
  ].join('\n');

  const output = assistantOutput('', after);

  assert.equal(output, 'Missing environment variable: `AZURE_OPENAI_API_KEY`.');
});

test('extracts bullet assistant output after current Feishu prompt', () => {
  const after = [
    'old content',
    '› [Feishu message]',
    '  [User message]',
    '  hi',
    '',
    '• 收到，我继续。',
    '  第二行。',
  ].join('\n');

  assert.equal(assistantOutput('', after), '收到，我继续。\n  第二行。');
});
