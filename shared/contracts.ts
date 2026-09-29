export type Alias = "workhorse" | "reviewer" | "image";
export type Profile = "desktop" | "phone" | "reviewer" | "eval" | "ops";
export type Effort = "low" | "high";

export interface CallerRecord {
  callerId: string;
  profile: Profile;
  sha256: string;
  expiresAt: string;
  revokedAt: string | null;
  search: boolean;
  aliases: Alias[];
}

export interface ApiErrorBody {
  error: {
    type:
      | "invalid_request_error"
      | "authentication_error"
      | "permission_error"
      | "rate_limit_error"
      | "upstream_error"
      | "internal_error";
    code: string;
    message: string;
    request_id: string;
    alias?: Alias;
    retryable: boolean;
    retry_after_ms?: number;
  };
}
