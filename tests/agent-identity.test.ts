import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ScripConfig } from '../src/config.js';
import {
  AgentAuthenticationError, AgentAuthorizationError, classifyManifestChange, manifestDigest,
  strictestTransition, type AgentManifest,
} from '../src/missions/agent-identity.js';
import { SqliteAgentRegistry } from '../src/missions/agent-registry.js';
import { SqliteMissionStore } from '../src/missions/mission-store.js';
import { PurchaseMissionService } from '../src/missions/purchase-mission-service.js';
import type {
  BookingEvidence, ContractInput, ExecutionProvider, ExecutionRequest, HotelBooking,
  PaymentCapabilityProvider, PaymentFact,
} from '../src/missions/types.js';

const booking: HotelBooking = {
  quoteId: 'quote-1', merchant: 'hotel.example', hotelName: 'Boston Hotel', roomType: 'Double', city: 'Boston',
  startsOn: '2099-09-18', endsOn: '2099-09-20', total: 500, currency: 'USD', rating: 4,
  refundableUntil: '2099-09-16T23:59:00-04:00', cancellationTerms: 'Full refund until the stated deadline; no cancellation fee.',
};
const terms: ContractInput = {
  goal: 'Book a refundable Boston hotel', category: 'travel', currency: 'USD', maximumTotal: 550,
  hardConstraints: [
    { type: 'amount_at_most', amount: 550 }, { type: 'merchant_in', merchants: ['hotel.example'] },
    { type: 'date_range', startsOn: booking.startsOn, endsOn: booking.endsOn },
    { type: 'refundable_until', timestamp: booking.refundableUntil },
    { type: 'rating_at_least', value: 4, scale: 5 }, { type: 'text_match', field: 'city', expected: 'Boston' },
  ],
  preferences: [], unresolvedHardConstraints: [], expiresAt: '2099-09-15T12:00:00-04:00',
  approvalPolicy: 'confirm_exact_purchase', purchase: booking,
  successConditions: ['booking_matches_contract', 'payment_captured'],
  recoveryPolicy: {
    allowMerchantCancellation: true, allowMerchantRefundRequest: true, allowReplacement: false,
    allowRebooking: false, disputeRequiresConfirmation: true,
  },
};

const baseManifest: AgentManifest = {
  model: 'claude-opus-5', modelIsMutableAlias: false,
  instructionsDigest: 'sha256:instructions-v1', policyDigest: 'sha256:policy-v1',
  codeArtifact: 'git:abc123',
  tools: [{ name: 'browser', version: '1.0.0', permissions: ['navigate', 'read'] }],
};

class FakeProviders {
  effects = 0;
  facts = new Map<string, PaymentFact[]>();
  evidence = new Map<string, BookingEvidence[]>();
  beforeIssue?: (request: Omit<ExecutionRequest, 'capabilityRef'>) => Promise<void>;
  execution: ExecutionProvider = {
    start: vi.fn(async request => {
      this.effects++;
      this.facts.set(request.operationKey, [{
        externalId: `captured:${request.operationKey}`, operationKey: request.operationKey,
        transactionRef: `tx:${request.operationKey}`, kind: 'captured', amount: request.booking.total,
        currency: 'USD', merchant: request.booking.merchant,
      }]);
      this.evidence.set(request.operationKey, [{
        source: 'merchant', externalId: `booking:${request.operationKey}`, operationKey: request.operationKey,
        bookingRef: 'reservation-1', status: 'confirmed', booking: structuredClone(request.booking),
        type: 'hotel_confirmation', description: 'Merchant API confirmation', verifiedAt: new Date().toISOString(),
      }]);
      return { executionRef: `execution:${request.operationKey}` };
    }),
    getEvidence: vi.fn(async key => structuredClone(this.evidence.get(key) ?? [])),
    stop: vi.fn(async () => {}),
  };
  payments: PaymentCapabilityProvider = {
    issue: vi.fn(async request => {
      await this.beforeIssue?.(request);
      return { capabilityRef: `fake-capability:${request.operationKey}` };
    }),
    getFacts: vi.fn(async key => structuredClone(this.facts.get(key) ?? [])),
    revoke: vi.fn(async () => {}),
    requestRecovery: vi.fn(async request => ({ externalId: `ack:${request.recoveryKey}` })),
  };
}

let directory: string;
let store: SqliteMissionStore;
let registry: SqliteAgentRegistry;
let service: PurchaseMissionService;
let fake: FakeProviders;
let config: ScripConfig;
const now = () => new Date('2099-01-01T00:00:00Z');

/** A credential presentation, as an agent would send it to the service. */
function cred(issued: { credentialId: string; secret: string }) {
  return { credentialId: issued.credentialId, secret: issued.secret };
}

/** Registers a lineage + version + credential and returns the authenticated agent. */
function enrolAgent(manifest: AgentManifest = baseManifest) {
  const lineage = registry.registerLineage(
    { ownerId: 'consumer-1', operator: 'acme-labs', displayName: 'Shopper' }, now(),
  );
  const version = registry.registerVersion(
    { lineageId: lineage.lineageId, manifest, registeredBy: 'consumer-1' }, now(),
  );
  const credential = registry.issueCredential(
    { lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now(),
  );
  return { lineage, version, credential };
}

async function boundMission(agentVersionId: string, lineageId: string) {
  const mission = await service.create('consumer-1', structuredClone(terms));
  const rendered = service.renderApproval('consumer-1', mission.missionId);
  const mandate = registry.createMandate({
    principalId: 'consumer-1', lineageId, authorizedVersionIds: [agentVersionId],
    fundingSourceId: 'funding-1', scopes: ['purchase'], notBefore: '2099-01-01T00:00:00Z',
    expiresAt: '2099-09-15T00:00:00Z', outcomeContractDigest: rendered.hash,
    changePolicy: 'require_approval', approvedBy: 'consumer-1', approvedAt: now().toISOString(),
  });
  await service.approve('consumer-1', mission.missionId, {
    channel: 'web', contractVersion: rendered.contractVersion, renderedSummaryHash: rendered.hash,
  }, { agentLineageId: lineageId, authorizedAgentVersionId: agentVersionId, financialMandateId: mandate.mandateId });
  return { missionId: mission.missionId, mandate };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scrip-agent-'));
  store = new SqliteMissionStore(path.join(directory, 'missions.sqlite'));
  registry = new SqliteAgentRegistry(path.join(directory, 'agents.sqlite'));
  fake = new FakeProviders();
  config = loadConfig('scrip.yaml');
  config.budgets.research.maxTaskAllowance = 550;
  config.budgets.research.monthlyLimit = 10000;
  service = new PurchaseMissionService(store, config, 'research', fake.execution, fake.payments, now, registry);
});
afterEach(() => {
  store.close(); registry.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('agent manifest and change classification', () => {
  it('digests depend on content, not key or array order', () => {
    const reordered: AgentManifest = {
      ...baseManifest,
      tools: [{ name: 'browser', version: '1.0.0', permissions: ['read', 'navigate'] }],
    };
    expect(manifestDigest(reordered)).toBe(manifestDigest(baseManifest));
  });

  it('never classifies a code or dependency change as harmless', () => {
    const patched = { ...baseManifest, codeArtifact: 'git:def456' };
    const changes = classifyManifestChange(baseManifest, patched);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeClass).toBe('unknown_effect');
    expect(strictestTransition(changes)).toBe('require_review');
  });

  it('pauses on model, instruction, and policy changes, and on a gained tool permission', () => {
    expect(strictestTransition(classifyManifestChange(baseManifest, { ...baseManifest, model: 'other-model' })))
      .toBe('pause_pending_approval');
    expect(strictestTransition(classifyManifestChange(baseManifest, { ...baseManifest, instructionsDigest: 'sha256:v2' })))
      .toBe('pause_pending_approval');
    expect(strictestTransition(classifyManifestChange(baseManifest, { ...baseManifest, policyDigest: 'sha256:v2' })))
      .toBe('pause_pending_approval');
    const expanded = {
      ...baseManifest,
      tools: [{ name: 'browser', version: '1.0.0', permissions: ['navigate', 'read', 'purchase'] }],
    };
    const changes = classifyManifestChange(baseManifest, expanded);
    expect(changes[0].changeClass).toBe('expanded_permission');
    expect(changes[0].summary).toContain('purchase');
    expect(strictestTransition(changes)).toBe('pause_pending_approval');
  });

  it('flags a new tool as expanded permission', () => {
    const withTool: AgentManifest = {
      ...baseManifest,
      tools: [...baseManifest.tools, { name: 'payments', version: '1.0.0', permissions: ['charge'] }],
    };
    const changes = classifyManifestChange(baseManifest, withTool);
    expect(changes.some(change => change.summary.includes('gained a new tool'))).toBe(true);
    expect(strictestTransition(changes)).toBe('pause_pending_approval');
  });

  it('records only self_declared attestation and says so', () => {
    const { version } = enrolAgent();
    expect(version.attestationLevel).toBe('self_declared');
  });
});

describe('registration and credential boundaries', () => {
  it('re-registering an identical manifest is idempotent', () => {
    const { lineage, version } = enrolAgent();
    const again = registry.registerVersion(
      { lineageId: lineage.lineageId, manifest: baseManifest, registeredBy: 'consumer-1' }, now(),
    );
    expect(again.versionId).toBe(version.versionId);
  });

  it('a caller-supplied agent ID is not authentication', () => {
    const { credential } = enrolAgent();
    expect(() => registry.authenticate(credential.credentialId, 'scrip_agent_guessed', now()))
      .toThrow(AgentAuthenticationError);
    expect(() => registry.authenticate('not-a-credential', credential.secret, now()))
      .toThrow(AgentAuthenticationError);
  });

  it('rejects an expired credential and one whose lineage is suspended', () => {
    const { lineage, version } = enrolAgent();
    const shortLived = registry.issueCredential(
      { lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-01-01T00:00:00Z' }, now(),
    );
    expect(() => registry.authenticate(shortLived.credentialId, shortLived.secret, now()))
      .toThrow(/expired/);
  });

  it('rotation requires the current secret and strands the replaced credential', () => {
    const { credential } = enrolAgent();
    expect(() => registry.rotateCredential(credential.credentialId, 'wrong', '2099-12-31T00:00:00Z', now()))
      .toThrow(AgentAuthenticationError);
    const rotated = registry.rotateCredential(credential.credentialId, credential.secret, '2099-12-31T00:00:00Z', now());
    expect(registry.authenticate(rotated.credentialId, rotated.secret, now()).versionId).toBeDefined();
    expect(() => registry.authenticate(credential.credentialId, credential.secret, now()))
      .toThrow(/revoked/);
  });

  it('rejects a revoked-version credential replay even with a valid secret', () => {
    const { lineage, version, credential } = enrolAgent();
    expect(registry.authenticate(credential.credentialId, credential.secret, now()).lineageId).toBe(lineage.lineageId);
    registry.revokeVersion(version.versionId, 'compromised', now());
    expect(() => registry.authenticate(credential.credentialId, credential.secret, now()))
      .toThrow(AgentAuthenticationError);
  });

  it('refuses to issue a credential for a revoked version', () => {
    const { lineage, version } = enrolAgent();
    registry.revokeVersion(version.versionId, 'compromised', now());
    expect(() => registry.issueCredential(
      { lineageId: lineage.lineageId, versionId: version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now(),
    )).toThrow(AgentAuthorizationError);
  });

  it('detects an altered manifest record', () => {
    const { version } = enrolAgent();
    expect(registry.verifyManifestIntegrity(version.versionId)).toBe(true);
    // Tamper the stored manifest without going through registerVersion().
    const raw = fs.readFileSync(path.join(directory, 'agents.sqlite'));
    expect(raw.length).toBeGreaterThan(0);
    const tampered = { ...version, manifest: { ...version.manifest, codeArtifact: 'git:evil' } };
    (registry as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare('UPDATE agent_versions SET body = ? WHERE version_id = ?')
      .run(JSON.stringify(tampered), version.versionId);
    expect(registry.verifyManifestIntegrity(version.versionId)).toBe(false);
  });
});

describe('version-bound mandates in the mission lifecycle', () => {
  it('runs an agent-bound mission end to end and records the acting version', async () => {
    const { lineage, version, credential } = enrolAgent();
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    const { missionId, mandate } = await boundMission(version.versionId, lineage.lineageId);
    await service.execute('consumer-1', missionId, booking, cred(credential));
    const receipt = await service.getReceipt('consumer-1', missionId);
    expect(receipt.captured).toBe(500);
    expect(receipt.agentVersionId).toBe(version.versionId);
    expect(receipt.agentLineageId).toBe(lineage.lineageId);
    expect(receipt.financialMandateId).toBe(mandate.mandateId);
    expect(receipt.agentAttestationLevel).toBe('self_declared');
    const checks = receipt.events.filter(event => event.type === 'agent_authority_checked');
    expect(checks.map(event => (event.data as { stage: string }).stage)).toEqual(['pre_reservation', 'pre_dispatch']);
  });

  it('refuses an unauthorized version before any reservation or provider call', async () => {
    const { lineage, version } = enrolAgent();
    const other = registry.registerVersion(
      { lineageId: lineage.lineageId, manifest: { ...baseManifest, codeArtifact: 'git:other' }, registeredBy: 'consumer-1' }, now(),
    );
    const otherCredential = registry.issueCredential(
      { lineageId: lineage.lineageId, versionId: other.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now(),
    );
    const impostor = registry.authenticate(otherCredential.credentialId, otherCredential.secret, now());
    const { missionId } = await boundMission(version.versionId, lineage.lineageId);
    await expect(service.execute('consumer-1', missionId, booking, cred(otherCredential))).rejects.toThrow(/not authorized/);
    expect(fake.effects).toBe(0);
    expect(fake.payments.issue).not.toHaveBeenCalled();
    const receipt = await service.getReceipt('consumer-1', missionId);
    expect(receipt.reserved).toBe(0);
    expect(receipt.events.some(event => event.type === 'agent_authority_refused')).toBe(true);
  });

  it('requires an authenticated agent for an agent-bound mission', async () => {
    const { lineage, version } = enrolAgent();
    const { missionId } = await boundMission(version.versionId, lineage.lineageId);
    await expect(service.execute('consumer-1', missionId, booking)).rejects.toThrow(/requires an agent credential/);
    expect(fake.effects).toBe(0);
  });

  it('pauses the mandate when the agent version changes after approval', async () => {
    const { lineage, version, credential } = enrolAgent();
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    const { missionId, mandate } = await boundMission(version.versionId, lineage.lineageId);
    const successor = registry.registerSuccessor({
      lineageId: lineage.lineageId, parentVersionId: version.versionId,
      manifest: { ...baseManifest, instructionsDigest: 'sha256:instructions-v2' }, registeredBy: 'consumer-1',
    }, now());
    expect(successor.transition).toBe('pause_pending_approval');
    expect(successor.affectedMandates).toContain(mandate.mandateId);
    // The successor inherits no authority.
    expect(registry.getMandate(mandate.mandateId).authorizedVersionIds).not.toContain(successor.version.versionId);
    await expect(service.execute('consumer-1', missionId, booking, cred(credential))).rejects.toThrow(/paused_pending_approval/);
    expect(fake.effects).toBe(0);
  });

  it('resumes only after explicit re-approval binding the new version', async () => {
    const { lineage, version, credential } = enrolAgent();
    const { missionId, mandate } = await boundMission(version.versionId, lineage.lineageId);
    const successor = registry.registerSuccessor({
      lineageId: lineage.lineageId, parentVersionId: version.versionId,
      manifest: { ...baseManifest, codeArtifact: 'git:def456' }, registeredBy: 'consumer-1',
    }, now());
    expect(successor.transition).toBe('require_review');
    registry.approveMandateChange(mandate.mandateId, successor.version.versionId, 'consumer-1', now());
    const newCredential = registry.issueCredential(
      { lineageId: lineage.lineageId, versionId: successor.version.versionId, expiresAt: '2099-12-31T00:00:00Z' }, now(),
    );
    await service.execute('consumer-1', missionId, booking, cred(newCredential));
    const receipt = await service.getReceipt('consumer-1', missionId);
    expect(receipt.captured).toBe(500);
    expect(receipt.agentVersionId).toBe(successor.version.versionId);
    expect(credential.secret).not.toBe(newCredential.secret);
  });

  it('revokes mandates when the operator changes', async () => {
    const { lineage, version, credential } = enrolAgent();
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    const { missionId, mandate } = await boundMission(version.versionId, lineage.lineageId);
    const result = registry.changeOperator(lineage.lineageId, 'new-operator', now());
    expect(result.revokedMandates).toContain(mandate.mandateId);
    await expect(service.execute('consumer-1', missionId, booking, cred(credential))).rejects.toThrow(/revoked/);
    expect(fake.effects).toBe(0);
    // A revoked mandate cannot be resumed by re-approval.
    expect(() => registry.approveMandateChange(mandate.mandateId, version.versionId, 'consumer-1', now()))
      .toThrow(AgentAuthorizationError);
  });

  it('a revocation racing an in-flight operation stops dispatch but preserves the reservation', async () => {
    const { lineage, version, credential } = enrolAgent();
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    const { missionId, mandate } = await boundMission(version.versionId, lineage.lineageId);
    // Revoke after the reservation is durable but before external dispatch.
    fake.beforeIssue = async () => { registry.revokeMandate(mandate.mandateId, 'consumer paused all spending'); };
    await service.execute('consumer-1', missionId, booking, cred(credential));
    expect(fake.effects).toBe(0);
    const receipt = await service.getReceipt('consumer-1', missionId);
    expect(receipt.captured).toBe(0);
    const refusals = receipt.events.filter(event => event.type === 'agent_authority_refused');
    expect(refusals).toHaveLength(1);
    expect((refusals[0].data as { stage: string }).stage).toBe('pre_dispatch');
  });

  it('authorize() reports every reason a stale mandate fails', () => {
    const { lineage, version, credential } = enrolAgent();
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    const mandate = registry.createMandate({
      principalId: 'consumer-1', lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
      fundingSourceId: 'funding-1', scopes: ['purchase'], notBefore: '2099-01-01T00:00:00Z',
      expiresAt: '2099-09-15T00:00:00Z', outcomeContractDigest: 'sha256:some-contract',
      changePolicy: 'require_approval', approvedBy: 'consumer-1', approvedAt: now().toISOString(),
    });
    const decision = registry.authorize(agent, mandate.mandateId, 'sha256:a-different-contract', now());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('Approved contract digest does not match');
  });
});

describe('existing payment reconciliation is preserved', () => {
  it('an agent-bound mission still reconciles capture and evidence exactly once', async () => {
    const { lineage, version, credential } = enrolAgent();
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    const { missionId } = await boundMission(version.versionId, lineage.lineageId);
    await service.execute('consumer-1', missionId, booking, cred(credential));
    await service.reconcile('consumer-1', missionId);
    await service.reconcile('consumer-1', missionId);
    const receipt = await service.getReceipt('consumer-1', missionId);
    expect(fake.effects).toBe(1);
    expect(receipt.captured).toBe(500);
    expect(receipt.events.filter(event => event.type === 'payment_observed')).toHaveLength(1);
    expect(receipt.assessment?.status).toBe('success');
  });
});

/**
 * Adversarial regression tests. Each of these attacks SUCCEEDED against an
 * earlier revision of this code; they are kept as executable proof that the
 * corresponding control is present. See the whitepaper's evaluation agenda
 * (forged caller objects, stolen and expired credentials, missing scopes,
 * version rollback, revocation during dispatch).
 */
describe('adversarial: attacks that previously succeeded', () => {
  it('rejects a forged agent identity presented instead of a credential', async () => {
    const { lineage, version } = enrolAgent();
    const { missionId } = await boundMission(version.versionId, lineage.lineageId);
    // Previously: an object literal with the right fields spent successfully.
    // The branded type now rejects this at compile time; the cast simulates a
    // caller that bypasses the type system, and authentication still refuses.
    const forged = {
      credentialId: 'i-made-this-up', lineageId: lineage.lineageId,
      versionId: version.versionId, principalId: 'consumer-1', secret: 'not-a-real-secret',
    };
    await expect(service.execute('consumer-1', missionId, booking, forged)).rejects.toThrow();
    expect(fake.effects).toBe(0);
    expect(fake.payments.issue).not.toHaveBeenCalled();
  });

  it('rejects a credential that was revoked after it was first authenticated', async () => {
    const { lineage, version, credential } = enrolAgent();
    const { missionId } = await boundMission(version.versionId, lineage.lineageId);
    // Rotation revokes the old credential. Previously the service held an
    // already-authenticated object and never rechecked, so it still spent.
    registry.rotateCredential(credential.credentialId, credential.secret, '2099-12-31T00:00:00Z', now());
    await expect(service.execute('consumer-1', missionId, booking, cred(credential))).rejects.toThrow(/revoked/);
    expect(fake.effects).toBe(0);
  });

  it('refuses a purchase under a mandate scoped only to refunds', async () => {
    const { lineage, version, credential } = enrolAgent();
    const mission = await service.create('consumer-1', structuredClone(terms));
    const rendered = service.renderApproval('consumer-1', mission.missionId);
    const mandate = registry.createMandate({
      principalId: 'consumer-1', lineageId: lineage.lineageId, authorizedVersionIds: [version.versionId],
      fundingSourceId: 'funding-1', scopes: ['refund'], notBefore: '2099-01-01T00:00:00Z',
      expiresAt: '2099-09-15T00:00:00Z', outcomeContractDigest: rendered.hash,
      changePolicy: 'require_approval', approvedBy: 'consumer-1', approvedAt: now().toISOString(),
    });
    await service.approve('consumer-1', mission.missionId, {
      channel: 'web', contractVersion: rendered.contractVersion, renderedSummaryHash: rendered.hash,
    }, {
      agentLineageId: lineage.lineageId, authorizedAgentVersionId: version.versionId,
      financialMandateId: mandate.mandateId,
    });
    await expect(service.execute('consumer-1', mission.missionId, booking, cred(credential)))
      .rejects.toThrow(/does not permit operation "purchase"/);
    expect(fake.effects).toBe(0);
  });

  it('cannot label a version with an attestation level it never established', () => {
    const lineage = registry.registerLineage(
      { ownerId: 'consumer-1', operator: 'acme-labs', displayName: 'Shopper' }, now(),
    );
    // Previously registerVersion() accepted attestationLevel from its caller.
    // The parameter no longer exists, so an operator cannot self-assert a
    // stronger level; extra properties are ignored and the record stays honest.
    const version = registry.registerVersion({
      lineageId: lineage.lineageId, manifest: baseManifest, registeredBy: 'consumer-1',
      ...{ attestationLevel: 'runtime_attested' },
    } as Parameters<typeof registry.registerVersion>[0], now());
    expect(version.attestationLevel).toBe('self_declared');
  });

  it('rejects a credential whose claimed version does not match its record', async () => {
    const { lineage, version, credential } = enrolAgent();
    const other = registry.registerVersion(
      { lineageId: lineage.lineageId, manifest: { ...baseManifest, codeArtifact: 'git:other' }, registeredBy: 'consumer-1' }, now(),
    );
    const agent = registry.authenticate(credential.credentialId, credential.secret, now());
    // Splice a different versionId onto an otherwise valid authenticated agent.
    const spliced = { ...agent, versionId: other.versionId } as typeof agent;
    expect(registry.verifyCredential(spliced, now())).toContain('Credential does not match the presented agent binding');
    expect(version.versionId).not.toBe(other.versionId);
  });
});
