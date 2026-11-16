import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../config/app-config.js";
import {
  channelFor,
  DevelopmentNotificationProvider,
  DisabledNotificationProvider,
  notificationProviderFor,
  RealNotificationProvider,
  type Notification,
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

  const realConfig = (overrides: Record<string, unknown> = {}) =>
    ({
      isProduction: true,
      get: (name: string) =>
        ({
          AUTH_NOTIFICATION_TRANSPORT: "real",
          AFRICAS_TALKING_USERNAME: "application",
          AFRICAS_TALKING_API_KEY: "synthetic-api-key",
          AFRICAS_TALKING_SENDER_ID: "PMBuddy",
          WHATSAPP_ACCESS_TOKEN: "synthetic-token",
          WHATSAPP_PHONE_NUMBER_ID: "123456",
          WHATSAPP_GRAPH_API_VERSION: "v25.0",
          NOTIFICATION_TIMEOUT_MS: 1500,
          ...overrides,
        })[name],
    }) as unknown as AppConfig;
  const sms: Notification = {
    channel: "sms",
    recipient: "254712345678",
    subject: "Ignored subject",
    text: "Private code & +",
  };
  const whatsapp: Notification = {
    ...sms,
    channel: "whatsapp",
    whatsappTemplate: {
      approved: true,
      name: "verification_code",
      languageCode: "en_US",
      components: [
        { type: "body", parameters: [{ type: "text", text: "123456" }] },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "123456" }],
        },
      ],
    },
  };
  const smsAccepted = {
    SMSMessageData: {
      Recipients: [
        {
          number: "+254712345678",
          status: "Success",
          statusCode: 101,
          messageId: "provider-id",
        },
      ],
    },
  };
  const whatsappAccepted = { messaging_product: "whatsapp", messages: [{ id: "wamid.synthetic" }] };

  describe("Real notification acceptance (mocked network only)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("selects live transport only explicitly, including in production", () => {
      expect(notificationProviderFor(realConfig())).toBeInstanceOf(RealNotificationProvider);
      expect(
        notificationProviderFor(realConfig({ AUTH_NOTIFICATION_TRANSPORT: undefined })),
      ).toBeInstanceOf(DisabledNotificationProvider);
    });

    it("posts encoded SMS to Africa's Talking and requires matching recipient acceptance", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(smsAccepted));
      await notificationProviderFor(realConfig()).send(sms);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.africastalking.com/version1/messaging");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { apiKey: "synthetic-api-key", Accept: "application/json" },
        signal: expect.any(AbortSignal),
      });
      expect(Object.fromEntries(new URLSearchParams(init!.body as string))).toEqual({
        username: "application",
        to: "+254712345678",
        from: "PMBuddy",
        message: sms.text,
      });
    });

    it.each([
      {},
      { SMSMessageData: { Recipients: [] } },
      {
        SMSMessageData: {
          Recipients: [
            {
              ...smsAccepted.SMSMessageData.Recipients[0],
              status: "InsufficientBalance",
              statusCode: 405,
            },
          ],
        },
      },
      {
        SMSMessageData: {
          Recipients: [{ ...smsAccepted.SMSMessageData.Recipients[0], statusCode: 500 }],
        },
      },
      {
        SMSMessageData: {
          Recipients: [{ ...smsAccepted.SMSMessageData.Recipients[0], number: "+254700000000" }],
        },
      },
      {
        SMSMessageData: {
          Recipients: [{ ...smsAccepted.SMSMessageData.Recipients[0], messageId: "" }],
        },
      },
    ])("rejects SMS HTTP success without recipient acceptance: %j", async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
      await expect(notificationProviderFor(realConfig()).send(sms)).rejects.toThrow(
        "SMS provider did not confirm acceptance",
      );
    });

    it("sends only approved WhatsApp template metadata, never subject or arbitrary text", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json(whatsappAccepted));
      await notificationProviderFor(realConfig()).send(whatsapp);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://graph.facebook.com/v25.0/123456/messages");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer synthetic-token" },
        signal: expect.any(AbortSignal),
      });
      expect(JSON.parse(init!.body as string)).toEqual({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: whatsapp.recipient,
        type: "template",
        template: {
          name: "verification_code",
          language: { code: "en_US" },
          components: whatsapp.whatsappTemplate!.components,
        },
      });
      expect(init!.body).not.toContain(whatsapp.text);
      expect(init!.body).not.toContain(whatsapp.subject);
    });

    it.each([
      undefined,
      { approved: false, name: "verification_code", languageCode: "en_US" },
      { approved: true, name: "../messages", languageCode: "en_US" },
      {
        approved: true,
        name: "verification_code",
        languageCode: "en_US",
        components: [
          {
            type: "body",
            parameters: [{ type: "image", image: { link: "https://example.test" } }],
          },
        ],
      },
    ])("rejects absent/unapproved/unsupported templates before sending: %j", async (template) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      await expect(
        notificationProviderFor(realConfig()).send({
          ...whatsapp,
          whatsappTemplate: template as Notification["whatsappTemplate"],
        }),
      ).rejects.toThrow("WhatsApp requires explicit approved template metadata");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      {},
      { error: { message: "private provider error" } },
      { messaging_product: "whatsapp", messages: [] },
      { messaging_product: "whatsapp", messages: [{ id: "" }] },
      {
        messaging_product: "whatsapp",
        messages: [{ id: "id", message_status: "held_for_quality_assessment" }],
      },
    ])("rejects WhatsApp HTTP success without acceptance: %j", async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
      await expect(notificationProviderFor(realConfig()).send(whatsapp)).rejects.toThrow(
        "WhatsApp provider did not confirm acceptance",
      );
    });

    it.each([sms, whatsapp])(
      "sanitizes HTTP, malformed response and network failures for $channel",
      async (notification) => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        for (const response of [
          new Response("private response", { status: 401 }),
          new Response(null, { status: 302, headers: { Location: "https://example.test" } }),
          new Response("not JSON"),
        ]) {
          fetchMock.mockResolvedValueOnce(response);
          await expect(notificationProviderFor(realConfig()).send(notification)).rejects.toThrow(
            `${notification.channel === "sms" ? "SMS" : "WhatsApp"} provider did not confirm acceptance`,
          );
        }
        fetchMock.mockRejectedValueOnce(new Error("secret token and payload"));
        await expect(
          notificationProviderFor(realConfig()).send(notification),
        ).rejects.toMatchObject({ status: 503, cause: undefined });
      },
    );

    it("bounds requests with the configured timeout signal", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            });
          }),
      );
      const result = expect(notificationProviderFor(realConfig()).send(sms)).rejects.toThrow(
        "SMS provider did not confirm acceptance",
      );
      await vi.advanceTimersByTimeAsync(1500);
      await result;
      expect(timeout).toHaveBeenCalledWith(1500);
    });

    it.each([429, 503, "connection-reset"])(
      "surfaces an SMS outage (%s), never retries it, and accepts an explicit send after recovery",
      async (failure) => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        if (typeof failure === "number") {
          fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: failure }));
        } else {
          fetchMock.mockRejectedValueOnce(new Error("synthetic connection reset"));
        }
        fetchMock.mockResolvedValueOnce(Response.json(smsAccepted));
        const provider = notificationProviderFor(realConfig());
        await expect(provider.send(sms)).rejects.toMatchObject({ status: 503 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(provider.send(sms)).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
    );

    it("refuses email, invalid phones, empty SMS and unconfigured channels without a request", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const provider = notificationProviderFor(realConfig());
      await expect(
        provider.send({ ...sms, channel: "email", recipient: "a@example.test" }),
      ).rejects.toThrow("Email delivery is unavailable");
      for (const recipient of [
        "+254712345678",
        "a@example.test",
        "0000000000",
        "254712345678,254700000000",
      ]) {
        await expect(provider.send({ ...sms, recipient })).rejects.toMatchObject({ status: 503 });
      }
      await expect(provider.send({ ...sms, text: " " })).rejects.toMatchObject({ status: 503 });
      await expect(
        notificationProviderFor(realConfig({ AFRICAS_TALKING_API_KEY: undefined })).send(sms),
      ).rejects.toThrow("SMS delivery is not configured");
      await expect(
        notificationProviderFor(realConfig({ WHATSAPP_ACCESS_TOKEN: undefined })).send(whatsapp),
      ).rejects.toThrow("WhatsApp delivery is not configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });
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
