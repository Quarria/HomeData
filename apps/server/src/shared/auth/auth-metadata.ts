import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "homedata.public";
export const ALLOW_PASSWORD_CHANGE_KEY = "homedata.allow-password-change";
export const SYSTEM_ADMIN_KEY = "homedata.system-admin";
export const MINIPROGRAM_LOGIN_KEY = "homedata.miniprogram-login";

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const AllowPasswordChange = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_KEY, true);
export const SystemAdmin = () => SetMetadata(SYSTEM_ADMIN_KEY, true);
export const MiniprogramLogin = () => SetMetadata(MINIPROGRAM_LOGIN_KEY, true);
