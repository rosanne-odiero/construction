import { Module } from "@nestjs/common";
import { SpendingAccess } from "../finance/spending-common.js";
import { IdentityModule } from "../identity/identity.module.js";
import { SubcontractCertificatesService } from "./subcontract-certificates.service.js";
import { SubcontractExportService } from "./subcontract-export.service.js";
import {
  SubcontractCertificatesController,
  SubcontractsController,
} from "./subcontracts.controller.js";
import { SubcontractAccess } from "./subcontracts-common.js";
import { SubcontractsService } from "./subcontracts.service.js";

/**
 * Subcontracts (D6.3 part B, ARCHITECTURE §4.16): subcontractors (D5.1 suppliers flagged as
 * such), subcontracts on BQ items with variations and advances, subcontract payment certificates
 * (rule KE-SUB-1) from approved measurement, payments and invoices recorded against them, and the
 * subcontractor statement. Piece-rate jobs live with payroll (PayrollModule).
 */
@Module({
  imports: [IdentityModule],
  controllers: [SubcontractsController, SubcontractCertificatesController],
  providers: [
    SpendingAccess,
    SubcontractAccess,
    SubcontractsService,
    SubcontractCertificatesService,
    SubcontractExportService,
  ],
  exports: [SubcontractsService, SubcontractCertificatesService],
})
export class SubcontractsModule {}
