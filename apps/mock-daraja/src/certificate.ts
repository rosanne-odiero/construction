import {
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";

/**
 * A self-signed X.509 test certificate (RSA 2048, SHA-256) built with Node's crypto and a minimal
 * DER encoder: no OpenSSL CLI, no dependency and no committed private key. The mock server uses it
 * to stand in for Safaricom's public certificate: PM-Buddy encrypts the initiator password with
 * the certificate (RSA, PKCS #1 v1.5) and the mock decrypts it with the matching private key.
 * Clearly not a Safaricom certificate (subject "PM-Buddy mock Daraja (TEST ONLY)").
 */

const tlv = (tag: number, content: Buffer): Buffer => {
  const length = content.length;
  let header: Buffer;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else {
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([header, content]);
};
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const integer = (value: Buffer) =>
  tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const nullValue = () => Buffer.from([0x05, 0x00]);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));
const bitString = (value: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const explicit = (tag: number, value: Buffer) => tlv(0xa0 + tag, value);

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const name = (commonName: string) => sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));

export type TestCertificate = {
  certificatePem: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  fingerprint256: string;
};

export function generateTestCertificate(
  commonName = "PM-Buddy mock Daraja (TEST ONLY, not Safaricom)",
  validDays = 365,
): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sha256WithRsa = sequence(oid("1.2.840.113549.1.1.11"), nullValue());
  const now = new Date();
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(7)])),
    sha256WithRsa,
    name(commonName),
    sequence(
      utcTime(new Date(now.getTime() - 60_000)),
      utcTime(new Date(now.getTime() + validDays * 86_400_000)),
    ),
    name(commonName),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(tbs, sha256WithRsa, bitString(signature));
  const body = der.toString("base64").replace(/.{64}/g, "$&\n");
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END CERTIFICATE-----\n`;
  const parsed = new X509Certificate(certificatePem);
  if (!parsed.verify(publicKey)) throw new Error("Generated test certificate does not verify");
  return { certificatePem, privateKey, publicKey, fingerprint256: parsed.fingerprint256 };
}
