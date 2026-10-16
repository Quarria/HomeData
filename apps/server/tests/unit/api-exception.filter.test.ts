import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ApiExceptionFilter } from "../../src/shared/http/api-exception.filter.js";

describe("API exception filter", () => {
  it("does not expose internal error details for server failures", () => {
    let statusCode = 0;
    let responseBody: unknown;
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          url: "/api/v1/private",
          headers: { "x-request-id": "request-test" },
        }),
        getResponse: () => ({
          status(code: number) {
            statusCode = code;
            return {
              json(body: unknown) {
                responseBody = body;
              },
            };
          },
        }),
      }),
    } as unknown as ArgumentsHost;

    new ApiExceptionFilter().catch(
      new Error("database password and SQL must stay private"),
      host,
    );

    expect(statusCode).toBe(500);
    expect(responseBody).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器暂时无法处理请求",
        retryable: true,
      },
      meta: { requestId: "request-test" },
    });
  });
});
