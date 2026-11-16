import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { AccessLog } from "./access-log.service.js";
import { AccessLogRetention } from "./access-log.retention.js";
import { AccessLogWriter } from "./access-log.writer.js";

/** The access log (D9.3): capture middleware, batched writer and retention purge. */
@Module({
  imports: [IdentityModule],
  providers: [AccessLog, AccessLogWriter, AccessLogRetention],
  exports: [AccessLog, AccessLogWriter, AccessLogRetention],
})
export class AccessLogModule {}
