import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export function token() {
  return randomBytes(32).toString("base64url");
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function identityIndex(key: string, issuer: string, subject: string) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify([issuer, subject]))
    .digest("hex");
}
export function seal(key: string, context: string, value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
export function unseal(key: string, context: string, value: string): unknown {
  const data = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8"),
  );
}
