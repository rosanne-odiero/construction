import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { CorrectiveActionsService } from "./corrective-actions.service.js";
import { FirstAidService } from "./first-aid.service.js";
import { IncidentsService } from "./incidents.service.js";
import { InductionsService } from "./inductions.service.js";
import { PpeService } from "./ppe.service.js";
import { SafetyAccess } from "./safety-access.js";
import { SafetyCompanyController } from "./safety-company.controller.js";
import { SafetySettingsService } from "./safety-settings.service.js";
import { SafetyController } from "./safety.controller.js";
import { ToolboxTalksService } from "./toolbox-talks.service.js";

/**
 * Health and safety (D8.2, ARCHITECTURE §4.8): site inductions and their status against
 * attendance, toolbox talks, the PPE register, incidents and near misses with investigation and
 * the regulator decision, corrective actions, and first aid.
 */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [SafetyCompanyController, SafetyController],
  providers: [
    SafetyAccess,
    SafetySettingsService,
    InductionsService,
    ToolboxTalksService,
    PpeService,
    IncidentsService,
    CorrectiveActionsService,
    FirstAidService,
  ],
  exports: [
    SafetySettingsService,
    InductionsService,
    ToolboxTalksService,
    PpeService,
    IncidentsService,
    CorrectiveActionsService,
    FirstAidService,
  ],
})
export class SafetyModule {}
