import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { BiometricsController } from "./biometrics.controller.js";
import { BiometricsPlatform } from "./biometrics-support.js";
import { BiometricsService } from "./biometrics.service.js";
import { DpiaService } from "./dpia.service.js";

/**
 * Biometric attendance (D3.4, ARCHITECTURE §4.19). This first slice is the DPIA gate: the company's
 * DPIA versions and the per-site, per-method switch that every biometric capture path must pass.
 * Enrolment, encrypted templates (a separate key held by a separately deployed worker, OR-01) and
 * retention jobs come in the next slices.
 */
@Module({
  imports: [IdentityModule],
  controllers: [BiometricsController],
  providers: [BiometricsPlatform, BiometricsService, DpiaService],
  exports: [BiometricsPlatform],
})
export class BiometricsModule {}
