import { createHash, randomUUID } from 'node:crypto';
import type { ScripConfig } from '../config.js';
import { TaskAuthorizationManager } from '../lease.js';
import type { FinanceGateway } from '../store.js';
import {
  AgentAuthorizationError, type AgentCredentialPresentation, type AuthenticatedAgent,
} from './agent-identity.js';
import type { SqliteAgentRegistry } from './agent-registry.js';
import { SqliteMissionStore } from './mission-store.js';
import {
  assessOutcome, bookingEvidenceSchema, canonical, contractSchema, paymentSchema, paymentTotals, preflight, renderContract,
} from './outcome-assessor.js';
import type {
  BookingEvidence, ConsumerApproval, ContractInput, ExecutionProvider, HotelBooking, MissionEventInput,
  MissionReceipt, OutcomeAssessment, OutcomeContract, PaymentCapabilityProvider, PaymentFact, PurchaseMission, RecoveryAction,
} from './types.js';

export class PurchaseMissionService {
  constructor(
    private store: SqliteMissionStore,
    private config: ScripConfig,
    private budget: string,
    private execution: ExecutionProvider,
    private payments: PaymentCapabilityProvider,
    private now: () => Date = () => new Date(),
    /**
     * Optional so missions approved without an agent binding (the hotel
     * regression fixtures) keep working. When a contract carries agent
     * binding in its approval evidence, execute() requires this registry
     * and an authenticated agent.
     */
    private registry?: SqliteAgentRegistry,
  ) {}

  /**
   * Authority gate, evaluated twice per operation: once before any
   * reservation, and again immediately before external dispatch. The
   * second check is what catches a revocation that races an in-flight
   * operation - once the provider has been called, revocation can no
   * longer retract it, so reconcile() settles it under the original
   * version rather than pretending it did not happen.
   */
  private checkAuthority(
    missionId: string, contract: OutcomeContract, agent: AuthenticatedAgent | undefined,
    stage: 'pre_reservation' | 'pre_dispatch',
  ): void {
    const evidence = contract.approvalEvidence;
    if (!evidence?.financialMandateId) return;
    if (!this.registry) throw new AgentAuthorizationError('Agent-bound mission requires an agent registry');
    if (!agent) throw new AgentAuthorizationError('Agent-bound mission requires an authenticated agent');
    if (agent.lineageId !== evidence.agentLineageId) {
      throw new AgentAuthorizationError('Authenticated agent lineage does not match the approved mandate');
    }
    const decision = this.registry.authorize(
      agent, evidence.financialMandateId, renderContract(contract).hash, this.now(),
      // Every spending path names its operation, so a mandate scoped to
      // e.g. refunds cannot be used to purchase.
      { operation: 'purchase', fundingSourceId: contract.fundingSourceId },
    );
    if (!decision.allowed) {
      // Not appended here: this runs inside the mission transaction, and
      // throwing rolls it back, which would discard the very record an
      // auditor needs. recordAuthorityRefusal() writes it afterwards.
      throw new AgentAuthorizationError(decision.reasons.join('; '));
    }
    this.append(missionId, {
      type: 'agent_authority_checked', source: 'scrip',
      data: {
        stage, mandateId: evidence.financialMandateId, agentVersionId: agent.versionId,
        allowed: true, reasons: [],
      },
    });
  }

  /** Durably records a refused attempt after its transaction has rolled back. */
  private async recordAuthorityRefusal(
    missionId: string, contract: OutcomeContract, agent: AuthenticatedAgent | undefined,
    stage: 'pre_reservation' | 'pre_dispatch', reasons: string[],
  ): Promise<void> {
    const mandateId = contract.approvalEvidence?.financialMandateId;
    if (!mandateId || !agent) return;
    await this.store.transaction(() => {
      this.append(missionId, {
        type: 'agent_authority_refused', source: 'scrip',
        data: { stage, mandateId, agentVersionId: agent.versionId, reasons },
      });
    });
  }

  /**
   * Turns a presented credential into an AuthenticatedAgent, or throws.
   * Returns undefined only when the mission carries no agent binding.
   */
  private authenticate(
    contract: OutcomeContract, credential: AgentCredentialPresentation | undefined,
  ): AuthenticatedAgent | undefined {
    if (!contract.approvalEvidence?.financialMandateId) return undefined;
    if (!this.registry) throw new AgentAuthorizationError('Agent-bound mission requires an agent registry');
    if (!credential) throw new AgentAuthorizationError('Agent-bound mission requires an agent credential');
    return this.registry.authenticate(credential.credentialId, credential.secret, this.now());
  }

  private manager(): TaskAuthorizationManager {
    const gateway: FinanceGateway = {
      getReportedSpend: async budgetId => this.store.reportedSpend(budgetId),
      reportTaskUsage: async receipt => { this.store.saveTaskReceipt(receipt); },
    };
    return new TaskAuthorizationManager(this.config, gateway, this.store.leaseStateStore());
  }

  get(consumerId: string, missionId: string): PurchaseMission {
    const mission = this.store.get(missionId);
    if (mission.consumerId !== consumerId) throw new Error('Mission does not belong to this consumer');
    return mission;
  }

  private append(missionId: string, event: MissionEventInput): boolean {
    return this.store.append(missionId, event, this.store.events(missionId).length, this.now());
  }

  async create(consumerId: string, input: ContractInput): Promise<PurchaseMission> {
    if (!consumerId.trim()) throw new Error('Consumer identity required');
    const contract = { ...contractSchema.parse(input), version: 1 } as OutcomeContract;
    const missionId = randomUUID();
    return this.store.transaction(() => {
      this.append(missionId, { type: 'contract_created', source: 'consumer', data: { consumerId, contract } });
      return this.get(consumerId, missionId);
    });
  }

  async revise(consumerId: string, missionId: string, expectedVersion: number, input: ContractInput): Promise<PurchaseMission> {
    const terms = contractSchema.parse(input);
    return this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      if (mission.revoked || mission.operation) throw new Error('A started or revoked purchase requires a separate mission');
      if (mission.contract.version !== expectedVersion) throw new Error('Contract version changed');
      this.append(missionId, {
        type: 'contract_revised', source: 'consumer', data: { contract: { ...terms, version: expectedVersion + 1 } as OutcomeContract },
      });
      return this.get(consumerId, missionId);
    });
  }

  renderApproval(consumerId: string, missionId: string) {
    const mission = this.get(consumerId, missionId);
    return { ...renderContract(mission.contract), contractVersion: mission.contract.version };
  }

  async approve(
    consumerId: string, missionId: string, approval: ConsumerApproval,
    /**
     * Binds this approval to an agent lineage, an explicitly authorized
     * version, and a mandate. Omitted for missions with no agent binding.
     */
    binding?: { agentLineageId: string; authorizedAgentVersionId: string; financialMandateId: string },
  ): Promise<PurchaseMission> {
    return this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      if (mission.revoked || mission.operation) throw new Error('Mission can no longer be approved');
      if (approval.channel !== 'web' && approval.channel !== 'mobile') throw new Error('Invalid approval channel');
      if (approval.contractVersion !== mission.contract.version || approval.renderedSummaryHash !== renderContract(mission.contract).hash) {
        throw new Error('Approval must bind the exact contract version and rendered summary hash');
      }
      const reasons = preflight(mission.contract, mission.contract.purchase, this.now());
      if (reasons.length) throw new Error(reasons.join('; '));
      if (!mission.contract.approvalEvidence) this.append(missionId, {
        type: 'consumer_approved', source: 'consumer', data: {
          contractVersion: approval.contractVersion, renderedSummaryHash: approval.renderedSummaryHash,
          channel: approval.channel, networkMandateRef: approval.networkMandateRef,
          approvedBy: consumerId, approvedAt: this.now().toISOString(),
          ...(binding ?? {}),
        },
      });
      return this.get(consumerId, missionId);
    });
  }

  evaluatePreflight(consumerId: string, missionId: string, candidate: HotelBooking): string[] {
    const mission = this.get(consumerId, missionId);
    return [
      ...(!mission.contract.approvalEvidence ? ['Consumer approval required'] : []),
      ...(mission.revoked ? ['Mission revoked'] : []),
      ...preflight(mission.contract, candidate, this.now()),
    ];
  }

  /**
   * @param credential The agent's scoped credential. The service
   * authenticates it here rather than accepting a caller-constructed
   * identity: a credential id, manifest digest, or agent object supplied by
   * the caller is an unauthenticated claim, so only a verified secret can
   * establish who is acting. Omit for missions with no agent binding.
   */
  async execute(
    consumerId: string, missionId: string, candidate: HotelBooking,
    credential?: AgentCredentialPresentation,
  ): Promise<PurchaseMission> {
    const booking = structuredClone(candidate);
    const contractBefore = this.get(consumerId, missionId).contract;
    const agent = this.authenticate(contractBefore, credential);
    const prepared = await this.store.transaction(async () => {
      const mission = this.get(consumerId, missionId);
      if (mission.operation) {
        if (canonical(booking) !== canonical(mission.contract.purchase)) throw new Error('Purchase differs from original operation');
        return { mission, fresh: false };
      }
      const reasons = this.evaluatePreflight(consumerId, missionId, booking);
      if (reasons.length) throw new Error(reasons.join('; '));
      this.checkAuthority(missionId, mission.contract, agent, 'pre_reservation');
      const key = createHash('sha256').update(canonical([consumerId, missionId, mission.contract.version, 'purchase'])).digest('hex');
      if (!this.store.claimOperation(key, missionId, mission.contract.version, 'purchase')) throw new Error('Operation requires reconciliation');
      const manager = this.manager();
      const root = await manager.authorizeTask({
        budget: this.budget, taskId: missionId, task: mission.contract.goal, allowance: mission.contract.maximumTotal,
        ttlMs: Date.parse(mission.contract.expiresAt) - Date.now(),
      });
      const reservation = manager.reserveAction(root.credential, 'purchase', booking.hotelName, mission.contract.maximumTotal, { operationKey: key });
      this.append(missionId, {
        type: 'execution_started', source: 'scrip', data: {
          key, contractVersion: mission.contract.version, reservationId: reservation.reservationId,
          authorizationId: root.authorization.authorizationId, maximumCost: reservation.maximumCost,
          agentVersionId: agent?.versionId, financialMandateId: mission.contract.approvalEvidence?.financialMandateId,
        },
      });
      return { mission: this.get(consumerId, missionId), fresh: true };
    }).catch(async (error: unknown) => {
      if (error instanceof AgentAuthorizationError) {
        await this.recordAuthorityRefusal(missionId, contractBefore, agent, 'pre_reservation', [error.message]);
      }
      throw error;
    });
    const mission = prepared.mission;
    const operationKey = mission.operation!.key;
    if (!prepared.fresh) return this.reconcile(consumerId, missionId);
    const request = {
      operationKey, consumerId, missionId, booking, maximumCost: mission.contract.maximumTotal,
      expiresAt: mission.contract.expiresAt, singleUse: true as const,
    };
    try {
      const capability = await this.payments.issue(request);
      const mayExecute = await this.store.transaction(() => {
        this.append(missionId, { type: 'credential_issued', source: 'payment_provider', data: capability });
        const current = this.get(consumerId, missionId);
        if (current.revoked || Date.parse(current.contract.expiresAt) <= this.now().getTime()) return false;
        // Re-check authority immediately before external dispatch: a
        // revocation may have landed while the payment provider was
        // issuing the capability.
        try {
          this.checkAuthority(missionId, current.contract, agent, 'pre_dispatch');
        } catch (error) {
          return error instanceof AgentAuthorizationError ? { refused: error.message } : false;
        }
        return true;
      });
      if (mayExecute !== true) {
        if (typeof mayExecute === 'object') {
          await this.recordAuthorityRefusal(
            missionId, this.get(consumerId, missionId).contract, agent, 'pre_dispatch', [mayExecute.refused],
          );
        }
        await this.stopAuthority(consumerId, missionId);
        return this.reconcile(consumerId, missionId);
      }
      const result = await this.execution.start({ ...request, capabilityRef: capability.capabilityRef });
      await this.store.transaction(() => {
        this.append(missionId, { type: 'execution_observed', source: 'execution_provider', data: result });
      });
    } catch {
      await this.store.transaction(() => {
        this.append(missionId, { type: 'operation_pending', source: 'scrip', data: { reason: 'Provider result unknown; reconcile original operation' } });
      });
    }
    return this.reconcile(consumerId, missionId);
  }

  async reconcile(consumerId: string, missionId: string): Promise<PurchaseMission> {
    const mission = this.get(consumerId, missionId);
    if (!mission.operation) return mission;
    const results = await Promise.allSettled([
      this.payments.getFacts(mission.operation.key), this.execution.getEvidence(mission.operation.key),
    ]);
    if (results[0].status === 'fulfilled') {
      const facts = [...results[0].value].sort((a, b) => Number(b.kind === 'captured') - Number(a.kind === 'captured'));
      for (const fact of facts) await this.recordPaymentFact(consumerId, missionId, fact);
    }
    if (results[1].status === 'fulfilled') {
      for (const evidence of results[1].value) await this.recordBookingEvidence(consumerId, missionId, evidence);
    }
    await this.verify(consumerId, missionId);
    if (this.get(consumerId, missionId).revoked) await this.stopAuthority(consumerId, missionId);
    return this.get(consumerId, missionId);
  }

  async recordPaymentFact(consumerId: string, missionId: string, input: PaymentFact): Promise<void> {
    const fact = paymentSchema.parse(input);
    await this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      if (!mission.operation || fact.operationKey !== mission.operation.key) throw new Error('Payment belongs to another operation');
      const events = this.store.events(missionId);
      const old = events.filter(event => event.type === 'payment_observed').map(event => event.data);
      const same = old.find(item => item.externalId === fact.externalId);
      if (same) {
        if (canonical(same) !== canonical(fact)) throw new Error('Conflicting payment event');
        return;
      }
      if (fact.merchant !== mission.contract.purchase.merchant || fact.amount > mission.operation.maximumCost) {
        throw new Error('Payment scope or ceiling violation; preserve reservation for review');
      }
      const capture = old.find(item => item.kind === 'captured');
      const unpaid = old.some(item => item.kind === 'unpaid');
      if (fact.kind === 'captured' && (capture || unpaid)) throw new Error('Conflicting terminal payment facts');
      if (fact.kind === 'unpaid' && (capture || fact.amount !== 0)) throw new Error('Unpaid fact contradicts capture');
      if (['refunded', 'reversed', 'refund_acknowledged'].includes(fact.kind)) {
        const totals = paymentTotals(events);
        if (!capture || capture.transactionRef !== fact.transactionRef) throw new Error('Recovery must reference the captured transaction');
        if (fact.kind !== 'refund_acknowledged' && fact.amount > totals.netSpend) throw new Error('Recovery exceeds captured balance');
      }
      if (!this.append(missionId, { type: 'payment_observed', source: 'payment_provider', externalId: fact.externalId, data: fact })) return;
      const manager = this.manager();
      if (fact.kind === 'captured') manager.commitAction(mission.operation.reservationId, fact.amount);
      if (fact.kind === 'unpaid' && !unpaid) manager.cancelAction(mission.operation.reservationId);
    });
  }

  async recordBookingEvidence(consumerId: string, missionId: string, input: BookingEvidence): Promise<void> {
    const evidence = bookingEvidenceSchema.parse(input);
    await this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      if (!mission.operation || evidence.operationKey !== mission.operation.key) throw new Error('Booking belongs to another operation');
      this.append(missionId, { type: 'booking_observed', source: evidence.source, externalId: evidence.externalId, data: evidence });
    });
  }

  async verify(consumerId: string, missionId: string): Promise<OutcomeAssessment> {
    const assessment = await this.store.transaction<OutcomeAssessment>(async () => {
      const mission = this.get(consumerId, missionId);
      if (!mission.operation) return { status: 'pending', reasons: ['Purchase has not started'] };
      const events = this.store.events(missionId);
      const assessment = assessOutcome(mission.contract, events);
      const last = events.filter(event => event.type === 'outcome_assessed').at(-1);
      if (!last || canonical(last.data) !== canonical(assessment)) this.append(missionId, { type: 'outcome_assessed', source: 'scrip', data: assessment });
      const manager = this.manager();
      const auth = manager.getAuthorization(mission.authorizationId!);
      if (auth.status === 'active' && auth.pending === 0 && assessment.status !== 'pending' && assessment.status !== 'unknown') {
        const receipt = await manager.settleTask(auth.authorizationId, {
          status: assessment.status, evidence: assessment.reasons.join('; '),
          evidenceDetail: events.filter(event => event.type === 'booking_observed').map(event => event.data),
        });
        this.append(missionId, { type: 'task_settled', source: 'scrip', data: receipt });
      }
      return assessment;
    });
    if (assessment.status === 'unknown') await this.stopAuthority(consumerId, missionId);
    return assessment;
  }

  async requestRecovery(consumerId: string, missionId: string, action: RecoveryAction): Promise<PurchaseMission> {
    if (action === 'dispute') throw new Error('A dispute requires fresh consumer confirmation of exact facts; submission is not implemented');
    if (action !== 'cancel' && action !== 'refund') throw new Error('Replacement and rebooking are not supported in the hotel slice');
    const prepared = await this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      const policy = mission.contract.recoveryPolicy;
      if (!mission.operation) throw new Error('No purchase to recover');
      if (action === 'cancel' ? !policy.allowMerchantCancellation : !policy.allowMerchantRefundRequest) throw new Error('Recovery action not permitted');
      if (policy.recoveryDeadline && Date.parse(policy.recoveryDeadline) <= this.now().getTime()) throw new Error('Recovery deadline passed');
      if (action === 'cancel' && Date.parse(mission.contract.purchase.refundableUntil) <= this.now().getTime()) throw new Error('Free cancellation window passed');
      if (paymentTotals(this.store.events(missionId)).netSpend <= 0) throw new Error('No captured balance to recover');
      const key = `${mission.operation.key}:${action}`;
      const fresh = this.store.claimOperation(key, missionId, mission.contract.version, action);
      if (fresh) this.append(missionId, { type: 'recovery_requested', source: 'consumer', data: { action, key } });
      return { key, operationKey: mission.operation.key, fresh };
    });
    if (prepared.fresh) {
      try {
        const acknowledgment = await this.payments.requestRecovery({ operationKey: prepared.operationKey, recoveryKey: prepared.key, action });
        await this.store.transaction(() => {
          this.append(missionId, { type: 'refund_pending', source: 'merchant', externalId: acknowledgment.externalId, data: { ...acknowledgment, key: prepared.key } });
        });
      } catch {
        // The durable recovery request remains unresolved; a retry only polls facts.
      }
    }
    return this.reconcile(consumerId, missionId);
  }

  async cancel(consumerId: string, missionId: string): Promise<PurchaseMission> {
    await this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      if (!mission.revoked) this.append(missionId, { type: 'mission_revoked', source: 'consumer', data: {} });
      if (mission.authorizationId) {
        const manager = this.manager();
        if (manager.getAuthorization(mission.authorizationId).status === 'active') {
          manager.revokeTask(mission.authorizationId, { preservePending: true });
        }
      }
    });
    await this.stopAuthority(consumerId, missionId);
    return this.get(consumerId, missionId);
  }

  private async stopAuthority(consumerId: string, missionId: string): Promise<void> {
    const mission = this.get(consumerId, missionId);
    if (!mission.operation) return;
    const stopped = await Promise.allSettled([this.execution.stop(mission.operation.key), this.payments.revoke(mission.operation.key)]);
    if (stopped.some(result => result.status === 'rejected')) throw new Error('Local authority revoked; provider stop requires reconciliation');
    await this.store.transaction(() => {
      this.append(missionId, { type: 'authority_stopped', source: 'scrip', data: {} });
    });
  }

  async getReceipt(consumerId: string, missionId: string): Promise<MissionReceipt> {
    return this.store.transaction(() => {
      const mission = this.get(consumerId, missionId);
      const events = this.store.events(missionId);
      const totals = paymentTotals(events);
      const auth = mission.authorizationId ? this.manager().getAuthorization(mission.authorizationId) : undefined;
      const authorized = mission.contract.approvalEvidence ? mission.contract.maximumTotal : 0;
      const reserved = auth?.pending ?? 0;
      const returned = mission.revoked || (auth && auth.status !== 'active')
        ? Math.round((authorized - reserved - totals.captured) * 100) / 100 : 0;
      const assessment = events.filter(event => event.type === 'outcome_assessed').at(-1)?.data;
      const evidence = mission.contract.approvalEvidence;
      // Attestation level is reported so a reader knows how much the
      // recorded version is worth: 'self_declared' means the operator
      // stated the manifest and nothing verified the running software.
      const actingVersion = evidence?.authorizedAgentVersionId && this.registry
        ? this.registry.getVersion(evidence.authorizedAgentVersionId) : undefined;
      return {
        mission, events, assessment, taskReceipt: mission.authorizationId ? this.store.getTaskReceipt(mission.authorizationId) : undefined,
        agentLineageId: evidence?.agentLineageId,
        agentVersionId: mission.operation?.agentVersionId ?? evidence?.authorizedAgentVersionId,
        financialMandateId: evidence?.financialMandateId,
        agentAttestationLevel: actingVersion?.attestationLevel,
        authorized, reserved, ...totals, returned,
        unrecovered: assessment?.status === 'failure' || events.some(event => event.type === 'recovery_requested'
          || (event.type === 'payment_observed' && ['refund_acknowledged', 'refunded', 'reversed'].includes(event.data.kind)))
          || mission.revoked ? totals.netSpend : 0,
        refundPending: totals.netSpend > 0 && events.some(event => event.type === 'refund_pending'
          || (event.type === 'payment_observed' && event.data.kind === 'refund_acknowledged')),
      };
    });
  }
}
