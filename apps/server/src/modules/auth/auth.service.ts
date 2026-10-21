import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../shared/database/prisma.service.js";
import { hashPassword, verifyPassword } from "../../shared/auth/password.js";
import type { AccountSummary } from "@homedata/contracts";

const SESSION_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function normalizeUsername(username: string) {
  return username.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function accountSummary(account: {
  id: string;
  username: string;
  nickname: string;
  gender: "MALE" | "FEMALE" | "UNSPECIFIED";
  systemRole: "USER" | "SYSTEM_ADMIN";
  status: "ACTIVE" | "DISABLED";
  mustChangePassword: boolean;
  version: number;
}): AccountSummary {
  return {
    id: account.id,
    username: account.username,
    nickname: account.nickname,
    gender: account.gender,
    systemRole: account.systemRole,
    status: account.status,
    mustChangePassword: account.mustChangePassword,
    version: account.version,
  };
}

function attemptKey(username: string, ip: string) {
  return createHash("sha256").update(`${ip}\0${username}`).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private checkRateLimit(key: string) {
    const now = Date.now();
    const current = attempts.get(key);
    if (
      current &&
      current.resetAt > now &&
      current.count >= MAX_LOGIN_ATTEMPTS
    ) {
      throw new HttpException(
        { code: "LOGIN_RATE_LIMITED" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private recordAttempt(key: string, success: boolean) {
    if (success) {
      attempts.delete(key);
      return;
    }
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    } else {
      current.count += 1;
    }
  }

  async login(username: string, password: string, ip: string) {
    const normalized = normalizeUsername(username);
    const key = attemptKey(normalized, ip);
    this.checkRateLimit(key);
    const account = await this.prisma.account.findUnique({
      where: { usernameNormalized: normalized },
    });
    const valid = account
      ? await verifyPassword(account.passwordHash, password).catch(() => false)
      : await hashPassword(password).then(() => false);
    if (!account || !valid || account.status !== "ACTIVE") {
      this.recordAttempt(key, false);
      throw new UnauthorizedException({ code: "AUTH_INVALID_CREDENTIALS" });
    }

    this.recordAttempt(key, true);
    const rawToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const session = await this.prisma.session.create({
      data: {
        accountId: account.id,
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
        authVersion: account.authVersion,
        expiresAt: new Date(now.getTime() + SESSION_LENGTH_MS),
      },
    });
    return {
      rawToken,
      sessionId: session.id,
      account: accountSummary(account),
    };
  }

  async logout(sessionId: string) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(
    accountId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (
      !account ||
      account.status !== "ACTIVE" ||
      !(await verifyPassword(account.passwordHash, currentPassword).catch(
        () => false,
      ))
    ) {
      throw new UnauthorizedException({ code: "CURRENT_PASSWORD_INVALID" });
    }
    if (
      await verifyPassword(account.passwordHash, newPassword).catch(() => false)
    ) {
      throw new ConflictException({ code: "PASSWORD_UNCHANGED" });
    }

    const passwordHash = await hashPassword(newPassword);
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.account.update({
        where: { id: accountId, version: account.version },
        data: {
          passwordHash,
          mustChangePassword: false,
          authVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await tx.session.updateMany({
        where: { accountId, revokedAt: null },
        data: { revokedAt: now },
      });
      const newSession = await tx.session.create({
        data: {
          accountId,
          tokenHash,
          authVersion: current.authVersion,
          expiresAt: new Date(now.getTime() + SESSION_LENGTH_MS),
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: accountId,
          action: "ACCOUNT_PASSWORD_CHANGED",
          subjectType: "ACCOUNT",
          subjectId: accountId,
        },
      });
      return { account: accountSummary(current), sessionId: newSession.id };
    });
    return { ...updated, rawToken };
  }
}
