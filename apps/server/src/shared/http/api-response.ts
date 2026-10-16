import type { AuthenticatedRequest } from "../auth/auth-types.js";

export function apiSuccess<T>(request: AuthenticatedRequest, data: T) {
  const requestId = request.headers["x-request-id"];
  return {
    data,
    meta: { requestId: typeof requestId === "string" ? requestId : null },
  };
}

export function parseBody<T>(
  schema: {
    safeParse: (input: unknown) =>
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: Array<{ path: PropertyKey[]; message: string }> };
        };
  },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = Object.fromEntries(
      result.error.issues.map((issue) => [issue.path.join("."), issue.message]),
    );
    const error = new Error("REQUEST_VALIDATION_FAILED") as Error & {
      status: number;
      code: string;
      fields: Record<string, string>;
    };
    error.status = 422;
    error.code = "REQUEST_VALIDATION_FAILED";
    error.fields = fields;
    throw error;
  }
  return result.data;
}
