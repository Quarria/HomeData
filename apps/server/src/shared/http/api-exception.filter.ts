import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { AppLogger } from "../logging/app-logger.js";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new AppLogger();

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<{
      url: string;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const response = http.getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const requestId = request.headers["x-request-id"];

    if (
      exception instanceof HttpException &&
      request.url.startsWith("/api/v1/health/")
    ) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof exception === "object" &&
            exception !== null &&
            "status" in exception
          ? Number(exception.status)
          : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : "Unknown server error",
        "ApiExceptionFilter",
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    const rawResponse =
      exception instanceof HttpException ? exception.getResponse() : exception;
    const raw =
      typeof rawResponse === "object" && rawResponse !== null
        ? rawResponse
        : {};
    const code =
      status >= 500
        ? "INTERNAL_ERROR"
        : typeof raw === "object" &&
            "code" in raw &&
            typeof raw.code === "string"
          ? raw.code
          : typeof exception === "object" &&
              exception !== null &&
              "code" in exception &&
              typeof exception.code === "string"
            ? exception.code
            : status === 401
              ? "AUTH_REQUIRED"
              : status === 403
                ? "FORBIDDEN"
                : status === 422
                  ? "REQUEST_VALIDATION_FAILED"
                  : status === 409
                    ? "STATE_CONFLICT"
                    : "INTERNAL_ERROR";
    const message =
      status >= 500
        ? "服务器暂时无法处理请求"
        : typeof raw === "object" && "message" in raw
          ? raw.message
          : exception instanceof Error && status < 500
            ? exception.message
            : "请求失败";
    const fields =
      typeof raw === "object" && "fields" in raw
        ? raw.fields
        : typeof exception === "object" &&
            exception !== null &&
            "fields" in exception
          ? exception.fields
          : undefined;

    response.status(status).json({
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
        retryable: status >= 500,
      },
      meta: { requestId: typeof requestId === "string" ? requestId : null },
    });
  }
}
