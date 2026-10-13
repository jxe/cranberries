// A passkey device in software, for tests: it keeps a private key and answers
// challenges the way a browser and its authenticator would, in the JSON form
// a page posts to the server.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest();
// Just enough CBOR for an attestation: small integers, bytes, text and maps.
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number")
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string")
    return Buffer.concat([
      head(3, Buffer.byteLength(value)),
      Buffer.from(value),
    ]);
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), value]);
  const entries = [...(value as Map<unknown, unknown>)];
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}
export function authenticator(origin: string) {
  const rpId = new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const id = randomBytes(16);
  const clientData = (type: string, challenge: string, from = origin) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin: from, crossOrigin: false }),
    );
  // The site's hash, then "someone was present and verified", then a counter.
  const authData = (flags: number, rest: Buffer[] = []) =>
    Buffer.concat([sha256(rpId), Buffer.from([flags, 0, 0, 0, 0]), ...rest]);
  const common = {
    id: b64(id),
    rawId: b64(id),
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
  return {
    id: b64(id),
    // Makes the passkey: its public key, attested by nobody.
    create(options: { challenge: string }) {
      const key = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, "base64url")],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ]),
      );
      const data = authData(0x45, [
        Buffer.alloc(16),
        Buffer.from([0, id.length]),
        id,
        key,
      ]);
      return {
        ...common,
        response: {
          clientDataJSON: b64(clientData("webauthn.create", options.challenge)),
          attestationObject: b64(
            cbor(
              new Map<string, unknown>([
                ["fmt", "none"],
                ["attStmt", new Map()],
                ["authData", data],
              ]),
            ),
          ),
          transports: ["internal"],
        },
      };
    },
    // Uses it: a signature over the site, the challenge and where it was asked.
    get(options: { challenge: string }, from = origin) {
      const client = clientData("webauthn.get", options.challenge, from);
      const data = authData(0x05);
      return {
        ...common,
        response: {
          clientDataJSON: b64(client),
          authenticatorData: b64(data),
          signature: b64(
            sign("sha256", Buffer.concat([data, sha256(client)]), privateKey),
          ),
        },
      };
    },
  };
}
