/**
 * Prepares where payments run: an in-memory Natural, or the Natural sandbox
 * with the agent's limit set to 1 cent so every payment is held for Scrip.
 * `restore` puts the agent's previous limit back; call it when done.
 */
import { FakeNatural } from './fake-natural.js';
import type { AgentPayer, NaturalPort } from './natural-port.js';
import { SdkAgentPayer, SdkNaturalPort } from './natural-sdk-port.js';

export interface Rail {
  mode: 'offline' | 'sandbox';
  owner: NaturalPort;
  payer: AgentPayer;
  naturalAgentId: string;
  recipient: string;
  restore(): Promise<void>;
}

const SANDBOX_URL = 'https://api.sandbox.natural.com';

export async function setupRail(mode: 'offline' | 'sandbox', runId: string): Promise<Rail> {
  if (mode === 'offline') {
    const fake = new FakeNatural();
    fake.limitCents = 1;
    return { mode, owner: fake, payer: fake.agent('agt_offline'), naturalAgentId: 'agt_offline', recipient: 'seller', restore: async () => {} };
  }
  const ownerKey = process.env.NATURAL_SANDBOX_API_KEY ?? '';
  const agentKey = process.env.NATURAL_SANDBOX_AGENT_KEY ?? '';
  if (!ownerKey.startsWith('sk_ntl_sandbox_') || !agentKey.startsWith('ak_ntl_sandbox_')) {
    throw new Error('Sandbox runs need NATURAL_SANDBOX_API_KEY and NATURAL_SANDBOX_AGENT_KEY (sandbox keys only)');
  }
  const owner = new SdkNaturalPort({ token: ownerKey, baseUrl: SANDBOX_URL, instanceId: runId });
  const agents = await owner.listAgentIds();
  const only = agents.length === 1 ? agents[0] : undefined;
  if (!only) throw new Error(`Expected exactly one sandbox agent, found ${agents.length}`);
  await owner.fundWallet(100000);
  await owner.setAgentLimits(only.id, { perTransaction: 1 });
  return {
    mode, owner, naturalAgentId: only.id, recipient: 'payment-recipient@sandbox.natural.test',
    payer: new SdkAgentPayer({ token: agentKey, baseUrl: SANDBOX_URL, instanceId: runId }),
    restore: () => owner.setAgentLimits(only.id, only.limits ?? null),
  };
}
