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
import { BuildupMaterialsService } from "./stores/buildup-materials.service.js";
import { MovementsService } from "./stores/movements.service.js";
import { StockLedger } from "./stores/stock-ledger.js";
import { StockTakesService } from "./stores/stock-takes.service.js";
import {
  BuildupMaterialsController,
  StockMovementsController,
  StockTakesController,
  StockTransfersController,
  StoresController,
} from "./stores/stores.controller.js";
import { StoresAccess } from "./stores/stores-common.js";
import { StoresService } from "./stores/stores.service.js";
import { TransfersService } from "./stores/transfers.service.js";
import { VarianceService } from "./stores/variance.service.js";

/**
 * Procurement (ARCHITECTURE §4.4, §4.5): the material catalogue, units and conversions, price
 * history and alerts, suppliers and maker-checker payout details (D5.1); requisitions, RFQs and
 * quotations, LPOs, GRNs, supplier invoices, the three-way match, payables and recorded
 * settlements (D5.2, `p2p/`); stores per site, the append-only stock ledger, issues, returns,
 * wastage, transfers, stock takes, build-up material mappings and consumption variance (D5.3,
 * `stores/`; GRNs receive into stores through StockLedger).
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
    StoresController,
    StockMovementsController,
    StockTransfersController,
    StockTakesController,
    BuildupMaterialsController,
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
    BuildupMaterialsService,
    MovementsService,
    StockLedger,
    StockTakesService,
    StoresAccess,
    StoresService,
    TransfersService,
    VarianceService,
  ],
  exports: [
    CatalogueStore,
    InvoicesService,
    LposService,
    P2pAccess,
    P2pDocumentsService,
    P2pUploadGuard,
    StoresService,
    SupplierCrypto,
  ],
})
export class ProcurementModule {}
