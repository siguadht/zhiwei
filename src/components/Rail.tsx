/**
 * Rail.tsx — 左栏下半段的台面入口（[v1.0.41] 起它不再是独立的一根图标条）
 *
 * DOM：nav.rail > .rail-group×N（.rail-grp 分组标题 + button.rail-btn(.active)）> 外观 / 设置
 *
 * 位置：App.tsx 的 .navcol 里，排在 ConvList 下面，两者合成一栏（247–287px 是真站实测宽度）。
 *
 * 数据：selectActiveView + setView（唯一入口）。
 * 变更点（都对着真站量的）：
 *   · 去掉搜索按钮——ConvList 顶部本来就有一个可用的搜索框，一栏里两个搜索入口是重复；
 *     命令面板仍走 Cmd/Ctrl+K（见 GlobalSearch.tsx）。
 *   · 选中态不再用强调色，改成灰底 + 加粗：AionUi 左栏导航完全不上饱和色，
 *     颜色只留给「新建项目」这一个主按钮。
 *   · 去掉顶部头像：它原本只是「设置」的第二个入口，和会话列的 wordmark 挤在一起。
 */

import React from 'react';
import { useKnoweStore } from '../store/store';
import { selectActiveView } from '../store/selectors';
import { useSettingsStore } from '../store/settings';
import {
  IconContacts, IconFavorites,
  IconChart, IconKnowledge, IconReport, IconSettings, IconTag,
  IconMoon, IconSun,
} from './icons';
import { useTranslation } from 'react-i18next';

interface RailItem {
  view: string;
  label: string;
  icon: React.ReactNode;
}

export const Rail: React.FC = () => {
  const { t } = useTranslation();
  const activeView = useKnoweStore(selectActiveView);
  const setView = useKnoweStore((s) => s.setView);

  // 分组按「谁付钱看的」和「谁干活的」分，不按开发模块分——台账/版本/看板都是消耗与产出的账。
  const GROUPS: { key: string; label: string; items: RailItem[] }[] = [
    {
      key: 'workspace',
      label: t('rail.grp.workspace'),
      items: [
        { view: 'ledger', label: t('ledger.nav'), icon: <IconReport /> },
        { view: 'pricing', label: t('pricing.nav'), icon: <IconTag /> },
        { view: 'dashboard', label: t('dash.nav'), icon: <IconChart /> },
      ],
    },
    {
      key: 'team',
      label: t('rail.grp.team'),
      items: [
        { view: 'contacts', label: t('contacts.view.29'), icon: <IconContacts /> },
        { view: 'knowledge', label: t('knowledge.view.06'), icon: <IconKnowledge /> },
        { view: 'favorites', label: t('common.09'), icon: <IconFavorites /> },
      ],
    },
  ];

  /*
   * [v0.44 设置 §2.1] 外观切换：浅色显示月牙（意为「可切到深色」），深色显示太阳。
   * [v0.44] 头像/称呼的入口只剩底部这一行「设置」，不再在栏顶重复一个头像。
   */
  const appearance = useSettingsStore((s) => s.appearance);
  const setAppearance = useSettingsStore((s) => s.setAppearance);

  return (
    <nav className="rail">
      {GROUPS.map((grp) => (
        <div key={grp.key} className="rail-group">
          <div className="rail-grp">{grp.label}</div>
          {grp.items.map((it) => (
            <button
              key={it.view}
              className={'rail-btn' + (activeView === it.view ? ' active' : '')}
              data-view={it.view}
              aria-label={it.label}
              aria-pressed={activeView === it.view}
              onClick={() => setView(it.view)}
            >
              <span className="rail-ic">{it.icon}</span>
              <span className="rail-txt">{it.label}</span>
            </button>
          ))}
        </div>
      ))}

      <button
        className="rail-btn"
        data-view="appearance"
        aria-label={t('rail.01')}
        onClick={() => setAppearance(appearance === 'dark' ? 'light' : 'dark')}
      >
        <span className="rail-ic">{appearance === 'dark' ? <IconSun /> : <IconMoon />}</span>
        <span className="rail-txt">{t('rail.01')}</span>
      </button>

      <button
        className={'rail-btn' + (activeView === 'settings' ? ' active' : '')}
        data-view="settings"
        aria-label={t('common.12')}
        aria-pressed={activeView === 'settings'}
        onClick={() => setView('settings')}
      >
        <span className="rail-ic"><IconSettings /></span>
        <span className="rail-txt">{t('common.12')}</span>
      </button>
    </nav>
  );
};

export default Rail;
