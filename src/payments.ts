/**
 * Payment abstraction.
 *
 * MCP has no payment primitive (yet — agentic-commerce work like Stripe's
 * agent toolkit and the x402 proposal are moving here), so the practical
 * pattern today is:
 *
 *   1. The customer pays out-of-band (a Stripe Checkout link, an in-host
 *      purchase, an invoice…).
 *   2. The payment webhook records an *entitlement* keyed to the customer's
 *      identity — for us, the verified `sub`/`email` from their Google
 *      bearer token.
 *   3. Every MCP tool call checks entitlements for the authenticated caller.
 *
 * Step 3 is the part this example implements for real. Steps 1–2 sit behind
 * this interface: the mock provider below auto-approves so the whole flow is
 * runnable, and a production `StripePaymentProvider` would create a real
 * PaymentIntent/Checkout Session in `charge()` instead.
 */
import { randomUUID } from 'node:crypto';
import type { Product } from './products.js';

export interface ChargeRequest {
  customerSubject: string;
  customerEmail?: string;
  product: Product;
}

export interface ChargeResult {
  /** Provider-side receipt/charge identifier (e.g. a Stripe PaymentIntent id). */
  receiptId: string;
  status: 'succeeded' | 'declined';
  /** Human-readable note shown back to the customer. */
  detail: string;
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/** Auto-approving stand-in so the example is runnable without payment keys. */
export class MockPaymentProvider implements PaymentProvider {
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    return {
      receiptId: `mock_rcpt_${randomUUID()}`,
      status: 'succeeded',
      detail:
        `Simulated charge of $${request.product.priceUsd} for "${request.product.name}" ` +
        `to ${request.customerEmail ?? request.customerSubject}. ` +
        'Swap MockPaymentProvider for a real provider (e.g. Stripe) in production.'
    };
  }
}
