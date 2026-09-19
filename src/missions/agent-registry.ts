import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  AgentAuthenticationError, AgentAuthorizationError, classifyManifestChange, hashSecret, issueSecret,
  manifestDigest, secretMatches, strictestTransition,
  type AgentCredentialRecord, type AgentLineage, type AgentManifest, type AgentVersion,
  type AuthenticatedAgent, type AuthorityTransition, type FinancialMandate,
  type IssuedAgentCredential, type ManifestChange,
} from './agent-identity.js';

// Same loader rationale as mission-store.ts: the repository's Vite/Vitest
// version does not resolve the static `node:sqlite` built-in import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** Why an authority check failed, for events and receipts. */
export interface AuthorityDecision {
  allowed: boolean;
  reasons: string[];
  mandateId?: string;
  versionId?: string;
}

/**
 * Persistent registry for agent lineages, immutable versions, scoped
 * credentials, and financial mandates.
 *
 * It owns the authentication and authorization boundary: a caller-supplied
 * lineage ID, version ID, or manifest digest is an unauthenticated claim.
 * Only `authenticate()` - which verifies a credential secret against a
 * stored hash - produces an `AuthenticatedAgent`.
 */
export class SqliteAgentRegistry {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS agent_lineages (
        lineage_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_versions (
        version_id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL, manifest_digest TEXT NOT NULL,
        body TEXT NOT NULL, UNIQUE (lineage_id, manifest_digest)
      );
      CREATE TABLE IF NOT EXISTS agent_credentials (
        credential_id TEXT PRIMARY KEY, lineage_id TEXT NOT NULL, version_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS financial_mandates (
        mandate_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, lineage_id TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS immutable_version_manifest BEFORE UPDATE ON agent_versions
        WHEN OLD.manifest_digest <> NEW.manifest_digest
        BEGIN SELECT RAISE(ABORT, 'Agent version manifests are immutable'); END;`);
  }

  // --- lineages ---------------------------------------------------------

  registerLineage(input: { ownerId: string; operator: string; displayName: string }, now: Date): AgentLineage {
    if (!input.ownerId.trim()) throw new Error('Owner identity required');
    const lineage: AgentLineage = {
      lineageId: randomUUID(), ownerId: input.ownerId, operator: input.operator,
      displayName: input.displayName, status: 'active', createdAt: now.toISOString(),
    };
    this.db.prepare('INSERT INTO agent_lineages VALUES (?, ?, ?)')
      .run(lineage.lineageId, lineage.ownerId, JSON.stringify(lineage));
    return lineage;
  }

  getLineage(lineageId: string): AgentLineage {
    const row = this.db.prepare('SELECT body FROM agent_lineages WHERE lineage_id = ?').get(lineageId) as
      { body: string } | undefined;
    if (!row) throw new AgentAuthorizationError(`Unknown agent lineage ${lineageId}`);
    return JSON.parse(row.body) as AgentLineage;
  }

  private saveLineage(lineage: AgentLineage): void {
    this.db.prepare('UPDATE agent_lineages SET body = ? WHERE lineage_id = ?')
      .run(JSON.stringify(lineage), lineage.lineageId);
  }

  /**
   * An operator change means different people run the software under the
   * same identity, so SPEC.md requires revoking affected authority rather
   * than asking for review.
   */
  changeOperator(lineageId: string, operator: string, now: Date): { lineage: AgentLineage; revokedMandates: string[] } {
    const lineage = this.getLineage(lineageId);
    if (lineage.operator === operator) return { lineage, revokedMandates: [] };
    lineage.operator = operator;
    this.saveLineage(lineage);
    const revokedMandates: string[] = [];
    for (const mandate of this.mandatesForLineage(lineageId)) {
      if (mandate.status === 'revoked') continue;
      mandate.status = 'revoked';
      mandate.pauseReason = `Operator changed to ${operator} at ${now.toISOString()}`;
      this.saveMandate(mandate);
      revokedMandates.push(mandate.mandateId);
    }
    return { lineage, revokedMandates };
  }

  // --- versions ---------------------------------------------------------

  /**
   * Registers an immutable version. Re-registering a manifest already
   * known for this lineage returns the existing record, so a restarted
   * agent does not accumulate duplicate versions.
   */
  registerVersion(input: {
    lineageId: string; manifest: AgentManifest; registeredBy: string;
    parentVersionId?: string;
  }, now: Date): AgentVersion {
    this.getLineage(input.lineageId);
    const digest = manifestDigest(input.manifest);
    const existing = this.db.prepare('SELECT body FROM agent_versions WHERE lineage_id = ? AND manifest_digest = ?')
      .get(input.lineageId, digest) as { body: string } | undefined;
    if (existing) return JSON.parse(existing.body) as AgentVersion;
    const version: AgentVersion = {
      versionId: randomUUID(), lineageId: input.lineageId, parentVersionId: input.parentVersionId,
      manifest: structuredClone(input.manifest), manifestDigest: digest,
      // Hard-coded, not a parameter. Nothing in this process observes the
      // running software, so 'self_declared' is the only level this registry
      // can honestly issue. Accepting a caller-supplied level would let an
      // operator label its own agent 'runtime_attested' with no attestation
      // performed - a truthful-label failure, not merely a missing feature.
      // Stronger levels require an AttestationVerifier (see AttestationLevel).
      attestationLevel: 'self_declared',
      registeredBy: input.registeredBy, registeredAt: now.toISOString(), revocationEpoch: 0,
    };
    this.db.prepare('INSERT INTO agent_versions VALUES (?, ?, ?, ?)')
      .run(version.versionId, version.lineageId, digest, JSON.stringify(version));
    return version;
  }

  getVersion(versionId: string): AgentVersion {
    const row = this.db.prepare('SELECT body FROM agent_versions WHERE version_id = ?').get(versionId) as
      { body: string } | undefined;
    if (!row) throw new AgentAuthorizationError(`Unknown agent version ${versionId}`);
    return JSON.parse(row.body) as AgentVersion;
  }

  private saveVersion(version: AgentVersion): void {
    this.db.prepare('UPDATE agent_versions SET body = ? WHERE version_id = ?')
      .run(JSON.stringify(version), version.versionId);
  }

  /**
   * Detects tampering: recomputes the digest from the stored manifest. A
   * mismatch means the record was altered outside registerVersion().
   */
  verifyManifestIntegrity(versionId: string): boolean {
    const version = this.getVersion(versionId);
    return manifestDigest(version.manifest) === version.manifestDigest;
  }

  /** Raises the revocation epoch, stranding credentials issued before it. */
  revokeVersion(versionId: string, reason: string, now: Date): AgentVersion {
    const version = this.getVersion(versionId);
    version.revocationEpoch += 1;
    version.revokedAt = now.toISOString();
    version.revocationReason = reason;
    this.saveVersion(version);
    for (const mandate of this.mandatesForLineage(version.lineageId)) {
      if (mandate.status === 'revoked' || !mandate.authorizedVersionIds.includes(versionId)) continue;
      mandate.status = 'revoked';
      mandate.pauseReason = `Agent version ${versionId} revoked: ${reason}`;
      this.saveMandate(mandate);
    }
    return version;
  }

  /**
   * Registers a successor and applies the change policy to every active
   * mandate on the lineage. Returns the classified diff so a consumer
   * surface can render "this agent gained a purchasing tool".
   */
  registerSuccessor(input: {
    lineageId: string; parentVersionId: string; manifest: AgentManifest; registeredBy: string;
  }, now: Date): { version: AgentVersion; changes: ManifestChange[]; transition: AuthorityTransition; affectedMandates: string[] } {
    const parent = this.getVersion(input.parentVersionId);
    const changes = classifyManifestChange(parent.manifest, input.manifest);
    const transition = strictestTransition(changes);
    const version = this.registerVersion({
      lineageId: input.lineageId, manifest: input.manifest,
      registeredBy: input.registeredBy, parentVersionId: input.parentVersionId,
    }, now);
    const affectedMandates: string[] = [];
    // A successor never inherits authority: it is not added to any
    // authorizedVersionIds. Existing mandates keep authorizing the parent
    // unless the change is severe enough to pause or revoke them.
    for (const mandate of this.mandatesForLineage(input.lineageId)) {
      if (mandate.status !== 'active' || !mandate.authorizedVersionIds.includes(input.parentVersionId)) continue;
      if (transition === 'retain') continue;
      mandate.status = transition === 'revoke' ? 'revoked' : 'paused_pending_approval';
      mandate.pauseReason = changes.map(change => change.summary).join('; ') || 'Unclassified agent change';
      this.saveMandate(mandate);
      affectedMandates.push(mandate.mandateId);
    }
    return { version, changes, transition, affectedMandates };
  }

  // --- credentials ------------------------------------------------------

  issueCredential(input: { lineageId: string; versionId: string; expiresAt: string }, now: Date): IssuedAgentCredential {
    const version = this.getVersion(input.versionId);
    if (version.lineageId !== input.lineageId) throw new AgentAuthorizationError('Version does not belong to this lineage');
    if (version.revokedAt) throw new AgentAuthorizationError('Cannot issue a credential for a revoked version');
    const secret = issueSecret();
    const record: AgentCredentialRecord = {
      credentialId: randomUUID(), lineageId: input.lineageId, versionId: input.versionId,
      secretHash: hashSecret(secret), issuedAt: now.toISOString(), expiresAt: input.expiresAt,
      issuedAtEpoch: version.revocationEpoch,
    };
    this.db.prepare('INSERT INTO agent_credentials VALUES (?, ?, ?, ?, ?)')
      .run(record.credentialId, record.lineageId, record.versionId, record.secretHash, JSON.stringify(record));
    return { credentialId: record.credentialId, secret };
  }

  /**
   * Rotation binds a replacement credential to the same version and
   * revokes the old one. It is an authenticated procedure: the caller
   * must present the current secret.
   */
  rotateCredential(credentialId: string, currentSecret: string, expiresAt: string, now: Date): IssuedAgentCredential {
    const record = this.credentialRecord(credentialId);
    if (!record || !secretMatches(currentSecret, record.secretHash)) {
      throw new AgentAuthenticationError('Credential rotation requires the current secret');
    }
    const replacement = this.issueCredential(
      { lineageId: record.lineageId, versionId: record.versionId, expiresAt }, now,
    );
    record.revokedAt = now.toISOString();
    this.db.prepare('UPDATE agent_credentials SET body = ? WHERE credential_id = ?')
      .run(JSON.stringify(record), credentialId);
    return replacement;
  }

  private credentialRecord(credentialId: string): AgentCredentialRecord | undefined {
    const row = this.db.prepare('SELECT body FROM agent_credentials WHERE credential_id = ?').get(credentialId) as
      { body: string } | undefined;
    return row ? JSON.parse(row.body) as AgentCredentialRecord : undefined;
  }

  /**
   * The only way to obtain an AuthenticatedAgent. Verifies the secret,
   * expiry, credential revocation, version revocation, and that the
   * credential's issuance epoch still matches the version - which is what
   * rejects a credential replayed after its version was revoked.
   */
  authenticate(credentialId: string, secret: string, now: Date): AuthenticatedAgent {
    const record = this.credentialRecord(credentialId);
    if (!record || !secretMatches(secret, record.secretHash)) {
      throw new AgentAuthenticationError('Invalid agent credential');
    }
    if (record.revokedAt) throw new AgentAuthenticationError('Agent credential revoked');
    if (Date.parse(record.expiresAt) <= now.getTime()) throw new AgentAuthenticationError('Agent credential expired');
    const version = this.getVersion(record.versionId);
    if (version.revokedAt) throw new AgentAuthenticationError('Agent version revoked');
    if (version.revocationEpoch !== record.issuedAtEpoch) {
      throw new AgentAuthenticationError('Agent credential is stale for this version');
    }
    const lineage = this.getLineage(record.lineageId);
    if (lineage.status !== 'active') throw new AgentAuthenticationError(`Agent lineage is ${lineage.status}`);
    // The one place an AuthenticatedAgent is minted. The cast is the brand's
    // sole escape hatch and is deliberately confined to this function, which
    // has just verified the secret, expiry, revocation, epoch, and lineage.
    return {
      credentialId: record.credentialId, lineageId: record.lineageId,
      versionId: record.versionId, principalId: lineage.ownerId,
    } as AuthenticatedAgent;
  }

  /**
   * Re-verifies a previously authenticated credential against current
   * stored state, without needing the secret again.
   *
   * authenticate() proves possession at one instant. This proves the
   * credential is *still* valid now - it may have been rotated, revoked,
   * expired, or stranded by a version revocation in between. Every
   * authority check calls this, which is what stops a stale
   * AuthenticatedAgent object from spending after its credential died.
   */
  verifyCredential(agent: AuthenticatedAgent, now: Date): string[] {
    const reasons: string[] = [];
    const record = this.credentialRecord(agent.credentialId);
    if (!record) return ['Unknown agent credential'];
    // Guards against a credential id paired with mismatched claims.
    if (record.lineageId !== agent.lineageId || record.versionId !== agent.versionId) {
      return ['Credential does not match the presented agent binding'];
    }
    if (record.revokedAt) reasons.push('Agent credential revoked');
    if (Date.parse(record.expiresAt) <= now.getTime()) reasons.push('Agent credential expired');
    const version = this.getVersion(record.versionId);
    if (version.revocationEpoch !== record.issuedAtEpoch) reasons.push('Agent credential is stale for this version');
    const lineage = this.getLineage(record.lineageId);
    if (lineage.status !== 'active') reasons.push(`Agent lineage is ${lineage.status}`);
    if (lineage.ownerId !== agent.principalId) reasons.push('Credential principal does not match');
    return reasons;
  }

  // --- mandates ---------------------------------------------------------

  createMandate(input: Omit<FinancialMandate, 'mandateId' | 'status' | 'revocationEpoch'>): FinancialMandate {
    const version = this.getVersion(input.authorizedVersionIds[0]);
    const mandate: FinancialMandate = {
      ...input, mandateId: randomUUID(), status: 'active', revocationEpoch: version.revocationEpoch,
    };
    this.db.prepare('INSERT INTO financial_mandates VALUES (?, ?, ?, ?)')
      .run(mandate.mandateId, mandate.principalId, mandate.lineageId, JSON.stringify(mandate));
    return mandate;
  }

  getMandate(mandateId: string): FinancialMandate {
    const row = this.db.prepare('SELECT body FROM financial_mandates WHERE mandate_id = ?').get(mandateId) as
      { body: string } | undefined;
    if (!row) throw new AgentAuthorizationError(`Unknown financial mandate ${mandateId}`);
    return JSON.parse(row.body) as FinancialMandate;
  }

  private saveMandate(mandate: FinancialMandate): void {
    this.db.prepare('UPDATE financial_mandates SET body = ? WHERE mandate_id = ?')
      .run(JSON.stringify(mandate), mandate.mandateId);
  }

  private mandatesForLineage(lineageId: string): FinancialMandate[] {
    return (this.db.prepare('SELECT body FROM financial_mandates WHERE lineage_id = ?').all(lineageId) as
      { body: string }[]).map(row => JSON.parse(row.body) as FinancialMandate);
  }

  /** Re-approval after a pause. Binds the mandate to the new version explicitly. */
  approveMandateChange(mandateId: string, versionId: string, approvedBy: string, now: Date): FinancialMandate {
    const mandate = this.getMandate(mandateId);
    if (mandate.status === 'revoked') throw new AgentAuthorizationError('A revoked mandate cannot be resumed');
    const version = this.getVersion(versionId);
    if (version.lineageId !== mandate.lineageId) throw new AgentAuthorizationError('Version does not belong to this lineage');
    if (version.revokedAt) throw new AgentAuthorizationError('Cannot authorize a revoked version');
    if (!mandate.authorizedVersionIds.includes(versionId)) mandate.authorizedVersionIds.push(versionId);
    mandate.status = 'active';
    mandate.revocationEpoch = version.revocationEpoch;
    mandate.approvedBy = approvedBy;
    mandate.approvedAt = now.toISOString();
    delete mandate.pauseReason;
    this.saveMandate(mandate);
    return mandate;
  }

  revokeMandate(mandateId: string, reason: string): FinancialMandate {
    const mandate = this.getMandate(mandateId);
    mandate.status = 'revoked';
    mandate.pauseReason = reason;
    this.saveMandate(mandate);
    return mandate;
  }

  /**
   * The authorization gate, called both before reservation and again
   * immediately before external dispatch. Returns a decision rather than
   * throwing so callers can record why authority was refused.
   */
  authorize(
    agent: AuthenticatedAgent, mandateId: string, contractDigest: string, now: Date,
    /**
     * What the agent is asking to do, and from where. Both are checked
     * against the mandate. Optional only so callers predating scope
     * enforcement still typecheck; omitting `operation` skips the scope
     * check, so pass it on every spending path.
     */
    request?: { operation: string; fundingSourceId?: string },
  ): AuthorityDecision {
    // Freshness first: a credential revoked, rotated, or stranded since
    // authentication invalidates everything downstream.
    const reasons = this.verifyCredential(agent, now);
    const mandate = this.getMandate(mandateId);
    if (request) {
      if (!mandate.scopes.includes(request.operation)) {
        reasons.push(`Mandate does not permit operation "${request.operation}"`);
      }
      if (request.fundingSourceId !== undefined && mandate.fundingSourceId !== request.fundingSourceId) {
        reasons.push('Funding source does not match the mandate');
      }
    }
    if (mandate.principalId !== agent.principalId) reasons.push('Mandate belongs to another principal');
    if (mandate.lineageId !== agent.lineageId) reasons.push('Mandate belongs to another agent lineage');
    if (mandate.status !== 'active') reasons.push(`Mandate is ${mandate.status}`);
    if (!mandate.authorizedVersionIds.includes(agent.versionId)) reasons.push('Agent version is not authorized by this mandate');
    if (mandate.outcomeContractDigest !== contractDigest) reasons.push('Approved contract digest does not match');
    if (Date.parse(mandate.notBefore) > now.getTime()) reasons.push('Mandate is not yet effective');
    if (Date.parse(mandate.expiresAt) <= now.getTime()) reasons.push('Mandate expired');
    const version = this.getVersion(agent.versionId);
    if (version.revokedAt) reasons.push('Agent version revoked');
    if (version.revocationEpoch !== mandate.revocationEpoch) reasons.push('Agent version changed since this mandate was approved');
    if (!this.verifyManifestIntegrity(agent.versionId)) reasons.push('Agent manifest digest does not match its recorded manifest');
    return { allowed: reasons.length === 0, reasons, mandateId, versionId: agent.versionId };
  }

  close(): void { this.db.close(); }
}
