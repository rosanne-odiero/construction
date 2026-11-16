import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { LabourModule } from "../labour/labour.module.js";
import { BiometricConsentService } from "./biometric-consent.service.js";
import { BiometricEnrolmentService } from "./biometric-enrolment.service.js";
import { BiometricRetentionService } from "./biometric-retention.service.js";
import { BiometricWorkersController } from "./biometric-workers.controller.js";
import { BiometricsController } from "./biometrics.controller.js";
import { BiometricsPlatform } from "./biometrics-support.js";
import { BiometricsService } from "./biometrics.service.js";
import { DpiaService } from "./dpia.service.js";

/**
 * Biometric attendance (D3.4, ARCHITECTURE §4.19): the DPIA gate (the company's DPIA versions and
 * the per-site, per-method switch every biometric capture path must pass), consent per modality,
 * enrolment with templates sealed to a biometrics-only key, and template deletion (on withdrawal,
 * on request, when the DPIA stops covering them, and by the retention job). Kiosk capture and
 * on-device matching come with the site app (D3.2) and the SDK choice.
 */
@Module({
  imports: [IdentityModule, LabourModule],
  controllers: [BiometricsController, BiometricWorkersController],
  providers: [
    BiometricsPlatform,
    BiometricsService,
    DpiaService,
    BiometricConsentService,
    BiometricEnrolmentService,
    BiometricRetentionService,
  ],
  exports: [BiometricsPlatform, BiometricRetentionService],
})
export class BiometricsModule {}
