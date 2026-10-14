/** Secret-free credential modes captured by a prepared agent runtime. */
export type PreparedAgentCredentialMode =
  | "api_key"
  | "oauth"
  | "token"
  | Readonly<{
      source: "native";
      mode: "api_key" | "oauth" | "token";
      readiness?: "configured" | "unknown" | "missing";
      message?: string;
    }>;

export type PreparedAgentCredentialModes = Readonly<Record<string, PreparedAgentCredentialMode>>;
