import { constants, publicEncrypt, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateTestCertificate,
  scenarioForAmount,
  startMockDaraja,
  type MockDaraja,
} from "./index.js";

describe("mock Daraja server", () => {
  let mock: MockDaraja;
  let receiver: Server;
  let receiverUrl = "";
  const received: { path: string; body: unknown }[] = [];
  let token = "";

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${mock.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const credential = (password: string) =>
    publicEncrypt(
      {
        key: new X509Certificate(mock.certificatePem).publicKey,
        padding: constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(password),
    ).toString("base64");

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ResultCode":0,"ResultDesc":"Accepted"}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    mock = await startMockDaraja({ callbackDelayMs: 10, responseDelayMs: 200 });
    const auth = await fetch(`${mock.url}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { authorization: `Basic ${Buffer.from("key:secret").toString("base64")}` },
    });
    token = ((await auth.json()) as { access_token: string }).access_token;
  });
  afterAll(async () => {
    await mock.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  it("issues a verifiable test certificate and picks scenarios from magic amounts", () => {
    const certificate = generateTestCertificate();
    const parsed = new X509Certificate(certificate.certificatePem);
    expect(parsed.subject).toContain("TEST ONLY");
    expect(parsed.verify(certificate.publicKey)).toBe(true);
    expect(scenarioForAmount(1001)).toBe("failure");
    expect(scenarioForAmount("1003")).toBe("timeout_completed");
    expect(scenarioForAmount(250)).toBe("success");
  });

  it("refuses requests without a valid token", async () => {
    const response = await fetch(`${mock.url}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { errorCode: string }).errorCode).toBe("404.001.03");
  });

  it("accepts an STK push, checks the password and calls back asynchronously", async () => {
    const timestamp = "20261111120000";
    const result = await post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: "174379",
      Password: Buffer.from(`174379passkey${timestamp}`).toString("base64"),
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: "250",
      PartyA: "254708374149",
      PartyB: "174379",
      PhoneNumber: "254708374149",
      CallBackURL: `${receiverUrl}/stk`,
      AccountReference: "TEST-1",
      TransactionDesc: "Test",
    });
    expect(result.status).toBe(200);
    expect(result.body["ResponseCode"]).toBe("0");
    await mock.waitForCallbacks(1);
    const callback = received.find((entry) => entry.path === "/stk")!.body as {
      Body: { stkCallback: { CheckoutRequestID: string; ResultCode: number } };
    };
    expect(callback.Body.stkCallback.CheckoutRequestID).toBe(result.body["CheckoutRequestID"]);
    expect(callback.Body.stkCallback.ResultCode).toBe(0);
    const bad = await post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: "174379",
      Password: Buffer.from("nonsense").toString("base64"),
      Timestamp: timestamp,
      Amount: "1",
      PhoneNumber: "254708374149",
      CallBackURL: `${receiverUrl}/stk`,
      AccountReference: "X",
    });
    expect(bad.body["errorCode"]).toBe("500.001.1001");
  });

  it("decrypts the B2C SecurityCredential, refuses duplicate originator IDs and answers status queries", async () => {
    const body = {
      OriginatorConversationID: "pmb-test-1",
      InitiatorName: "testapi",
      SecurityCredential: credential("Safaricom999!*!"),
      CommandID: "BusinessPayment",
      Amount: "1003",
      PartyA: "600992",
      PartyB: "254705912645",
      Remarks: "Test payout",
      QueueTimeOutURL: `${receiverUrl}/timeout`,
      ResultURL: `${receiverUrl}/b2c`,
    };
    const accepted = await post("/mpesa/b2c/v3/paymentrequest", body);
    expect(accepted.body).toMatchObject({
      ResponseCode: "0",
      OriginatorConversationID: "pmb-test-1",
    });
    expect((await post("/mpesa/b2c/v3/paymentrequest", body)).body["errorCode"]).toBe(
      "500.002.1001",
    );
    const before = mock.callbacks.length;
    const status = await post("/mpesa/transactionstatus/v1/query", {
      Initiator: "testapi",
      SecurityCredential: credential("Safaricom999!*!"),
      CommandID: "TransactionStatusQuery",
      OriginalConversationID: "pmb-test-1",
      PartyA: "600992",
      IdentifierType: "4",
      ResultURL: `${receiverUrl}/status`,
      QueueTimeOutURL: `${receiverUrl}/timeout`,
      Remarks: "check",
    });
    expect(status.body["ResponseCode"]).toBe("0");
    await mock.waitForCallbacks(before + 1);
    const answer = received.find((entry) => entry.path === "/status")!.body as {
      Result: { ResultParameters: { ResultParameter: { Key: string; Value?: unknown }[] } };
    };
    const parameters = answer.Result.ResultParameters.ResultParameter;
    expect(parameters.find((entry) => entry.Key === "TransactionStatus")?.Value).toBe("Completed");
    expect(parameters.find((entry) => entry.Key === "Amount")?.Value).toBe("1003");
    // A credential that does not decrypt to a plausible password fails with 2001.
    const wrong = await post("/mpesa/b2c/v3/paymentrequest", {
      ...body,
      OriginatorConversationID: "pmb-test-2",
      Amount: "250",
      SecurityCredential: credential("wrong-password"),
    });
    expect(wrong.body["ResponseCode"]).toBe("0");
    await mock.waitForCallbacks(before + 2);
    const failure = received.filter((entry) => entry.path === "/b2c").at(-1)!.body as {
      Result: { ResultCode: number | string };
    };
    expect(String(failure.Result.ResultCode)).toBe("2001");
  });
});
