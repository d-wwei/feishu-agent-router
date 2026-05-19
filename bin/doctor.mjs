#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function checkBin(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const bins = ['node', 'lark-cli', 'tmux', 'codex'];
for (const bin of bins) {
  const found = checkBin(bin);
  console.log(`${found ? 'ok' : 'missing'} ${bin}${found ? ` -> ${found}` : ''}`);
}

console.log(`${fs.existsSync(envPath) ? 'ok' : 'missing'} .env`);
if (!fs.existsSync(envPath)) {
  console.log('Create it from .env.example before starting.');
}
