import { ServiceUnavailableException } from "@nestjs/common";
import type { AppConfig } from "../../config/app-config.js";

/**
 * Notification delivery boundary (ARCHITECTURE §15). One provider serves every channel; callers
 * pick the channel, usually from the identifier (see channelFor). The real SMS/WhatsApp provider
 * (Africa's Talking, D7.3) and email provider plug in here.
 */
export const NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type Notification = {
  channel: NotificationChannel;
  /** An email address for email; a normalised phone number (digits only) for SMS and WhatsApp. */
  recipient: string;
  subject: string;
  text: string;
};

/** Implementations throw when they cannot deliver; they never log message text or recipients. */
export abstract class NotificationProvider {
  abstract send(notification: Notification): Promise<void>;
}

/** Email identifiers are reached by email, phone identifiers by SMS. */
export const channelFor = (identifier: string): NotificationChannel =>
  identifier.includes("@") ? "email" : "sms";

const PHONE = /^\d{9,15}$/;

/** The production default until a real provider is approved: every send fails explicitly. */
export class DisabledNotificationProvider extends NotificationProvider {
  send(): Promise<void> {
    return Promise.reject(
      new ServiceUnavailableException("No approved notification provider is configured"),
    );
  }
}

/**
 * Development only: every channel lands in the loopback Mailpit inbox. SMS and WhatsApp messages
 * go to `phone-<number>@development.invalid` with a `[DEVELOPMENT ONLY][SMS]` or
 * `[DEVELOPMENT ONLY][WHATSAPP]` subject prefix, so nothing reaches a real phone.
 */
export class DevelopmentNotificationProvider extends NotificationProvider {
  constructor(private readonly mailpitPort: number) {
    super();
  }

  async send({ channel, recipient, subject, text }: Notification): Promise<void> {
    const email = channel === "email";
    if (email ? !recipient.includes("@") : !PHONE.test(recipient)) {
      throw new ServiceUnavailableException("Recipient does not match the notification channel");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${this.mailpitPort}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          From: { Email: "no-reply@development.invalid", Name: "PM-Buddy Development" },
          To: [{ Email: email ? recipient : `phone-${recipient}@development.invalid` }],
          Subject: `[DEVELOPMENT ONLY]${email ? "" : `[${channel.toUpperCase()}]`} ${subject}`,
          Text: text,
        }),
      });
      if (!response.ok) throw new Error("Mailpit rejected development notification");
    } catch {
      throw new ServiceUnavailableException("Development notification delivery failed");
    }
  }
}

/** Development delivery only when explicitly configured outside production; otherwise disabled. */
export function notificationProviderFor(config: AppConfig): NotificationProvider {
  if (config.isProduction || config.get("AUTH_NOTIFICATION_TRANSPORT") !== "development") {
    return new DisabledNotificationProvider();
  }
  return new DevelopmentNotificationProvider(config.get("AUTH_MAILPIT_PORT"));
}
