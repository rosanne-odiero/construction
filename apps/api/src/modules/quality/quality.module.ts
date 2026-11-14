import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { CompletionService } from "./completion.service.js";
import { ConcreteService } from "./concrete.service.js";
import { InspectionsService } from "./inspections.service.js";
import { QualityAccess } from "./quality-access.js";
import { QualitySettingsService } from "./quality-settings.service.js";
import { QualityController } from "./quality.controller.js";
import { SnagsService } from "./snags.service.js";
import { QualityTemplatesController } from "./templates.controller.js";
import { TemplatesService } from "./templates.service.js";

/**
 * Quality (D6.1, ARCHITECTURE §4.7): checklist templates, inspections, concrete cube and slump
 * tests, snags, practical and final completion with the defects liability period.
 */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [QualityTemplatesController, QualityController],
  providers: [
    QualityAccess,
    TemplatesService,
    InspectionsService,
    SnagsService,
    ConcreteService,
    CompletionService,
    QualitySettingsService,
  ],
  exports: [TemplatesService, InspectionsService, SnagsService, ConcreteService, CompletionService],
})
export class QualityModule {}
