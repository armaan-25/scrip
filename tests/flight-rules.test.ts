import { describe, expect, it } from 'vitest';
import { confirmedRequirements, layoverOffer, nonstopOffer } from '../src/flights/fixtures.js';
import { checkOffer, diffRequirements, stops } from '../src/flights/rules.js';

describe('checkOffer', () => {
  it('accepts the nonstop refundable offer under budget', () => {
    expect(checkOffer(confirmedRequirements, nonstopOffer)).toEqual([]);
  });

  it('rejects the layover offer for stops and refundability', () => {
    expect(stops(layoverOffer)).toBe(1);
    expect(checkOffer(confirmedRequirements, layoverOffer).map(v => v.rule)).toEqual(['directOnly', 'refundableOnly']);
  });

  it('rejects an offer over budget', () => {
    const pricey = { ...nonstopOffer, totalCents: 60001 };
    expect(checkOffer(confirmedRequirements, pricey).map(v => v.rule)).toEqual(['maxTotalCents']);
  });

  it('rejects the wrong departure date', () => {
    const early = { ...nonstopOffer, outbound: [{ ...nonstopOffer.outbound[0], departAt: '2026-10-15T07:00:00-04:00' }] };
    expect(checkOffer(confirmedRequirements, early).map(v => v.rule)).toEqual(['departOn']);
  });
});

describe('diffRequirements', () => {
  it('finds nothing when the agent understood correctly', () => {
    expect(diffRequirements(confirmedRequirements, { ...confirmedRequirements })).toEqual([]);
  });

  it('names each requirement the agent changed', () => {
    const misread = { ...confirmedRequirements, directOnly: false, refundableOnly: false };
    expect(diffRequirements(confirmedRequirements, misread)).toEqual([
      { field: 'directOnly', confirmed: true, interpreted: false },
      { field: 'refundableOnly', confirmed: true, interpreted: false },
    ]);
  });
});
