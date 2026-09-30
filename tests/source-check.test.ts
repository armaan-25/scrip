import { describe, expect, it } from 'vitest';
import { checkSource, findClaims } from '../src/agent/source-check.js';
import type { FlightOffer } from '../src/flights/types.js';

const offer: FlightOffer = {
  offerId: 'web-1', carrier: 'JetBlue', refundable: false, totalCents: 55300, currency: 'USD',
  outbound: [{ flight: 'B6 615', from: 'JFK', to: 'SFO', departAt: '2026-10-16T17:59', arriveAt: '2026-10-16T21:26' }],
  inbound: [{ flight: 'B6 416', from: 'SFO', to: 'JFK', departAt: '2026-10-18T08:15', arriveAt: '2026-10-18T16:49' }],
};
const filler = 'Flights from New York to San Francisco. '.repeat(10);
const page = (body: string, status = 200) => async () => ({ status, text: `<html><script>var x = "$553 B6 615";</script><body>${filler}${body}</body></html>` });

describe('source check', () => {
  it('finds the price as a dollar amount and flight numbers in their common spellings', () => {
    expect(findClaims('Total $553 on B6615 and B6-416', offer)).toEqual({ priceShown: true, flightsShown: ['B6 615', 'B6 416'], flightsMissing: [] });
    expect(findClaims('553 points, $5530, B6 61', offer)).toEqual({ priceShown: false, flightsShown: [], flightsMissing: ['B6 615', 'B6 416'] });
  });

  it('says a claim is backed only when the price and every flight appear in the visible page', async () => {
    expect((await checkSource(offer, 'https://example.com/f', page('B6 615 / B6 416, $553 round trip'))).status).toBe('backed');
    const stitched = await checkSource(offer, 'https://example.com/f', page('Lowest fares: Oct 16 $234, Oct 18 $319'));
    expect(stitched.status).toBe('not_backed'); // script contents do not count as visible text
    expect(stitched.detail).toBe('not on the page: price $553.00, B6 615, B6 416');
  });

  it('marks pages it cannot read, and never opens local or non-https addresses', async () => {
    expect((await checkSource(offer, 'https://example.com/f', page('', 403))).detail).toMatch(/HTTP 403/);
    expect((await checkSource(offer, 'https://example.com/f', async () => ({ status: 200, text: '<div id="app"></div>' }))).detail).toMatch(/no readable text/);
    let opened = false;
    const spy = async () => { opened = true; return { status: 200, text: '' }; };
    for (const url of ['http://example.com', 'https://localhost:8799/mcp', 'https://192.168.1.1/', 'file:///etc/passwd']) {
      expect((await checkSource(offer, url, spy)).status).toBe('unreadable');
    }
    expect(opened).toBe(false);
  });
});
