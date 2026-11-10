import { Controller, Get, Res } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  liveResponseSchema,
  readyResponseSchema,
  type LiveResponse,
  type ReadyResponse,
} from "@pm-buddy/validation";
import type { Response } from "express";
import { z } from "zod";
import { HealthService } from "./health.service.js";

const liveSchema = z.toJSONSchema(liveResponseSchema, { target: "openapi-3.0" });
const readySchema = z.toJSONSchema(readyResponseSchema, { target: "openapi-3.0" });

@ApiTags("health")
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness: the process is running", operationId: "getLiveness" })
  @ApiOkResponse({ description: "The API process is up", schema: liveSchema as object })
  live(): LiveResponse {
    return this.health.live();
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness: database, Redis/Valkey and object storage are reachable",
    operationId: "getReadiness",
  })
  @ApiOkResponse({ description: "Every dependency is up", schema: readySchema as object })
  @ApiServiceUnavailableResponse({
    description: "At least one dependency is down",
    schema: readySchema as object,
  })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    const result = await this.health.ready();
    if (result.status !== "ok") res.status(503);
    return result;
  }
}
