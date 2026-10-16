import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SYSTEM_ADMIN_KEY } from "./auth-metadata.js";
import type { AuthenticatedRequest } from "./auth-types.js";

@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<boolean>(
      SYSTEM_ADMIN_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.account?.systemRole !== "SYSTEM_ADMIN") {
      throw new ForbiddenException({ code: "SYSTEM_ADMIN_REQUIRED" });
    }
    return true;
  }
}
