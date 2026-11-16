export interface NfcTransport {
  isSupported(): Promise<boolean>;
  start(): Promise<unknown>;
  isEnabled(): Promise<boolean>;
  request(): Promise<unknown>;
  token(): Promise<string>;
  cancel(): Promise<unknown>;
}

export class NfcReader {
  private session: { cancelled: boolean; requested: boolean } | null = null;
  private transport: NfcTransport;
  private platform: "android" | "ios";
  private timeoutMs: number;

  constructor(transport: NfcTransport, platform: "android" | "ios", timeoutMs = 30_000) {
    this.transport = transport;
    this.platform = platform;
    this.timeoutMs = timeoutMs;
  }

  async read(): Promise<string> {
    if (this.session) throw new Error("NFC scan already active.");
    const session = { cancelled: false, requested: false };
    this.session = session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const assertActive = () => {
      if (session.cancelled) throw new Error("NFC scan cancelled. Retry or use QR.");
    };
    try {
      if (!(await this.transport.isSupported()))
        throw new Error("NFC hardware is not supported on this device. Use QR.");
      assertActive();
      await this.transport.start();
      assertActive();
      if (this.platform === "android" && !(await this.transport.isEnabled()))
        throw new Error("NFC is disabled. Enable it in Android settings or use QR.");
      assertActive();
      session.requested = true;
      return await Promise.race([
        (async () => {
          await this.transport.request();
          assertActive();
          const token = await this.transport.token();
          assertActive();
          return token;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            session.cancelled = true;
            reject(new Error("NFC timed out. Retry or use QR."));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      session.cancelled = true;
      clearTimeout(timer);
      try {
        if (session.requested) await this.transport.cancel();
      } finally {
        this.session = null;
      }
    }
  }

  async cancel(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.cancelled = true;
    if (session.requested) await this.transport.cancel();
  }
}
