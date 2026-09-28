/** A round trip in the person's own terms. Money is integer cents. */
export interface FlightRequirements {
  from: string;
  to: string;
  departOn: string; // YYYY-MM-DD, local date at the departure airport
  returnOn: string;
  directOnly: boolean;
  refundableOnly: boolean;
  maxTotalCents: number;
}

export interface FlightLeg {
  flight: string;
  from: string;
  to: string;
  departAt: string; // ISO 8601 with the airport's local offset
  arriveAt: string;
}

/** One bookable round trip as a seller quotes it. */
export interface FlightOffer {
  offerId: string;
  carrier: string;
  outbound: FlightLeg[];
  inbound: FlightLeg[];
  refundable: boolean;
  totalCents: number;
  currency: 'USD';
}
