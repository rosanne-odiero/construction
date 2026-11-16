import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { LabourModule } from "../labour/labour.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { PayrollModule } from "../payroll/payroll.module.js";
import { PayrollApprovalsService } from "./approvals.service.js";
import { EvidenceUploadGuard, ManualPaymentsService } from "./manual-payments.service.js";
import { PayoutSettingsService } from "./payout-settings.service.js";
import { PayrollPayoutsController } from "./payouts.controller.js";
import { PayrollPayoutsService } from "./payouts.service.js";
import { PayoutAccess } from "./payouts-support.js";
import { PayrollNotificationsDispatcher } from "./payroll-notifications.js";
import { PayrollOutcomeHandler } from "./payroll-outcomes.js";
import { LabourPayoutsController } from "./recipients.controller.js";
import { RecipientsService } from "./recipients.service.js";

/**
 * Payroll approvals and payouts (D4.3, ARCHITECTURE §4.19): the batch approval chain with its
 * decision log, obligations and carry-forwards (D-167), M-Pesa payouts through D4.2 payment
 * requests (its `payroll_obligation` outcome handler allocates confirmed payouts), cash and bank
 * payments, recipient verification and holds, unusual-payout flags, the payroll notification
 * outbox and its dispatcher, payout settings, the segregation waiver and approval limits.
 */
@Module({
  imports: [IdentityModule, LabourModule, PayrollModule, PaymentsModule, NotificationsModule],
  controllers: [PayrollPayoutsController, LabourPayoutsController],
  providers: [
    EvidenceUploadGuard,
    ManualPaymentsService,
    PayoutAccess,
    PayoutSettingsService,
    PayrollApprovalsService,
    PayrollNotificationsDispatcher,
    PayrollOutcomeHandler,
    PayrollPayoutsService,
    RecipientsService,
  ],
  exports: [PayrollNotificationsDispatcher],
})
export class PayoutsModule {}
