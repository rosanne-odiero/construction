import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { BaselinesService } from "./baselines.service.js";
import { DelaysService } from "./delays.service.js";
import { ScheduleController } from "./schedule.controller.js";
import { ScheduleService } from "./schedule.service.js";

/** Project schedule (D6.2, ARCHITECTURE §4.6): activities, CPM, baselines and the delay log. */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [ScheduleController],
  providers: [ScheduleService, BaselinesService, DelaysService],
})
export class ScheduleModule {}
