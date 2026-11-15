import { Controller, Get, Param, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import {
  projectPlantOptionsQuerySchema,
  projectPlantOptionsResponseSchema,
  projectPlantResponseSchema,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { openApi } from "../../common/openapi.js";
import { AuthService } from "../identity/auth.service.js";
import { BrowserGuard } from "../identity/identity.controller.js";
import { uuidSchema } from "../identity/identity.schemas.js";
import { PlantDatabaseErrors } from "./plant-errors.js";
import { ProjectPlantService } from "./project-plant.service.js";

const read =
  "Requires projects.view plus one of plant.manage, site.diary, projects.manage, stores.manage, finance.view or finance.manage on the project (role ∩ assignment); clients, suppliers, consultants and labourers are refused (403); another company's project is 404.";

/** A project's plant tab and the choices its site forms offer (D8.3, ARCHITECTURE §4.11). */
@ApiTags("plant")
@UseGuards(BrowserGuard)
@Controller({ path: "projects/:projectId/plant", version: "1" })
@UseInterceptors(PlantDatabaseErrors)
export class ProjectPlantController {
  constructor(
    private readonly auth: AuthService,
    private readonly projectPlant: ProjectPlantService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: "getProjectPlant",
    summary: "Items on the project's sites today, their alerts, today's usage and fuel, operators",
    description: `${read} Hire rates and estimates need plant.manage, finance.view or finance.manage on the project.`,
  })
  @ApiOkResponse({ schema: openApi(projectPlantResponseSchema) })
  async tab(@Param("projectId") projectId: string, @Req() req: Request) {
    return this.projectPlant.tab(await this.auth.principal(req), uuidSchema.parse(projectId), req);
  }

  @Get("options")
  @ApiOperation({
    operationId: "getProjectPlantOptions",
    summary: "Labourers engaged on the project, staff, cost codes and BQ items for the site forms",
    description: read,
  })
  @ApiQuery({ name: "search", required: false, description: "Labourer name or worker number" })
  @ApiQuery({ name: "bqSearch", required: false, description: "BQ item reference or text" })
  @ApiOkResponse({ schema: openApi(projectPlantOptionsResponseSchema) })
  async options(
    @Param("projectId") projectId: string,
    @Query() query: unknown,
    @Req() req: Request,
  ) {
    return this.projectPlant.options(
      await this.auth.principal(req),
      uuidSchema.parse(projectId),
      projectPlantOptionsQuerySchema.parse(query),
      req,
    );
  }
}
