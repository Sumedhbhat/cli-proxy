// Claude Code suppresses structured usage metadata for API-key connections.
// Restore only the timestamp explicitly supplied by this proxy's refusal.
export function restoreProxyReset(frame) {
  if (frame?.type !== 'assistant' || frame.error !== 'rate_limit' || frame.api_error_params?.rate_limit_info) return frame;
  const text = frame.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
  const reset = /Nearest Claude account reset: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\.\s*$/.exec(text)?.[1];
  const seconds = Date.parse(reset) / 1000;
  if (!Number.isFinite(seconds)) return frame;
  return { ...frame, api_error_params: { ...frame.api_error_params, rate_limit_info: { status: 'rejected', rateLimitType: 'unknown', resetsAt: seconds, isUsingOverage: false } } };
}
