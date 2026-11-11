import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { BqAccess } from "./bq-access.js";
import { BqController, BqUploadGuard } from "./bq.controller.js";
import { BqExportService } from "./bq-export.service.js";
import { BqImportsService } from "./bq-imports.service.js";
import { BqObjectStore } from "./bq-object-store.js";
import { BqTemplatesService } from "./bq-templates.service.js";
import { BqVariationsController } from "./bq-variations.controller.js";
import { BqVersionWriter } from "./bq-version-writer.js";
import { BqVersionsService } from "./bq-versions.service.js";
import { BqViewerService } from "./bq-viewer.service.js";
import { BuildupsController } from "./buildups.controller.js";
import { BuildupsService } from "./buildups.service.js";
import { InstructionsService } from "./instructions.service.js";
import { VariationsService } from "./variations.service.js";

/**
 * Bill of Quantities: import, viewer, exports and mapping templates (D2.2, ARCHITECTURE §4.2);
 * versions, instructions, variations and the rate build-up library (D2.3, §4.3).
 */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [BqController, BqVariationsController, BuildupsController],
  providers: [
    BqAccess,
    BqExportService,
    BqImportsService,
    BqObjectStore,
    BqTemplatesService,
    BqUploadGuard,
    BqVersionWriter,
    BqVersionsService,
    BqViewerService,
    BuildupsService,
    InstructionsService,
    VariationsService,
  ],
})
export class BqModule {}
