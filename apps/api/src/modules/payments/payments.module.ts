import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { CallbackIntake } from "./callback-intake.js";
import { PaymentOutcomeHandlers } from "./outcome-handlers.js";
import { PaymentAccounts } from "./payment-accounts.js";
import { PaymentCommands } from "./payment-commands.js";
import { PaymentLedger } from "./payment-ledger.js";
import { PaymentProcessor } from "./payment-processor.js";
import { PaymentCallbacksController, PaymentsController } from "./payments.controller.js";
import { PaymentsCrypto } from "./payments-crypto.js";
import { PaymentsRelay } from "./payments-relay.js";
import { PaymentsRuntime } from "./payments-runtime.js";
import { DarajaProvider } from "./provider/daraja-provider.js";
import { PAYMENT_PROVIDER } from "./provider/payment-provider.js";
import { CertificateStore } from "./provider/security-credential.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { PaymentRequestsService } from "./requests.service.js";
import { PaymentSettingsService } from "./settings.service.js";

/**
 * Payments and the Daraja integration (D4.2, ARCHITECTURE §4.5): the provider-neutral
 * PaymentProvider with DarajaProvider, per-company encrypted credentials, payment requests and
 * attempts, the durable callback inbox, reconciliation, the transactional outbox with BullMQ
 * workers and the watchdog. D4.3 imports it to create B2C attempts for payroll obligations
 * (PaymentRequestsService.createRequest) and registers a PaymentOutcomeHandler.
 */
@Module({
  imports: [IdentityModule],
  controllers: [PaymentsController, PaymentCallbacksController],
  providers: [
    CallbackIntake,
    CertificateStore,
    DarajaProvider,
    { provide: PAYMENT_PROVIDER, useExisting: DarajaProvider },
    PaymentAccounts,
    PaymentCommands,
    PaymentLedger,
    PaymentOutcomeHandlers,
    PaymentProcessor,
    PaymentRequestsService,
    PaymentSettingsService,
    PaymentsCrypto,
    PaymentsRelay,
    PaymentsRuntime,
    ReconciliationService,
  ],
  exports: [PaymentOutcomeHandlers, PaymentRequestsService, PaymentsRelay, PaymentLedger, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
