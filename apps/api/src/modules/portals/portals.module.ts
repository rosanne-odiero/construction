import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { PortalsController } from "./portals.controller.js";
import { PortalsService } from "./portals.service.js";

/** Client and labourer portals (company staff use the office API). */
@Module({
  imports: [IdentityModule],
  controllers: [PortalsController],
  providers: [PortalsService],
})
export class PortalsModule {}
