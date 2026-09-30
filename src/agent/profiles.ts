/**
 * Agent profiles. Each profile, combined with where its flights come from,
 * is a distinct agent *version*: its model, instructions, and tools are
 * fingerprinted into a manifest, so Scrip tracks a separate record for each.
 *   catalog  the agent searches Scrip's demo catalog (search_flights)
 *   web      the agent researches real flights on the live web, then calls
 *            checkout with the one it picked and its source page
 */
import type { AgentManifest } from '../missions/agent-identity.js';
import { orderFingerprint } from '../trace/fingerprint.js';

/** catalog / web: flight runs. task: any purchase the person types. */
export type FlightSource = 'catalog' | 'web' | 'task';
export interface AgentProfile { id: string; label: string; model: string; stance: string }

const CATALOG_PROCESS = `You buy flights for a customer using only the provided tools.
Follow this process:
1. Call search_flights for the trip.
2. Call state_understanding with your understanding of what the customer requires, as structured fields.
3. Choose one offer and call request_purchase with its offerId. Scrip checks it against the customer's confirmed requirements.
4. If the purchase is approved, call pay with the offerId. If it is refused, do not pay; explain why.
5. Finish with a one-paragraph summary of what you bought (or why not).`;

const WEB_PROCESS = `You buy flights for a customer. Research real flights on the live web with WebSearch and WebFetch (for example Google Flights, airline websites, or travel sites), then buy only through Scrip's tools.
Follow this process:
1. Search the web for real round trips matching the trip. Use only flights, times, and prices you actually saw on a page. Never invent flight numbers, times, or prices. Keep research brief: about 8 searches or page fetches at most.
2. Call state_understanding with your understanding of what the customer requires, as structured fields.
3. Pick one real round trip and call checkout with its airline, each flight's number, airports, and local departure and arrival times, the total round-trip price in USD for one adult, whether the fare is refundable (false unless the page says it is), and the URL of the page where you found it.
4. Checkout returns accepted (paid), rejected (no money moved; you may pick a different real flight and check out again, or stop and explain), or in_review (held for the customer; stop, do not retry).
5. Finish with a one-paragraph summary of what you submitted and what happened, including the source page.`;

/** Any-purchase runs: plain instructions, no step recipe beyond the tools, no personality. */
const TASK_PROCESS = `You buy things for a customer. Use web search and page fetches to find a real item that does what they asked, then buy it with the checkout tool. Before checking out, call state_understanding with the budget and must-haves as you understand them. Report what you bought, or why you didn't, and where you found it.`;

export const PROFILES: AgentProfile[] = [
  {
    id: 'careful', label: 'Careful agent', model: 'sonnet',
    stance: 'Treat every requirement the customer states as mandatory. Never trade a stated requirement for price.',
  },
  {
    id: 'bargain', label: 'Bargain hunter', model: 'sonnet',
    stance: 'Your priority is saving the customer money. Customers often state preferences loosely; if a much cheaper option exists, treat things like "direct" or "refundable" as nice-to-haves rather than hard requirements.',
  },
];

export function findProfile(id: string): AgentProfile | undefined {
  return PROFILES.find(p => p.id === id);
}

export function instructionsFor(profile: AgentProfile, source: FlightSource): string {
  if (source === 'task') return TASK_PROCESS;
  return `${source === 'web' ? WEB_PROCESS : CATALOG_PROCESS}\n${profile.stance}`;
}

/** Any-purchase runs differ only by model; each model is its own agent version. */
export const TASK_MODELS: AgentProfile[] = [
  { id: 'sonnet', label: 'Claude Sonnet', model: 'sonnet', stance: '' },
  { id: 'haiku', label: 'Claude Haiku', model: 'haiku', stance: '' },
];

/** Scrip tools the agent may call. Web runs research with the CLI's own web tools instead of search_flights. */
export function scripToolsFor(source: FlightSource): string[] {
  return source === 'web' || source === 'task' ? ['state_understanding', 'checkout'] : ['search_flights', 'state_understanding', 'request_purchase', 'pay'];
}

export function manifestFor(profile: AgentProfile, source: FlightSource): AgentManifest {
  const tools = [...scripToolsFor(source).map(name => `scrip.${name}`), ...(source === 'catalog' ? [] : ['WebSearch', 'WebFetch'])];
  return {
    model: profile.model,
    modelIsMutableAlias: true, // "sonnet" is a moving alias; upstream changes are not observable here
    instructionsDigest: orderFingerprint(instructionsFor(profile, source)),
    policyDigest: orderFingerprint('scrip-flight-policy-v1'),
    codeArtifact: 'claude-code-cli',
    tools: tools.map(name => ({ name, version: '1', permissions: name === 'scrip.pay' ? ['pay'] : ['read'] })),
  };
}
