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
import { PaymentTariffsController } from "./tariffs.controller.js";
import { PaymentTariffsService } from "./tariffs.service.js";

/**
 * Payments and the Daraja integration (D4.2, ARCHITECTURE §4.18): the provider-neutral
 * PaymentProvider with DarajaProvider, per-company encrypted credentials, payment requests and
 * attempts, the durable callback inbox, reconciliation, the transactional outbox with BullMQ
 * workers and the watchdog. D4.3 imports it to create B2C attempts for payroll obligations
 * (PaymentRequestsService.createRequest), registers a PaymentOutcomeHandler and runs float checks
 * through PaymentRequestsService.requestBalance; the M-Pesa charges tariff lives here too.
 */
@Module({
  imports: [IdentityModule],
  controllers: [PaymentsController, PaymentCallbacksController, PaymentTariffsController],
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
    PaymentTariffsService,
    PaymentsCrypto,
    PaymentsRelay,
    PaymentsRuntime,
    ReconciliationService,
  ],
  exports: [
    PaymentOutcomeHandlers,
    PaymentRequestsService,
    PaymentsRelay,
    PaymentLedger,
    PaymentsCrypto,
    PAYMENT_PROVIDER,
  ],
})
export class PaymentsModule {}
