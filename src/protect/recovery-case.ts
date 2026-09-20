/**
 * A recovery case: the person (or Scrip's own mismatch detection) says
 * "this is not what I approved." Opening a case does exactly two things:
 * it assembles the evidence into one packet from facts already on the
 * mission's ledger, and, only where the approved recovery policy permits
 * it, asks the merchant for a refund through the existing
 * requestRecovery() path. It does not decide fault, does not file a
 * network dispute, and does not mark money as returned - only provider
 * evidence of a posted refund does that.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteMissionStore } from '../missions/mission-store.js';
import { canonical, renderContract } from '../missions/outcome-assessor.js';
import type { PurchaseMissionService } from '../missions/purchase-mission-service.js';
import type { BookingEvidence, MissionReceipt, OutcomeAssessment, PaymentFact } from '../missions/types.js';
import { purchaseDigest } from '../cards/card-gate.js';

export interface EvidencePacket {
  missionId: string;
  contractVersion: number;
  /** Fingerprint of the exact approved purchase; the one the card was bound to. */
  purchaseDigest: string;
  /** Fingerprint of the whole approved contract, as the person signed it. */
  approvedContractHash: string;
  agentLineageId?: string;
  agentVersionId?: string;
  agentAttestationLevel?: string;
  assessment?: OutcomeAssessment;
  payments: PaymentFact[];
  fulfillment: BookingEvidence[];
  /** Which fulfillment records disagree with the approved purchase, and how. */
  mismatches: { externalId: string; source: string; fields: string[] }[];
  money: { captured: number; refunded: number; reversed: number; unrecovered: number; refundPending: boolean };
  openedBy: 'consumer' | 'detector';
  openedAt: string;
  packetDigest: string;
}

export function buildEvidencePacket(receipt: MissionReceipt, openedBy: 'consumer' | 'detector', openedAt: string): EvidencePacket {
  const contract = receipt.mission.contract;
  const payments = receipt.events.filter(e => e.type === 'payment_observed').map(e => e.data);
  const fulfillment = receipt.events.filter(e => e.type === 'booking_observed').map(e => e.data);
  const approved = contract.purchase;
  const mismatches = fulfillment.flatMap(evidence => {
    const fields: string[] = (Object.keys(approved) as (keyof typeof approved)[])
      .filter(k => canonical(evidence.booking[k]) !== canonical(approved[k]));
    if (evidence.status !== 'confirmed') fields.unshift(`status:${evidence.status}`);
    return fields.length ? [{ externalId: evidence.externalId, source: evidence.source, fields }] : [];
  });
  const body = {
    missionId: receipt.mission.missionId, contractVersion: contract.version,
    purchaseDigest: purchaseDigest(approved), approvedContractHash: renderContract(contract).hash,
    agentLineageId: receipt.agentLineageId, agentVersionId: receipt.agentVersionId, agentAttestationLevel: receipt.agentAttestationLevel,
    assessment: receipt.assessment, payments, fulfillment, mismatches,
    money: { captured: receipt.captured, refunded: receipt.refunded, reversed: receipt.reversed, unrecovered: receipt.unrecovered, refundPending: receipt.refundPending },
    openedBy, openedAt,
  };
  return { ...body, packetDigest: createHash('sha256').update(canonical(body)).digest('hex') };
}

export interface RecoveryCase { caseId: string; packet: EvidencePacket; refundRequested: boolean; refundRefused?: string }

export async function openRecoveryCase(
  deps: { service: PurchaseMissionService; store: SqliteMissionStore; now: () => Date },
  consumerId: string, missionId: string, openedBy: 'consumer' | 'detector',
): Promise<RecoveryCase> {
  const receipt = await deps.service.getReceipt(consumerId, missionId);
  if (!receipt.mission.operation) throw new Error('No purchase to recover');
  const packet = buildEvidencePacket(receipt, openedBy, deps.now().toISOString());
  const caseId = randomUUID();
  let refundRequested = false;
  let refundRefused: string | undefined;
  // Ask the merchant only if the person's approved policy allows it and
  // there is captured money to ask for. requestRecovery() enforces both.
  if (receipt.mission.contract.recoveryPolicy.allowMerchantRefundRequest && receipt.unrecovered > 0) {
    try { await deps.service.requestRecovery(consumerId, missionId, 'refund'); refundRequested = true; }
    catch (error) { refundRefused = (error as Error).message; }
  }
  await deps.store.transaction(() => {
    deps.store.append(missionId, {
      type: 'recovery_case_opened', source: openedBy === 'consumer' ? 'consumer' : 'scrip',
      data: { caseId, openedBy, packetDigest: packet.packetDigest, refundRequested },
    }, deps.store.events(missionId).length, deps.now());
  });
  return { caseId, packet, refundRequested, refundRefused };
}
