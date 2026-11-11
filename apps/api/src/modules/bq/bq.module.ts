import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { BqAccess } from "./bq-access.js";
import { BqController, BqUploadGuard } from "./bq.controller.js";
import { BqExportService } from "./bq-export.service.js";
import { BqImportsService } from "./bq-imports.service.js";
import { BqObjectStore } from "./bq-object-store.js";
import { BqTemplatesService } from "./bq-templates.service.js";
import { BqVersionWriter } from "./bq-version-writer.js";
import { BqViewerService } from "./bq-viewer.service.js";

/** Bill of Quantities: import, viewer, exports and mapping templates (D2.2, ARCHITECTURE §4.2). */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [BqController],
  providers: [
    BqAccess,
    BqExportService,
    BqImportsService,
    BqObjectStore,
    BqTemplatesService,
    BqUploadGuard,
    BqVersionWriter,
    BqViewerService,
  ],
})
export class BqModule {}
