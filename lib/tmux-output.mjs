export function hasAssistantOutput(before, after) {
  return Boolean(assistantOutput(before, after));
}

export function assistantOutput(before, after) {
  const lines = String(after || '').split('\n');
  const promptStart = findLastIndex(lines, (line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('› [Feishu message]') || trimmed.startsWith('› 飞书远程消息');
  });
  const searchFrom = promptStart >= 0 ? promptStart + 1 : 0;
  const start = lines.findIndex((line, index) => {
    if (index < searchFrom) return false;
    const trimmed = line.trim();
    return trimmed.startsWith('• ') || trimmed.startsWith('■ ');
  });
  if (start < 0) return '';

  const kept = [];
  for (const line of lines.slice(start)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('› ')) break;
    if (trimmed.includes('esc to interrupt')) continue;
    if (trimmed.includes('tab to queue message')) continue;
    if (/^\S+\s+\w[\w.-]*\s+·\s+/.test(trimmed)) continue;
    const cleaned = kept.length === 0
      ? line.replace(/^(\s*)[•■]\s?/, '$1')
      : line;
    kept.push(cleaned);
  }
  return kept.join('\n').trim();
}

export function diffText(before, after) {
  if (after.startsWith(before)) return after.slice(before.length);
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let overlap = Math.min(beforeLines.length, afterLines.length);
  while (overlap > 0) {
    const a = beforeLines.slice(beforeLines.length - overlap).join('\n');
    const b = afterLines.slice(0, overlap).join('\n');
    if (a === b) break;
    overlap--;
  }
  return afterLines.slice(overlap).join('\n');
}

function findLastIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index], index)) return index;
  }
  return -1;
}
