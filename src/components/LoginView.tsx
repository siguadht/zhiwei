/**
 * LoginView.tsx — 登录 / 注册（本地账户）。
 *
 * 版式取自真实产品实测：Notion 表单宽 360、Linear 288，标题 18~22px 中等字重，
 * 邮箱在前密码在后，主按钮占满表单宽。不做左品牌右表单那种企业站结构。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EMAIL_RE, useAuthStore } from '../store/auth';
import PrimaryLanguageModule from './PrimaryLanguageModule';
import './login.css';

const ERROR_KEY: Record<string, string> = {
  duplicate: 'login.err.duplicate',
  unknown: 'login.err.unknown',
  badPassword: 'login.err.password',
  weakPassword: 'login.err.weak',
};

export const LoginView: React.FC = () => {
  const { t } = useTranslation();
  const account = useAuthStore((s) => s.account);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const signUp = useAuthStore((s) => s.signUp);
  const signIn = useAuthStore((s) => s.signIn);
  const clearError = useAuthStore((s) => s.clearError);

  const [mode, setMode] = useState<'in' | 'up'>(() => (account ? 'in' : 'up'));
  const [email, setEmail] = useState(account?.email ?? '');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');

  const canSubmit = EMAIL_RE.test(email.trim()) && password.length > 0 && !busy;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit) return;
    const ok = mode === 'in'
      ? await signIn(email, password)
      : await signUp(email, password, nickname);
    if (ok) setPassword('');
  };

  return (
    <div className="lg-scrim" role="dialog" aria-modal="true" aria-label={t('login.aria')}>
      <form className="lg-card" onSubmit={submit}>
        {/* 品牌位：形象图标（public/brand/app-icon.png）+ 文字锁标 */}
        <div className="lg-word">
          <img className="lg-mark" src="./brand/app-icon.png" alt="" />
          <span className="wm-zh">{t('common.19')}</span>
          <i className="wm-bar" aria-hidden />
          <span className="wm-en">{t('common.brand')}</span>
        </div>
        <h1 className="lg-title">
          {mode === 'in' ? t('login.title.in') : t('login.title.up')}
        </h1>
        <p className="lg-sub">{t('login.sub')}</p>

        <label className="lg-field">
          <span className="lg-label">{t('login.email')}</span>
          <input
            type="email"
            autoComplete="username"
            placeholder={t('login.email.ph')}
            value={email}
            onChange={(e) => { setEmail(e.target.value); clearError(); }}
          />
        </label>

        {mode === 'up' && (
          <label className="lg-field">
            <span className="lg-label">{t('login.nick')}</span>
            <input
              type="text"
              autoComplete="nickname"
              placeholder={t('login.nick.ph')}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>
        )}

        <label className="lg-field">
          <span className="lg-label">{t('login.password')}</span>
          <input
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            placeholder={mode === 'in' ? t('login.password.ph') : t('login.password.ph.up')}
            value={password}
            onChange={(e) => { setPassword(e.target.value); clearError(); }}
          />
        </label>

        {error && <p className="lg-err">{t(ERROR_KEY[error] ?? 'login.err.unknown')}</p>}

        <button type="submit" className="lg-submit" disabled={!canSubmit}>
          {busy ? t('login.busy') : (mode === 'in' ? t('login.cta.in') : t('login.cta.up'))}
        </button>

        <button
          type="button"
          className="lg-switch"
          onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); clearError(); }}
        >
          {mode === 'in' ? t('login.switch.up') : t('login.switch.in')}
        </button>

        <div className="lg-foot">
          <PrimaryLanguageModule compact />
        </div>
      </form>
    </div>
  );
};

export default LoginView;
