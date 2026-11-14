import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { DiariesController } from "./diaries.controller.js";
import { DiariesService } from "./diaries.service.js";
import { MeasurementsController } from "./measurements/measurements.controller.js";
import { MeasurementsService } from "./measurements/measurements.service.js";
import { PhotosController, PhotoUploadGuard } from "./photos.controller.js";
import { PhotosService } from "./photos.service.js";

/**
 * Progress and quality (Phase 6): site diaries and geotagged site photos; the minimal progress
 * measurement used by the D5.3 consumption variance (D6.3 extends it).
 */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [DiariesController, PhotosController, MeasurementsController],
  providers: [DiariesService, PhotosService, PhotoUploadGuard, MeasurementsService],
})
export class ProgressModule {}
