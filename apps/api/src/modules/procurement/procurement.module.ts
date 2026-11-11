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
import { GrnsService } from "./p2p/grns.service.js";
import { InvoicesService } from "./p2p/invoices.service.js";
import { LposService } from "./p2p/lpos.service.js";
import { P2pAccess } from "./p2p/p2p-common.js";
import { P2pDocumentsService, P2pUploadGuard } from "./p2p/p2p-documents.service.js";
import { P2pOverviewService } from "./p2p/p2p-overview.service.js";
import {
  GrnsController,
  InvoicesController,
  LposController,
  P2pController,
  RequisitionsController,
  RfqsController,
} from "./p2p/p2p.controller.js";
import { RequisitionsService } from "./p2p/requisitions.service.js";
import { RfqsService } from "./p2p/rfqs.service.js";

/**
 * Procurement (ARCHITECTURE §4.4, §4.5): the material catalogue, units and conversions, price
 * history and alerts, suppliers and maker-checker payout details (D5.1); requisitions, RFQs and
 * quotations, LPOs, GRNs, supplier invoices, the three-way match, payables and recorded
 * settlements (D5.2, `p2p/`).
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    CatalogueController,
    SuppliersController,
    RequisitionsController,
    RfqsController,
    LposController,
    GrnsController,
    InvoicesController,
    P2pController,
  ],
  providers: [
    GrnsService,
    InvoicesService,
    LposService,
    P2pAccess,
    P2pDocumentsService,
    P2pOverviewService,
    P2pUploadGuard,
    RequisitionsService,
    RfqsService,
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
