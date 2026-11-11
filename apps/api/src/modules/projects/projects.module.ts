import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectAccess } from "./project-access.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { SitesService } from "./sites.service.js";
import { TeamService } from "./team.service.js";
import { WbsService } from "./wbs.service.js";

/** Projects, sites and geofences, WBS, milestones and project teams (D2.1, ARCHITECTURE §4). */
@Module({
  imports: [IdentityModule],
  controllers: [ProjectsController],
  providers: [ProjectAccess, ProjectsService, SitesService, TeamService, WbsService],
  exports: [ProjectsService, SitesService],
})
export class ProjectsModule {}
