// Everything la-mcp hands out in OAuth (client ids, sign-in requests, codes, access and refresh tokens) is sealed with
// AES-256-GCM instead of being stored: Vercel functions keep no memory between requests. The token kind is bound as
// associated data, so one kind can never be used as another. Rotating MCP_TOKEN_SECRET invalidates everything.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type SealKind = "client" | "request" | "code" | "access" | "refresh";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, private readonly now: () => number = Date.now) {
    if (secret.length < 32) throw new Error("MCP_TOKEN_SECRET must be at least 32 characters.");
    this.key = Buffer.from(hkdfSync("sha256", secret, "la-mcp", "seal-v1", 32));
  }

  /** ttlSec 0 = never expires (client registrations). */
  seal(kind: SealKind, payload: unknown, ttlSec: number): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(kind));
    const body = JSON.stringify({ e: ttlSec > 0 ? this.now() + ttlSec * 1000 : 0, p: payload });
    const ct = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
  }

  /** null for anything forged, changed, of another kind, or expired. */
  unseal<T>(kind: SealKind, token: string): T | null {
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length <= IV_BYTES + TAG_BYTES) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(kind));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
      const { e, p } = JSON.parse(body) as { e: number; p: T };
      if (e !== 0 && this.now() >= e) return null;
      return p;
    } catch {
      return null;
    }
  }
}
