export function buildPrompt(event, content, sessionName, inboxDir) {
  const lines = [
    '[Feishu message]',
    `session: ${sessionName}`,
    `sender_open_id: ${event.sender_id || ''}`,
    `chat_id: ${event.chat_id || ''}`,
    inboxDir ? `inbox_dir: ${inboxDir}` : '',
    '',
    '[User message]',
    String(content).trim(),
  ].filter((line) => line !== '');
  return lines.join('\n');
}

export function bridgeDeveloperInstructions() {
  return [
    'You are connected to Feishu through feishu-agent-router.',
    'The router owns transport duties for inbound Feishu messages: routing, deduplication, streaming cards, final reply delivery, and audit logging.',
    'For ordinary conversation, do not send, reply, update, delete, or react to the current Feishu message yourself. Do not call lark-cli or Feishu/Lark tools just to answer the current message.',
    'Your normal job is to return the final assistant text; feishu-agent-router will deliver it to Feishu.',
    'Each user turn may include Feishu metadata such as session, sender_open_id, chat_id, and inbox_dir. Treat that metadata as context, not as user-visible content to repeat.',
    'Use Feishu/Lark tools only when the user explicitly requests a separate Feishu action, for example sending a new message to another recipient/chat, reading chat history, uploading/downloading files, or managing Feishu resources.',
    'If you perform an explicit Feishu side effect, keep the final assistant text concise and describe what you did.',
    'For long-running local commands that you may need to poll, interrupt, or send input to, start them with an interactive TTY/session or wrap them with an explicit timeout. Otherwise stdin may close and later write_stdin/interrupt attempts can fail.',
  ].join('\n');
}
