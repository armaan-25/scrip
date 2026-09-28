import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { confirmedRequirements } from '../../src/flights/fixtures.js';
import { TaskAuthorizationManager } from '../../src/lease.js';
import type { AgentManifest, AuthenticatedAgent } from '../../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../../src/missions/agent-registry.js';
import { orderFingerprint } from '../../src/trace/fingerprint.js';
import { SqliteTraceStore } from '../../src/trace/trace-store.js';
import { FlightTraceService } from '../../src/trace/trace-service.js';

export const manifest: AgentManifest = {
  model: 'example-model-1', modelIsMutableAlias: false, instructionsDigest: 'sha256:9c1e',
  policyDigest: 'sha256:44ab', codeArtifact: 'git:flight-demo',
  tools: [{ name: 'browser', version: '1.0.0', permissions: ['navigate', 'read'] }],
};

export interface TraceWorld {
  service: FlightTraceService;
  registry: SqliteAgentRegistry;
  ledger: TaskAuthorizationManager;
  agent: AuthenticatedAgent;
  mandateId: string;
  cleanup(): void;
}

/** A registry with one approved agent version, a ledger with room for a $600 trip, and a trace service. */
export function createTraceWorld(contractDigest = orderFingerprint(confirmedRequirements)): TraceWorld {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-flight-'));
  const now = () => new Date('2026-09-28T12:00:00Z');
  const registry = new SqliteAgentRegistry(path.join(dir, 'agents.sqlite'));
  const store = new SqliteTraceStore(path.join(dir, 'trace.sqlite'));
  const config = loadConfig('scrip.yaml');
  config.budgets.research.maxTaskAllowance = 1000;
  config.budgets.research.monthlyLimit = 100000;
  const ledger = new TaskAuthorizationManager(config, { getReportedSpend: async () => 0, reportTaskUsage: async () => {} });
  const lineage = registry.registerLineage({ ownerId: 'armaan', operator: 'acme-labs', displayName: 'Flight agent' }, now());
  const version = registry.registerVersion({ lineageId: lineage.lineageId, manifest, registeredBy: 'armaan' }, now());
  const credential = registry.issueCredential({ lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now());
  const agent = registry.authenticate(credential.credentialId, credential.secret, now());
  const mandate = registry.createMandate({
    principalId: 'armaan', lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
    fundingSourceId: 'wallet-main', scopes: ['purchase'], notBefore: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    outcomeContractDigest: contractDigest, changePolicy: 'require_approval', approvedBy: 'armaan', approvedAt: now().toISOString(),
  });
  const service = new FlightTraceService({ store, registry, ledger, budget: 'research', now });
  return {
    service, registry, ledger, agent, mandateId: mandate.mandateId,
    cleanup() { store.close(); registry.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
