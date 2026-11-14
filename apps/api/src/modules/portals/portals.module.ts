import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProcurementModule } from "../procurement/procurement.module.js";
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
  imports: [IdentityModule, ProcurementModule],
  controllers: [PortalsController, SupplierPortalController, SupplierPortalUsersController],
  providers: [
    PortalsService,
    SupplierPortalAccess,
    SupplierPortalService,
    SupplierPortalUsersService,
    SupplierStatementExportService,
  ],
})
export class PortalsModule {}
