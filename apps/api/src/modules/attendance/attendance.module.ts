import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { AdjustmentsService } from "./adjustments.service.js";
import { AnomaliesService } from "./anomalies.service.js";
import { AttendanceController } from "./attendance.controller.js";
import { AttendanceAccess, AttendanceCommands } from "./attendance-support.js";
import { CorrectionsService } from "./corrections.service.js";
import { MusterService } from "./muster.service.js";
import { AnomalyEvaluator, PeriodStore } from "./period-store.js";
import { PeriodsService } from "./periods.service.js";
import { AttendanceSettingsService } from "./settings.service.js";
import { TimesheetCalculator } from "./timesheet-calculator.js";

/**
 * Attendance and timesheets, web-only slice of D3.3 (ARCHITECTURE §4.4): settings, holiday calendar,
 * daily muster roll with maker-checker confirmation, corrections, anomalies, timesheet periods with
 * an approved snapshot for payroll, and adjustments. The site app, QR/NFC capture, geofence checks
 * and offline sync are later slices.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AttendanceController],
  providers: [
    AdjustmentsService,
    AnomaliesService,
    AnomalyEvaluator,
    AttendanceAccess,
    AttendanceCommands,
    AttendanceSettingsService,
    CorrectionsService,
    MusterService,
    PeriodsService,
    PeriodStore,
    TimesheetCalculator,
  ],
  exports: [TimesheetCalculator, AnomalyEvaluator, PeriodStore],
})
export class AttendanceModule {}
