import { Module } from "@nestjs/common";
import { AppConfig } from "../../config/app-config.js";
import { NotificationProvider, notificationProviderFor } from "./notification.provider.js";

@Module({
  providers: [
    { provide: NotificationProvider, inject: [AppConfig], useFactory: notificationProviderFor },
  ],
  exports: [NotificationProvider],
})
export class NotificationsModule {}
