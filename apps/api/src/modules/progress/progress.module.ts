import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { DiariesController } from "./diaries.controller.js";
import { DiariesService } from "./diaries.service.js";
import { PhotosController, PhotoUploadGuard } from "./photos.controller.js";
import { PhotosService } from "./photos.service.js";

/** Progress and quality (Phase 6): site diaries and geotagged site photos. */
@Module({
  imports: [IdentityModule, ProjectsModule],
  controllers: [DiariesController, PhotosController],
  providers: [DiariesService, PhotosService, PhotoUploadGuard],
})
export class ProgressModule {}
