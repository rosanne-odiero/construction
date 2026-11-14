import { Module } from "@nestjs/common";
import { SpendingAccess } from "../finance/spending-common.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { DiariesController } from "./diaries.controller.js";
import { DiariesService } from "./diaries.service.js";
import {
  MeasurementQueueController,
  MeasurementsController,
} from "./measurements/measurements.controller.js";
import { MeasurementsService } from "./measurements/measurements.service.js";
import { PhotosController, PhotoUploadGuard } from "./photos.controller.js";
import { PhotosService } from "./photos.service.js";
import { CertificateExportService } from "./valuations/certificate-export.service.js";
import { EarnedValueService } from "./valuations/earned-value.service.js";
import {
  ProjectValuationsController,
  ValuationsController,
} from "./valuations/valuations.controller.js";
import { ValuationsService } from "./valuations/valuations.service.js";

/**
 * Progress (Phase 6): site diaries and geotagged site photos; progress measurement with photo
 * evidence and independent review, interim valuations and payment certificates with retention
 * and its release, earned value and cost to complete (D6.3 part A, ARCHITECTURE §4.10).
 */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [
    DiariesController,
    PhotosController,
    MeasurementsController,
    MeasurementQueueController,
    ProjectValuationsController,
    ValuationsController,
  ],
  providers: [
    DiariesService,
    PhotosService,
    PhotoUploadGuard,
    SpendingAccess,
    MeasurementsService,
    ValuationsService,
    EarnedValueService,
    CertificateExportService,
  ],
  // The client portal (D7.1) renders certified certificates with the D6.3 export.
  exports: [ValuationsService, CertificateExportService],
})
export class ProgressModule {}
