import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { CatalogueController } from "./catalogue.controller.js";
import { CatalogueService } from "./catalogue.service.js";
import { CatalogueStore } from "./catalogue-store.js";
import { ConversionsService } from "./conversions.service.js";
import { PayoutsService } from "./payouts.service.js";
import { PricesService } from "./prices.service.js";
import { ProcurementAccess } from "./procurement-access.js";
import { SupplierCrypto } from "./supplier-crypto.js";
import { SuppliersController } from "./suppliers.controller.js";
import { SuppliersService } from "./suppliers.service.js";

/**
 * Procurement (ARCHITECTURE §4.4): the material catalogue, units and conversions, price history
 * and alerts, suppliers and maker-checker payout details (D5.1). Requisitions, RFQs, LPOs, GRNs,
 * invoices and the three-way match arrive with D5.2.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CatalogueController, SuppliersController],
  providers: [
    CatalogueService,
    CatalogueStore,
    ConversionsService,
    PayoutsService,
    PricesService,
    ProcurementAccess,
    SupplierCrypto,
    SuppliersService,
  ],
  exports: [SupplierCrypto],
})
export class ProcurementModule {}
