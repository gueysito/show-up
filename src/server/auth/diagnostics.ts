export type AuthStage = "attempt" | "decrypt" | "discovery" | "exchange" | "session";

// Never log the original Error: provider causes can contain tokens and private claims.
export function authFailureDetails(stage: AuthStage, error: unknown) {
  const source = error as {
    code?: unknown;
    error?: unknown;
    cause?: {
      message?: unknown;
      claim?: unknown;
      body?: { error?: unknown };
      cause?: { claim?: unknown; body?: { error?: unknown } };
    };
  } | null;
  const codes = [
    "OAUTH_RESPONSE_BODY_ERROR",
    "OAUTH_INVALID_RESPONSE",
    "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
    "OAUTH_WWW_AUTHENTICATE_CHALLENGE",
    "OAUTH_KEY_SELECTION_FAILED",
    "OAUTH_INVALID_SERVER_METADATA",
    "OAUTH_TIMEOUT",
    "OAUTH_PARSE_ERROR",
    "23505",
    "23503",
  ];
  const oauthErrors = [
    "invalid_client",
    "invalid_grant",
    "invalid_request",
    "access_denied",
    "unauthorized_client",
    "unsupported_grant_type",
    "server_error",
  ];
  const claims = ["nonce", "aud", "iss", "exp", "iat", "azp", "sub", "auth_time"];
  const code = source?.code;
  const oauth = source?.error ?? source?.cause?.body?.error ?? source?.cause?.cause?.body?.error;
  const claim = source?.cause?.claim ?? source?.cause?.cause?.claim;
  const message = source?.cause?.message;
  const field = ["access_token", "token_type", "id_token", "expires_in", "scope"].find(
    (name) => typeof message === "string" && message.includes(`"response" body "${name}"`),
  );
  return {
    stage,
    code: typeof code === "string" && codes.includes(code) ? code : "unclassified",
    oauth: typeof oauth === "string" && oauthErrors.includes(oauth) ? oauth : "none",
    claim: typeof claim === "string" && claims.includes(claim) ? claim : "none",
    field: field ?? "none",
  };
}
