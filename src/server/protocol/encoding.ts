const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Public byte encoding only. Signature verification uses Node's native crypto.
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length > 128) throw new Error("Oversized public encoding");
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let result = "";
  while (value) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

export function decodeBase58(encoded: string, length: number): Buffer {
  if (!encoded || encoded.length > 180 || length > 128) throw new Error("Invalid public encoding");
  let value = 0n;
  for (const character of encoded) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid public encoding");
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = value === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  const zeros = encoded.length - encoded.replace(/^1+/, "").length;
  const result = Buffer.concat([Buffer.alloc(zeros), bytes]);
  if (result.length !== length || encodeBase58(result) !== encoded)
    throw new Error("Wrong public encoding length");
  return result;
}
