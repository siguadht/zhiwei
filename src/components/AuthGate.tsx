/**
 * AuthGate.tsx — 登录闸门 + 模型未就绪横幅。
 *
 * 没登录时只有登录页；登录后主模型没配好，只在顶部挂一条可关的横幅把人引到
 * 「设置 → 模型与提供方」，不糊住整屏。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuthStore } from '../store/auth';
import { useKnoweStore } from '../store/store';
import { selectActiveView } from '../store/selectors';
import { useSettingsStore } from '../store/settings';
import LoginView from './LoginView';

export const AuthGate: React.FC = () => {
  const { t } = useTranslation();
  const signedIn = useAuthStore((s) => s.signedInEmail);
  const mainModel = useSettingsStore((s) => s.mainModel);
  const view = useKnoweStore(selectActiveView);
  const setView = useKnoweStore((s) => s.setView);
  const [dismissed, setDismissed] = useState(false);

  if (!signedIn) return <LoginView />;

  const ready = !!mainModel?.sealed;
  if (ready || dismissed || view === 'settings') return null;

  return (
    <div className="mrb" role="status">
      <span><b>{t('model.banner.title')}</b>{t('model.banner.body')}</span>
      <button
        type="button"
        className="mrb-cta"
        onClick={() => { setView('settings'); setDismissed(true); }}
      >
        {t('model.banner.cta')}
      </button>
      <button type="button" className="mrb-x" aria-label={t('model.banner.close')}
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
};

export default AuthGate;
