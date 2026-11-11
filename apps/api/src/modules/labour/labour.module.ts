import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { GangsService } from "./gangs.service.js";
import { GangsController, LabourController } from "./labour.controller.js";
import { LabourAccess, LabourCrypto } from "./labour-support.js";
import { LabourerReader } from "./labourer-reader.js";
import { LabourersService } from "./labourers.service.js";
import { LabourRatesService } from "./rates.service.js";
import { LabourRecordsService } from "./records.service.js";
import { LabourSetupService } from "./setup.service.js";
import { LabourViewsService } from "./views.service.js";

/**
 * Labour registry (D3.1, ARCHITECTURE §4.2): trades, skill levels, rates, labourers with
 * field-level encryption, consent, NCA accreditation, do-not-rehire, gangs and saved views.
 */
@Module({
  imports: [IdentityModule],
  controllers: [LabourController, GangsController],
  providers: [
    GangsService,
    LabourAccess,
    LabourCrypto,
    LabourerReader,
    LabourersService,
    LabourRatesService,
    LabourRecordsService,
    LabourSetupService,
    LabourViewsService,
  ],
  exports: [LabourCrypto, LabourersService],
})
export class LabourModule {}
