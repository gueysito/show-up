// The QR is a short-lived capability, never a URL or an attendance receipt.
export type PersonalAttendanceQr = {
  format: "showup.attendance.qr.v1";
  eventId: string;
  credential: string;
  nonce: string;
  expiresAt: number;
};
export function personalAttendanceQr(value: unknown): PersonalAttendanceQr | null {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 1024) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join() !== "credential,eventId,expiresAt,format,nonce" ||
      parsed.format !== "showup.attendance.qr.v1" ||
      typeof parsed.eventId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.eventId,
      ) ||
      typeof parsed.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.credential) ||
      typeof parsed.nonce !== "string" ||
      !/^[0-9a-f]{64}$/.test(parsed.nonce) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      parsed.expiresAt < 0
    )
      return null;
    return parsed as PersonalAttendanceQr;
  } catch {
    return null;
  }
}
