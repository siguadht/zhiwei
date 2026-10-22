/**
 * PrimaryLanguageModule.tsx — [v1.0.21.3] 选择主要语言模块
 *
 * 挂载点（两处共用）：
 *   ① 设置 → 模型与提供方 界面上方（SettingsView ModelsPane）
 *   ② 登录页底部（LoginView）
 *
 * 交互（两种形态）：
 *   · 完整模式（设置页）：选择语言 → 不立即生效 → 点【确认】才生效（二次点击）。
 *     设置页里语言只是众多字段之一，误点代价大，所以留一道确认。
 *   · 紧凑模式（登录页脚）：点语言**立即切换**，没有确认按钮。
 *     那一屏除了登录没有别的操作，二次确认只是把工程上的谨慎摊到用户脸上；
 *     并且它原来是一块实心墨底按钮，跟登录键抢重点（v1.0.43 布局 A：整页只留一处强调）。
 * 生效动作：
 *   1. useSettingsStore.setLanguage(lang)   —— 本地 state（含对账）
 *   2. i18n.changeLanguage(lang)            —— 前端全界面热切换
 *   3. pushToBackend()                      —— 持久化到 settings.json
 *
 * 多语言扩展：选项来自 LANGUAGES 配置（src/i18n），新增语言加配置即可，本组件零改动。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { LANGUAGES, normalizeLanguage } from '../i18n';
import { useSettingsStore } from '../store/settings';

interface Props {
  /** 紧凑模式（首启卡）：无标题、更小间距 */
  compact?: boolean;
}

const PrimaryLanguageModule: React.FC<Props> = ({ compact = false }) => {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const pushToBackend = useSettingsStore((s) => s.pushToBackend);

  // 本地草稿：选择后不立即生效，Apply 才提交
  const [draft, setDraft] = useState<string>(normalizeLanguage(language));
  const [applying, setApplying] = useState(false);

  const current = normalizeLanguage(language);
  const applyLanguage = async (code: string) => {
    if (code === current) return; // 未变化不动作
    setApplying(true);
    try {
      setLanguage(code);
      await i18n.changeLanguage(code);
      await pushToBackend();
    } finally {
      setApplying(false);
    }
  };

  // 紧凑档：「中文 (Chinese)」这类全称在页脚太长，去掉括号部分即可。
  const shortLabel = (label: string) => label.replace(/\s*\([^)]*\)\s*/, '').trim() || label;

  if (compact) {
    return (
      <section className="plm plm-compact" role="group" aria-label={t('primaryLanguage.title')}>
        <span className="plm-cap">{t('primaryLanguage.compact')}</span>
        {LANGUAGES.map((lang, idx) => (
          <React.Fragment key={lang.code}>
            {idx > 0 && <span className="plm-sep" aria-hidden />}
            <button
              type="button"
              className={'plm-link' + (current === lang.code ? ' on' : '')}
              aria-pressed={current === lang.code}
              disabled={applying}
              onClick={() => void applyLanguage(lang.code)}
            >
              {shortLabel(lang.label)}
            </button>
          </React.Fragment>
        ))}
      </section>
    );
  }

  return (
    <section className="plm">
      <h3 className="plm-title">{t('primaryLanguage.title')}</h3>
      <div className="plm-options" role="radiogroup" aria-label={t('primaryLanguage.title')}>
        {LANGUAGES.map((lang) => (
          <label key={lang.code} className={`plm-option${draft === lang.code ? ' plm-active' : ''}`}>
            <input
              type="radio"
              name="primary-language"
              value={lang.code}
              checked={draft === lang.code}
              onChange={() => setDraft(lang.code)}
            />
            <span>{lang.label}</span>
          </label>
        ))}
      </div>
      <div className="plm-actions">
        <button
          type="button"
          className="plm-apply"
          disabled={applying || draft === current}
          onClick={() => void applyLanguage(draft)}
        >
          {t('primaryLanguage.apply')}
        </button>
        <p className="plm-hint">{t('primaryLanguage.hint')}</p>
      </div>
    </section>
  );
};

export default PrimaryLanguageModule;
