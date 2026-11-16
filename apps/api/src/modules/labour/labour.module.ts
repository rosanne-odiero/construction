import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { GangsService } from "./gangs.service.js";
import { GangsController, LabourController } from "./labour.controller.js";
import { LabourAccess, LabourCrypto } from "./labour-support.js";
import { LabourerReader } from "./labourer-reader.js";
import { LabourersService } from "./labourers.service.js";
import { LabourRatesService } from "./rates.service.js";
import { LabourRatingsController } from "./ratings.controller.js";
import { LabourRatingsService } from "./ratings.service.js";
import { LabourRecordsService } from "./records.service.js";
import { LabourSetupService } from "./setup.service.js";
import { LabourViewsService } from "./views.service.js";

/**
 * Labour registry (D3.1, ARCHITECTURE §4.2): trades, skill levels, rates, labourers with
 * field-level encryption, consent, NCA accreditation, do-not-rehire, gangs and saved views; worker
 * ratings (D3.5).
 */
@Module({
  imports: [IdentityModule],
  controllers: [LabourController, GangsController, LabourRatingsController],
  providers: [
    GangsService,
    LabourAccess,
    LabourCrypto,
    LabourerReader,
    LabourersService,
    LabourRatesService,
    LabourRatingsService,
    LabourRecordsService,
    LabourSetupService,
    LabourViewsService,
  ],
  exports: [LabourCrypto, LabourersService, LabourRatingsService],
})
export class LabourModule {}
