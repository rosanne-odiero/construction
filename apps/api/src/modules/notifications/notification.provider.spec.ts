import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import {
  channelFor,
  DevelopmentNotificationProvider,
  DisabledNotificationProvider,
  notificationProviderFor,
} from "./notification.provider.js";

const config = (transport: string, production = false) =>
  ({
    isProduction: production,
    get: (name: string) =>
      ({ AUTH_NOTIFICATION_TRANSPORT: transport, AUTH_MAILPIT_PORT: 18025 })[name],
  }) as unknown as AppConfig;

function mailpit(ok = true) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: ok ? 200 : 500 }));
}
const sent = (fetchMock: ReturnType<typeof mailpit>) => {
  const [url, init] = fetchMock.mock.calls[0]!;
  if (typeof url !== "string" || typeof init?.body !== "string") throw new Error("Unexpected call");
  return {
    url,
    body: JSON.parse(init.body) as { To: { Email: string }[]; Subject: string },
  };
};

describe("Notification channels", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes email identifiers by email and phone identifiers by SMS", () => {
    expect(channelFor("site.agent@example.test")).toBe("email");
    expect(channelFor("254712345678")).toBe("sms");
  });

  it("delivers every development channel to loopback Mailpit with a channel label", async () => {
    const provider = new DevelopmentNotificationProvider(18025);
    const cases = [
      {
        channel: "email",
        recipient: "site.agent@example.test",
        to: "site.agent@example.test",
        subject: "[DEVELOPMENT ONLY] Verify your account",
      },
      {
        channel: "sms",
        recipient: "254712345678",
        to: "phone-254712345678@development.invalid",
        subject: "[DEVELOPMENT ONLY][SMS] Verify your account",
      },
      {
        channel: "whatsapp",
        recipient: "254112345678",
        to: "phone-254112345678@development.invalid",
        subject: "[DEVELOPMENT ONLY][WHATSAPP] Verify your account",
      },
    ] as const;
    for (const { channel, recipient, to, subject } of cases) {
      const fetchMock = mailpit();
      await provider.send({ channel, recipient, subject: "Verify your account", text: "Code" });
      const { url, body } = sent(fetchMock);
      expect(url).toBe("http://127.0.0.1:18025/api/v1/send");
      expect(body.To).toEqual([{ Email: to }]);
      expect(body.Subject).toBe(subject);
      vi.restoreAllMocks();
    }
  });

  it("refuses a recipient that does not fit the channel and reports delivery failures", async () => {
    const provider = new DevelopmentNotificationProvider(18025);
    const fetchMock = mailpit();
    await expect(
      provider.send({ channel: "sms", recipient: "person@example.test", subject: "S", text: "T" }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      provider.send({ channel: "email", recipient: "254712345678", subject: "S", text: "T" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    mailpit(false);
    await expect(
      provider.send({ channel: "email", recipient: "a@example.test", subject: "S", text: "T" }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("is disabled unless development delivery is configured outside production", async () => {
    expect(notificationProviderFor(config("development"))).toBeInstanceOf(
      DevelopmentNotificationProvider,
    );
    expect(notificationProviderFor(config("disabled"))).toBeInstanceOf(
      DisabledNotificationProvider,
    );
    expect(notificationProviderFor(config("development", true))).toBeInstanceOf(
      DisabledNotificationProvider,
    );
    const fetchMock = mailpit();
    await expect(
      notificationProviderFor(config("disabled")).send({
        channel: "sms",
        recipient: "254712345678",
        subject: "S",
        text: "T",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
