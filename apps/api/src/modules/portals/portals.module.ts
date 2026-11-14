import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProcurementModule } from "../procurement/procurement.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { ClientCompanyService } from "./client/client-company.service.js";
import { ClientExportService } from "./client/client-export.service.js";
import {
  ClientPaymentRequests,
  DisabledClientPaymentRequests,
} from "./client/client-payment-requests.js";
import { ClientPaymentsService } from "./client/client-payments.service.js";
import { ClientPortalAccess } from "./client/client-portal-access.js";
import {
  ClientPortalController,
  ClientPortalStaffController,
} from "./client/client-portal.controller.js";
import { ClientPortalService } from "./client/client-portal.service.js";
import { ClientVariationsService } from "./client/client-variations.service.js";
import { PortalsController } from "./portals.controller.js";
import { PortalsService } from "./portals.service.js";
import { SupplierPortalAccess } from "./supplier/supplier-portal-access.js";
import { SupplierPortalUsersService } from "./supplier/supplier-portal-users.service.js";
import {
  SupplierPortalController,
  SupplierPortalUsersController,
} from "./supplier/supplier-portal.controller.js";
import { SupplierPortalService } from "./supplier/supplier-portal.service.js";
import { SupplierStatementExportService } from "./supplier/supplier-statement-export.service.js";

/** Client, labourer and supplier portals (company staff use the office API). */
@Module({
  imports: [IdentityModule, ProcurementModule, ProgressModule],
  controllers: [
    PortalsController,
    SupplierPortalController,
    SupplierPortalUsersController,
    ClientPortalController,
    ClientPortalStaffController,
  ],
  providers: [
    ClientPortalAccess,
    ClientPortalService,
    ClientPaymentsService,
    ClientCompanyService,
    ClientVariationsService,
    ClientExportService,
    // STK Push stays disabled until the Daraja provider (D4.2) implements this boundary.
    { provide: ClientPaymentRequests, useClass: DisabledClientPaymentRequests },
    PortalsService,
    SupplierPortalAccess,
    SupplierPortalService,
    SupplierPortalUsersService,
    SupplierStatementExportService,
  ],
})
export class PortalsModule {}
