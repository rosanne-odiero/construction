import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ApprovalsService } from "./approvals.service.js";
import { ComplianceExportService } from "./compliance-export.service.js";
import { ComplianceService } from "./compliance.service.js";
import { DocumentsAccess } from "./documents-access.js";
import { DocumentsOverviewService } from "./documents-overview.service.js";
import { DocumentsController } from "./documents.controller.js";
import { DocumentsService } from "./documents.service.js";
import { InstructionsLogService } from "./instructions-log.service.js";
import { ProjectComplianceController } from "./project-compliance.controller.js";
import { ProjectDocumentsController } from "./project-documents.controller.js";
import {
  ProjectApprovalsController,
  ProjectInstructionsController,
} from "./project-records.controller.js";

/**
 * Documents and compliance register (D8.4, ARCHITECTURE §4.13): versioned project documents, the
 * compliance register with reminders and exports, the consultant instructions log and approval
 * requests.
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    DocumentsController,
    ProjectDocumentsController,
    ProjectComplianceController,
    ProjectInstructionsController,
    ProjectApprovalsController,
  ],
  providers: [
    DocumentsAccess,
    DocumentsService,
    ComplianceService,
    ComplianceExportService,
    InstructionsLogService,
    ApprovalsService,
    DocumentsOverviewService,
  ],
  exports: [DocumentsService, ComplianceService, InstructionsLogService, ApprovalsService],
})
export class DocumentsModule {}
