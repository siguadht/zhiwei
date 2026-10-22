/**
 * auth.ts — 本地账户（邮箱 + 密码）。
 *
 * 只存 PBKDF2-SHA256 派生值和随机盐，明文密码不进任何存储；没有服务端，
 * 所以「登录态」= 这台机器上这个浏览器存储里的一条记录 + 一次口令校验。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Account = {
  email: string;
  displayName: string;
  salt: string;
  hash: string;
  createdAt: number;
};

const ITERATIONS = 150_000;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => parseInt(pair, 16));

export function newSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(salt) as unknown as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    key, 256,
  );
  return toHex(new Uint8Array(bits));
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type AuthError = 'duplicate' | 'unknown' | 'badPassword' | 'weakPassword' | null;

type AuthState = {
  account: Account | null;
  signedInEmail: string | null;
  busy: boolean;
  error: AuthError;
  signUp: (email: string, password: string, displayName: string) => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => void;
  clearError: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      account: null,
      signedInEmail: null,
      busy: false,
      error: null,

      async signUp(email, password, displayName) {
        const mail = email.trim().toLowerCase();
        if (password.length < 8) {
          set({ error: 'weakPassword' });
          return false;
        }
        if (get().account?.email === mail) {
          set({ error: 'duplicate' });
          return false;
        }
        set({ busy: true, error: null });
        try {
          const salt = newSalt();
          const hash = await derive(password, salt);
          set({
            account: {
              email: mail,
              displayName: displayName.trim() || mail.split('@')[0] || mail,
              salt, hash, createdAt: Date.now(),
            },
            signedInEmail: mail,
            busy: false,
          });
          return true;
        } catch {
          set({ busy: false, error: 'unknown' });
          return false;
        }
      },

      async signIn(email, password) {
        const mail = email.trim().toLowerCase();
        const account = get().account;
        if (!account || account.email !== mail) {
          set({ error: 'unknown' });
          return false;
        }
        set({ busy: true, error: null });
        try {
          const hash = await derive(password, account.salt);
          if (hash !== account.hash) {
            set({ busy: false, error: 'badPassword' });
            return false;
          }
          set({ signedInEmail: mail, busy: false });
          return true;
        } catch {
          set({ busy: false, error: 'unknown' });
          return false;
        }
      },

      signOut() {
        set({ signedInEmail: null, error: null });
      },

      clearError() {
        if (get().error) set({ error: null });
      },
    }),
    {
      name: 'knowe-auth-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ account: state.account, signedInEmail: state.signedInEmail }),
    },
  ),
);
