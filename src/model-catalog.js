import { modelProvider } from './quota.js';

const ownerProvider = owner => ({ openai: 'codex', codex: 'codex', anthropic: 'claude', claude: 'claude' })[owner?.toLowerCase()];

// Keep provider metadata authoritative: aliases and Anthropic-cloaked IDs can
// name a different family from the actual provider serving the model.
export function filterModelCatalog(payload, provider, owners = new Map()) {
  const key = Array.isArray(payload?.models) ? 'models' : 'data';
  if (!Array.isArray(payload?.[key])) throw new Error('Invalid model catalog');
  const models = payload[key].filter(model => {
    const id = model?.slug ?? model?.id;
    const owner = model?.owned_by ?? owners.get(id);
    return (typeof owner === 'string' ? ownerProvider(owner) : modelProvider(id)) === provider;
  });
  const result = { ...payload, [key]: models };
  if ('first_id' in payload) result.first_id = models[0]?.id ?? '';
  if ('last_id' in payload) result.last_id = models.at(-1)?.id ?? '';
  return result;
}
