import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { PlantAccess } from "./plant-access.js";
import { PlantMaintenanceService } from "./plant-maintenance.service.js";
import { PlantOperatorsService } from "./plant-operators.js";
import { PlantRecordsService } from "./plant-records.service.js";
import { PlantRegisterService } from "./plant-register.service.js";
import { PlantController } from "./plant.controller.js";
import { ProjectPlantController } from "./project-plant.controller.js";
import { ProjectPlantService } from "./project-plant.service.js";

/**
 * Plant and equipment (D8.3, ARCHITECTURE §4.11): the company register of owned and hired plant,
 * moves between sites, operators, daily usage and fuel with the fuel variance, meter resets,
 * breakdowns, maintenance, hire tracking and alerts.
 */
@Module({
  imports: [IdentityModule],
  controllers: [PlantController, ProjectPlantController],
  providers: [
    PlantAccess,
    PlantRegisterService,
    PlantOperatorsService,
    PlantRecordsService,
    PlantMaintenanceService,
    ProjectPlantService,
  ],
  exports: [
    PlantRegisterService,
    PlantOperatorsService,
    PlantRecordsService,
    PlantMaintenanceService,
  ],
})
export class PlantModule {}
