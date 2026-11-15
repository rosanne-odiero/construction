import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PlantModule } from "../plant/plant.module.js";
import { ProcurementModule } from "../procurement/procurement.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { SafetyModule } from "../safety/safety.module.js";
import { DashboardService } from "./dashboard.service.js";
import { ReportsAccess } from "./reports-access.js";
import { ReportSchedulerService } from "./report-scheduler.service.js";
import { ReportSubscriptionsService } from "./report-subscriptions.service.js";
import { DashboardController, ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

/**
 * Dashboards and reports (D8.1, ARCHITECTURE §4.14): the owner dashboard, the code-defined report
 * registry with one model rendered as HTML, PDF and Excel, report subscriptions and the in-process
 * scheduler that emails a sign-in link (never report data) when they are due.
 */
@Module({
  imports: [
    IdentityModule,
    ProjectsModule,
    FinanceModule,
    ProcurementModule,
    ProgressModule,
    PlantModule,
    SafetyModule,
  ],
  controllers: [DashboardController, ReportsController],
  providers: [
    ReportsAccess,
    ReportsService,
    DashboardService,
    ReportSubscriptionsService,
    ReportSchedulerService,
  ],
  exports: [ReportSubscriptionsService, ReportSchedulerService],
})
export class ReportsModule {}
