import { ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import type { AppConfig } from "../../config/app-config.js";

/**
 * Notification delivery boundary (ARCHITECTURE §15). One provider serves every channel; callers
 * pick the channel, usually from the identifier (see channelFor).
 */
export const NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type Notification = {
  channel: NotificationChannel;
  /** An email address for email; a normalised phone number (digits only) for SMS and WhatsApp. */
  recipient: string;
  subject: string;
  text: string;
  /** Caller attests this exact name/language/components match a Meta-approved template. */
  whatsappTemplate?: WhatsAppTemplate;
};

const textParameter = z
  .object({ type: z.literal("text"), text: z.string().min(1).max(32768) })
  .strict();
const templateSchema = z
  .object({
    approved: z.literal(true),
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    languageCode: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
    components: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.enum(["header", "body"]),
              parameters: z.array(textParameter).min(1).max(100),
            })
            .strict(),
          z
            .object({
              type: z.literal("button"),
              sub_type: z.literal("url"),
              index: z.string().regex(/^[0-9]$/),
              parameters: z.array(textParameter).length(1),
            })
            .strict(),
        ]),
      )
      .max(12)
      .optional(),
  })
  .strict();
export type WhatsAppTemplate = z.infer<typeof templateSchema>;

/** Resolution means provider acceptance, not handset delivery. Never logs payloads or recipients. */
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

const smsResponseSchema = z.object({
  SMSMessageData: z.object({
    Recipients: z
      .array(
        z.object({
          number: z.string(),
          status: z.literal("Success"),
          statusCode: z.union([z.literal(100), z.literal(101), z.literal(102)]),
          messageId: z.string().trim().min(1),
        }),
      )
      .length(1),
  }),
});
const whatsappResponseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  messages: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        message_status: z.literal("accepted").optional(),
      }),
    )
    .length(1),
});

/** Live HTTPS transports, enabled only by an explicit `real` setting. No automatic retries. */
export class RealNotificationProvider extends NotificationProvider {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async send(notification: Notification): Promise<void> {
    if (notification.channel === "email") {
      throw new ServiceUnavailableException("Email delivery is unavailable under real transport");
    }
    if (!/^[1-9]\d{8,14}$/.test(notification.recipient)) {
      throw new ServiceUnavailableException("Recipient does not match the notification channel");
    }
    if (notification.channel === "sms") return this.sendSms(notification);
    if (notification.channel === "whatsapp") return this.sendWhatsApp(notification);
    throw new ServiceUnavailableException("Unsupported notification channel");
  }

  private async sendSms({ recipient, text }: Notification): Promise<void> {
    const username = this.config.get("AFRICAS_TALKING_USERNAME");
    const apiKey = this.config.get("AFRICAS_TALKING_API_KEY");
    if (!username || !apiKey || username === "sandbox") {
      throw new ServiceUnavailableException("SMS delivery is not configured");
    }
    if (!text.trim()) throw new ServiceUnavailableException("SMS content is required");
    const body = new URLSearchParams({ username, to: `+${recipient}`, message: text });
    const sender = this.config.get("AFRICAS_TALKING_SENDER_ID");
    if (sender) body.set("from", sender);
    try {
      const response = await fetch("https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: {
          apiKey,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(this.config.get("NOTIFICATION_TIMEOUT_MS")),
      });
      if (!response.ok) throw new Error();
      const result = smsResponseSchema.parse(await response.json());
      if (result.SMSMessageData.Recipients[0]!.number !== `+${recipient}`) throw new Error();
    } catch {
      throw new ServiceUnavailableException("SMS provider did not confirm acceptance");
    }
  }

  private async sendWhatsApp({ recipient, whatsappTemplate }: Notification): Promise<void> {
    const token = this.config.get("WHATSAPP_ACCESS_TOKEN");
    const phoneId = this.config.get("WHATSAPP_PHONE_NUMBER_ID");
    const version = this.config.get("WHATSAPP_GRAPH_API_VERSION");
    if (!token || !phoneId || !version) {
      throw new ServiceUnavailableException("WhatsApp delivery is not configured");
    }
    const parsed = templateSchema.safeParse(whatsappTemplate);
    if (!parsed.success) {
      throw new ServiceUnavailableException(
        "WhatsApp requires explicit approved template metadata",
      );
    }
    const template = parsed.data;
    try {
      const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "template",
          template: {
            name: template.name,
            language: { code: template.languageCode },
            ...(template.components ? { components: template.components } : {}),
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(this.config.get("NOTIFICATION_TIMEOUT_MS")),
      });
      if (!response.ok) throw new Error();
      whatsappResponseSchema.parse(await response.json());
    } catch {
      throw new ServiceUnavailableException("WhatsApp provider did not confirm acceptance");
    }
  }
}

/** Disabled by default, including in production. Development Mailpit never runs in production. */
export function notificationProviderFor(config: AppConfig): NotificationProvider {
  if (config.get("AUTH_NOTIFICATION_TRANSPORT") === "real") {
    return new RealNotificationProvider(config);
  }
  if (config.isProduction || config.get("AUTH_NOTIFICATION_TRANSPORT") !== "development") {
    return new DisabledNotificationProvider();
  }
  return new DevelopmentNotificationProvider(config.get("AUTH_MAILPIT_PORT"));
}
