/**
 * Source check for flights an agent found on the web. Scrip opens the page
 * the agent cites and looks for the claimed total price and each flight
 * number. It flags, it does not block: many airline pages render in the
 * browser and cannot be read by a plain fetch, so "unreadable" is common and
 * says nothing about the agent.
 */
import type { FlightOffer } from '../flights/types.js';

export type SourceStatus = 'backed' | 'not_backed' | 'unreadable';
export interface SourceCheck {
  offerId: string;
  url: string;
  status: SourceStatus;
  priceShown: boolean;
  flightsShown: string[];
  flightsMissing: string[];
  detail: string;
}
export type FetchPage = (url: string) => Promise<{ status: number; text: string }>;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Page text with tags, scripts, and styles removed. */
export function pageText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

/** Which claimed facts appear in the page text. Price must appear as a dollar amount; "B6 615" also matches "B6615" or "B6-615". */
export function findClaims(text: string, offer: FlightOffer): { priceShown: boolean; flightsShown: string[]; flightsMissing: string[] } {
  const dollars = Math.floor(offer.totalCents / 100);
  const cents = offer.totalCents % 100;
  const whole = dollars.toLocaleString('en-US');
  const amount = `(?:${escapeRe(whole)}${whole.includes(',') ? `|${dollars}` : ''})`;
  const price = new RegExp(`\\$\\s?${amount}${cents ? `\\.${String(cents).padStart(2, '0')}` : '(?:\\.00)?'}(?![\\d])`);
  const flights = [...offer.outbound, ...offer.inbound].map(l => l.flight);
  const shown = flights.filter(f => {
    const m = /^([A-Z0-9]{2})\s*-?\s*(\d{1,4})$/i.exec(f.trim());
    const re = m ? new RegExp(`\\b${m[1]}\\s?-?${m[2]}\\b`, 'i') : new RegExp(escapeRe(f), 'i');
    return re.test(text);
  });
  return { priceShown: price.test(text), flightsShown: shown, flightsMissing: flights.filter(f => !shown.includes(f)) };
}

/** Only public https pages; never the local machine or private networks. */
function allowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname) && !u.hostname.endsWith('.local');
  } catch { return false; }
}

export const fetchPublicPage: FetchPage = async url => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (Scrip source check)' } });
  return { status: res.status, text: (await res.text()).slice(0, 2_000_000) };
};

export async function checkSource(offer: FlightOffer, url: string, fetchPage: FetchPage): Promise<SourceCheck> {
  const base = { offerId: offer.offerId, url };
  const unreadable = (detail: string): SourceCheck => ({ ...base, status: 'unreadable', priceShown: false, flightsShown: [], flightsMissing: [], detail });
  if (!allowed(url)) return unreadable('not a public https page');
  let page: { status: number; text: string };
  try { page = await fetchPage(url); } catch (error) { return unreadable(`could not open the page (${(error as Error).message})`); }
  if (page.status >= 400) return unreadable(`the site refused (HTTP ${page.status})`);
  const text = pageText(page.text);
  if (text.trim().length < 200) return unreadable('the page has no readable text (it loads in the browser)');
  const found = findClaims(text, offer);
  const backed = found.priceShown && found.flightsMissing.length === 0;
  const missing = [...(found.priceShown ? [] : [`price $${(offer.totalCents / 100).toFixed(2)}`]), ...found.flightsMissing];
  return { ...base, status: backed ? 'backed' : 'not_backed', ...found, detail: backed ? 'price and every flight number appear on the page' : `not on the page: ${missing.join(', ')}` };
}
