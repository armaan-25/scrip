import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Persistent agent identity and version-bound financial authority
 * (SPEC.md "Persistent agent identity and version-bound authority").
 *
 * Two version axes exist and must not be conflated:
 *   - OutcomeContract.version  - what the human authorized.
 *   - AgentVersion.versionId   - which software exercises that authority.
 * A contract revision never implies a new agent version, and vice versa.
 */

/**
 * How strongly the registry can vouch that the manifest describes the
 * software that actually ran.
 *
 * `self_declared` is the only level this implementation can issue: the
 * operator states the manifest and Scrip records it. A manifest digest
 * proves the *record* has not been altered since registration. It proves
 * nothing about the running process - no attestation, no code measurement,
 * no supply-chain verification. Stronger levels are reserved, not earned.
 */
export type AttestationLevel = 'self_declared' | 'signed_release' | 'runtime_attested';

/**
 * The seam a stronger attestation level would have to come through.
 *
 * Deliberately unimplemented: no verifier exists, so no registry path can
 * produce a level above 'self_declared'. This is the difference between a
 * missing feature and a dishonest label - a caller cannot assert stronger
 * assurance than was actually established, because there is no code path
 * that accepts such an assertion.
 *
 * A real implementation would appraise fresh evidence about a measured
 * environment (build provenance for 'signed_release', a verifier appraisal
 * bound to the requesting workload for 'runtime_attested') and would still
 * only cover measured components under a stated policy - never the remote
 * model provider, retrieved content, or merchant fulfillment.
 */
export interface AttestationVerifier {
  readonly level: Exclude<AttestationLevel, 'self_declared'>;
  appraise(manifest: AgentManifest, evidence: unknown): Promise<boolean>;
}

/** Security-relevant configuration. Any change here is a new AgentVersion. */
export interface AgentManifest {
  /** Model identifier as configured. */
  model: string;
  /**
   * True when `model` is a moving alias (e.g. a "-latest" tag) whose
   * underlying weights can change with no observable event here. An
   * unobservable upstream change is an explicit limitation of this
   * registry, recorded rather than defended against.
   */
  modelIsMutableAlias: boolean;
  /** Digest of the system instructions; never the instruction text itself. */
  instructionsDigest: string;
  /** Digest of the financial policy governing the agent. */
  policyDigest: string;
  /** Code artifact reference (commit, image digest, package version). */
  codeArtifact: string;
  /** Tool identity and version. A new or upgraded tool is a manifest change. */
  tools: { name: string; version: string; permissions: string[] }[];
}

export type AgentLineageStatus = 'active' | 'suspended' | 'retired';

/** Stable identity across versions. A lineage ID carries history, not permission. */
export interface AgentLineage {
  lineageId: string;
  /** Consumer who owns this agent. */
  ownerId: string;
  /** Party operating the software; a change here revokes authority. */
  operator: string;
  displayName: string;
  status: AgentLineageStatus;
  createdAt: string;
}

/** Immutable once registered. Re-registering identical content is idempotent. */
export interface AgentVersion {
  versionId: string;
  lineageId: string;
  parentVersionId?: string;
  manifest: AgentManifest;
  /** sha256 over the canonical manifest. Detects alteration of this record. */
  manifestDigest: string;
  attestationLevel: AttestationLevel;
  registeredBy: string;
  registeredAt: string;
  /**
   * Monotonic counter. Revoking a version raises it; a credential or
   * mandate issued under a lower epoch is stale and must be rejected,
   * which is what makes rollback-and-replay fail.
   */
  revocationEpoch: number;
  revokedAt?: string;
  revocationReason?: string;
}

/**
 * Classification of a manifest change, and the authority transition it
 * forces. Per SPEC.md: unclassified changes fail closed, and a dependency
 * or code change never earns an automatic "harmless" exemption.
 */
export type ChangeClass =
  | 'display_only'
  | 'unknown_effect'
  | 'behavioral'
  | 'expanded_permission'
  | 'operator_change';

export type AuthorityTransition = 'retain' | 'require_review' | 'pause_pending_approval' | 'revoke';

export interface ManifestChange {
  field: string;
  changeClass: ChangeClass;
  transition: AuthorityTransition;
  summary: string;
}

/** Binds one approved contract to one lineage and an explicit set of versions. */
export interface FinancialMandate {
  mandateId: string;
  principalId: string;
  lineageId: string;
  /** Explicit allow-list. Authority is never implied by lineage membership. */
  authorizedVersionIds: string[];
  fundingSourceId: string;
  scopes: string[];
  notBefore: string;
  expiresAt: string;
  /** Digest of the approved OutcomeContract this mandate authorizes. */
  outcomeContractDigest: string;
  /** Minimum version revocation epoch accepted at dispatch. */
  revocationEpoch: number;
  changePolicy: 'require_approval' | 'revoke_on_change';
  status: 'active' | 'paused_pending_approval' | 'revoked';
  approvedBy: string;
  approvedAt: string;
  pauseReason?: string;
}

/** A scoped runtime credential. The secret is returned once and stored hashed. */
export interface IssuedAgentCredential {
  credentialId: string;
  /** Returned once at issuance; never persisted in plaintext. */
  secret: string;
}

export interface AgentCredentialRecord {
  credentialId: string;
  lineageId: string;
  versionId: string;
  secretHash: string;
  issuedAt: string;
  expiresAt: string;
  /** Epoch at issuance; a later version revocation strands this credential. */
  issuedAtEpoch: number;
  revokedAt?: string;
}

/**
 * Brand carried by AuthenticatedAgent. Not exported, so no code outside
 * this module can produce a value of this type: an object literal with the
 * right fields fails to typecheck as AuthenticatedAgent, and a cast is
 * visible in review. This makes "authenticated" a claim only the registry
 * can make, rather than a shape any caller can assert.
 *
 * A type brand is a compile-time control, not a runtime one - a determined
 * caller can still cast. The runtime control is that every authority check
 * re-verifies the credential against stored state (see verifyCredential()),
 * so a fabricated object fails at the point of use regardless of its type.
 */
declare const authenticatedBrand: unique symbol;

/**
 * The authenticated caller. Produced only by SqliteAgentRegistry.authenticate(),
 * which verifies a credential secret against its stored hash.
 */
export interface AuthenticatedAgent {
  readonly [authenticatedBrand]: true;
  credentialId: string;
  lineageId: string;
  versionId: string;
  principalId: string;
}

/** The credential an agent presents. The secret is never stored in plaintext. */
export interface AgentCredentialPresentation {
  credentialId: string;
  secret: string;
}

export class AgentAuthorizationError extends Error {}
export class AgentAuthenticationError extends Error {}

/** Stable key ordering so a digest depends on content, not property order. */
export function canonicalManifest(manifest: AgentManifest): string {
  const tools = [...manifest.tools]
    .map(tool => ({ name: tool.name, version: tool.version, permissions: [...tool.permissions].sort() }))
    .sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  return JSON.stringify({
    codeArtifact: manifest.codeArtifact,
    instructionsDigest: manifest.instructionsDigest,
    model: manifest.model,
    modelIsMutableAlias: manifest.modelIsMutableAlias,
    policyDigest: manifest.policyDigest,
    tools,
  });
}

export function manifestDigest(manifest: AgentManifest): string {
  return createHash('sha256').update(canonicalManifest(manifest)).digest('hex');
}

export function issueSecret(): string {
  return `scrip_agent_${randomBytes(24).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time compare so credential checking cannot be timed. */
export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Diffs two manifests and classifies each change.
 *
 * The deliberate asymmetry: `codeArtifact` is classified `unknown_effect`,
 * never `display_only`. SPEC.md forbids treating a dependency or code
 * change as harmless on the strength of a version label, so a code change
 * requires review even when the operator believes it is a patch.
 */
export function classifyManifestChange(previous: AgentManifest, next: AgentManifest): ManifestChange[] {
  const changes: ManifestChange[] = [];
  if (previous.model !== next.model || previous.modelIsMutableAlias !== next.modelIsMutableAlias) {
    changes.push({
      field: 'model', changeClass: 'behavioral', transition: 'pause_pending_approval',
      summary: `Model changed from ${previous.model} to ${next.model}`,
    });
  }
  if (previous.instructionsDigest !== next.instructionsDigest) {
    changes.push({
      field: 'instructionsDigest', changeClass: 'behavioral', transition: 'pause_pending_approval',
      summary: 'System instructions changed',
    });
  }
  if (previous.policyDigest !== next.policyDigest) {
    changes.push({
      field: 'policyDigest', changeClass: 'behavioral', transition: 'pause_pending_approval',
      summary: 'Financial policy changed',
    });
  }
  if (previous.codeArtifact !== next.codeArtifact) {
    changes.push({
      field: 'codeArtifact', changeClass: 'unknown_effect', transition: 'require_review',
      summary: `Code artifact changed from ${previous.codeArtifact} to ${next.codeArtifact}; behavioral effect unknown`,
    });
  }
  const previousTools = new Map(previous.tools.map(tool => [tool.name, tool]));
  const nextTools = new Map(next.tools.map(tool => [tool.name, tool]));
  for (const [name, tool] of nextTools) {
    const before = previousTools.get(name);
    if (!before) {
      changes.push({
        field: `tools.${name}`, changeClass: 'expanded_permission', transition: 'pause_pending_approval',
        summary: `Agent gained a new tool: ${name}`,
      });
      continue;
    }
    const gained = tool.permissions.filter(permission => !before.permissions.includes(permission));
    if (gained.length) {
      changes.push({
        field: `tools.${name}.permissions`, changeClass: 'expanded_permission', transition: 'pause_pending_approval',
        summary: `Tool ${name} gained permission(s): ${gained.join(', ')}`,
      });
    } else if (before.version !== tool.version) {
      changes.push({
        field: `tools.${name}.version`, changeClass: 'unknown_effect', transition: 'require_review',
        summary: `Tool ${name} changed version ${before.version} to ${tool.version}; behavioral effect unknown`,
      });
    }
  }
  for (const name of previousTools.keys()) {
    if (!nextTools.has(name)) {
      changes.push({
        field: `tools.${name}`, changeClass: 'behavioral', transition: 'pause_pending_approval',
        summary: `Agent lost tool: ${name}`,
      });
    }
  }
  return changes;
}

const SEVERITY: Record<AuthorityTransition, number> = {
  retain: 0, require_review: 1, pause_pending_approval: 2, revoke: 3,
};

/** The strictest transition wins; an empty diff still retains, never grants. */
export function strictestTransition(changes: ManifestChange[]): AuthorityTransition {
  return changes.reduce<AuthorityTransition>(
    (worst, change) => (SEVERITY[change.transition] > SEVERITY[worst] ? change.transition : worst),
    'retain',
  );
}
