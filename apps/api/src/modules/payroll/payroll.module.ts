import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { LabourModule } from "../labour/labour.module.js";
import { AdvancesService } from "./advances.service.js";
import { BatchBuilder } from "./batch-builder.js";
import { PayrollBatchesService } from "./batches.service.js";
import { PayrollExportsService } from "./exports.service.js";
import { PayrollInputsService } from "./inputs.service.js";
import { PayrollController } from "./payroll.controller.js";
import { PayrollAccess, PayrollCommands } from "./payroll-support.js";
import { PayrollRulesService } from "./rules.service.js";

/**
 * Payroll engine (D4.1, ARCHITECTURE §4.5): pay calendars, versioned statutory rules with
 * verification, minimum wages, allowances, piece-rate output, salary advances, batches with their
 * immutable submitted snapshot, payslips and statutory export templates. Approval, obligations and
 * payouts are D4.3.
 */
@Module({
  imports: [IdentityModule, LabourModule],
  controllers: [PayrollController],
  providers: [
    AdvancesService,
    BatchBuilder,
    PayrollAccess,
    PayrollBatchesService,
    PayrollCommands,
    PayrollExportsService,
    PayrollInputsService,
    PayrollRulesService,
  ],
  exports: [BatchBuilder],
})
export class PayrollModule {}
