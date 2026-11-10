import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { AppConfig } from "./config/app-config.js";

const app = await NestFactory.create(AppModule, { bufferLogs: true });
configureApp(app);
await app.listen(app.get(AppConfig).get("PORT"));
