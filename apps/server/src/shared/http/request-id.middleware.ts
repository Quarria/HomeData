import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { requestContext } from "./request-context.js";

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    request: { headers: Record<string, string | string[] | undefined> },
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ) {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    request.headers["x-request-id"] = requestId;
    requestContext.run({ requestId }, next);
  }
}
