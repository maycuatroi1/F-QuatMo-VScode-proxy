export async function verifyTokenSignatureOnly(
  token: string,
  secretStr: string,
): Promise<any | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretStr),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sig = Buffer.from(sigB64, "base64url");
    const data = new TextEncoder().encode(headerB64 + "." + payloadB64);
    const isValid = await crypto.subtle.verify("HMAC", key, sig, data);
    if (!isValid) return null;
    return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
