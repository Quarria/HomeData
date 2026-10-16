import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { apiRequest, clearCsrfToken, postJson } from "../api/client";

export interface AccountSummary {
  id: string;
  username: string;
  nickname: string;
  systemRole: "USER" | "SYSTEM_ADMIN";
  status: "ACTIVE" | "DISABLED";
  mustChangePassword: boolean;
  version: number;
}

export interface FamilySummary {
  id: string;
  name: string;
  adminAccountId: string;
  status: "ACTIVE" | "ARCHIVED";
  version: number;
  role: "ADMIN" | "MEMBER";
  members: Array<{ id: string; username: string; nickname: string }>;
}

export const useSessionStore = defineStore("session", () => {
  const account = ref<AccountSummary | null>(null);
  const family = ref<FamilySummary | null>(null);
  const isLoading = ref(true);
  const activeSpace = ref<"personal" | "family">("personal");
  const isSystemAdmin = computed(
    () => account.value?.systemRole === "SYSTEM_ADMIN",
  );

  async function refresh() {
    try {
      const me = await apiRequest<{
        account: AccountSummary;
        family: FamilySummary | null;
        mustChangePassword: boolean;
      }>("/me");
      account.value = me.account;
      family.value = me.family;
      if (!family.value) activeSpace.value = "personal";
    } catch {
      account.value = null;
      family.value = null;
      activeSpace.value = "personal";
    } finally {
      isLoading.value = false;
    }
  }

  async function login(username: string, password: string) {
    const result = await postJson<{
      account: AccountSummary;
      family: FamilySummary | null;
      mustChangePassword: boolean;
    }>("/auth/login", { username, password });
    account.value = result.account;
    await refresh();
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    await postJson("/me/password", { currentPassword, newPassword });
    await refresh();
  }

  async function logout() {
    try {
      await postJson("/auth/logout", {});
    } finally {
      clearCsrfToken();
      account.value = null;
      family.value = null;
      activeSpace.value = "personal";
    }
  }

  function setSpace(space: "personal" | "family") {
    if (space === "family" && !family.value) return;
    activeSpace.value = space;
  }

  return {
    account,
    family,
    isLoading,
    activeSpace,
    isSystemAdmin,
    refresh,
    login,
    changePassword,
    logout,
    setSpace,
  };
});
