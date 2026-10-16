import type { Account } from "../../../prisma/generated/client/client.js";

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  ip?: string;
  account?: Account;
  sessionId?: string;
}
