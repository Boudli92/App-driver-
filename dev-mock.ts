import type { PaymentProvider, CreatePaymentRequest, CreatePaymentResult, PaymentStatus, VerifiedWebhookEvent } from "../domain/payments/payments.ts";
import type { Minor } from "../domain/money/money.ts";
import { StripeProvider } from "./stripe.ts";
import { newId } from "../lib/security.ts";

/**
 * Simulateur de PSP pour le DÉVELOPPEMENT uniquement (refusé en production).
 * Il émet de vrais webhooks signés au format Stripe vers notre propre endpoint,
 * ce qui permet de tester toute la chaîne sans compte PSP.
 */
export const DEV_WEBHOOK_SECRET = "whsec_dev_mock_only";

export class DevMockProvider implements PaymentProvider {
  readonly name = "stripe"; // même format de webhook que Stripe
  private readonly appUrl: string;
  private readonly verifier = new StripeProvider("sk_dev_mock", DEV_WEBHOOK_SECRET, ["card", "twint"]);
  constructor(appUrl: string) { this.appUrl = appUrl; }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const ref = `cs_dev_${newId()}`;
    return { providerPaymentId: ref, redirectUrl: `${this.appUrl}/dev/mock-checkout/${ref}` };
  }
  async authorizePayment(): Promise<PaymentStatus> { return "PENDING"; }
  async capturePayment(): Promise<PaymentStatus> { return "PENDING"; }
  async refundPayment(_ref: string, _amount: Minor): Promise<{ providerRefundId: string }> { return { providerRefundId: `re_dev_${newId()}` }; }
  async getPaymentStatus(): Promise<PaymentStatus> { return "PENDING"; }
  handleWebhook(rawBody: string, headers: Record<string, string>): Promise<VerifiedWebhookEvent> {
    return this.verifier.handleWebhook(rawBody, headers);
  }
}
