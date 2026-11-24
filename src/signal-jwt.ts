/**
 * Reads the JWT from an incoming signal request. The SDK sends it as
 * `Authorization: Bearer <token>`. Body tokens are accepted only as a
 * transitional fallback for older SDK versions; no token value is logged.
 */
export function read_signal_jwt(
  c: { req: { header: (name: string) => string | undefined } },
  body: unknown,
): { token: unknown; from_body: boolean } {
  const header = c.req.header("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return { token: match?.[1], from_body: false };
  }

  const from_body =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { jwt?: unknown }).jwt
      : undefined;
  return { token: from_body, from_body: from_body !== undefined };
}
