/**
 * EmptyState.tsx — 未选会话时的欢迎态（component-tree §G · EmptyChat）
 *
 * [v1.0.41.2 重做] 原来这里只有一枚图标 + 一句「选择一个项目开始」+「新建一个项目」，
 * 窗口打开就是一片白，用户站在门口不知道往里走还是往外走。现在换成能动手的欢迎页：
 * 一句要什么结果 + 三个起手示例（点了填进输入框），走的就是原来的新建项目弹窗，
 * 没有新造任何未接线的动作。
 *
 * DOM：.empty.enter.welcome > (.wl-mark > svg) + h2.wl-title + p.wl-sub
 *                              + .wl-box(input.wl-input + button.wl-go)
 *                              + .wl-grp + .wl-cards > button.wl-card × 3
 *
 * 起手示例写的是后端真跑通过的水准（中文 pptx / docx / xlsx 各验过一次），
 * 不是想象出来的能力清单。
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconEmptyMark } from './icons';
import NewProjectModal from './NewProjectModal';

/** 起手示例：text 填进输入框当项目名，kind 只说明「这类活通常交出什么文件」。 */
const SEEDS: { key: string; kindKey: string }[] = [
  { key: 'welcome.seed.1', kindKey: 'welcome.seed.1.kind' },
  { key: 'welcome.seed.2', kindKey: 'welcome.seed.2.kind' },
  { key: 'welcome.seed.3', kindKey: 'welcome.seed.3.kind' },
];

export const EmptyState: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');

  const start = (): void => setOpen(true);

  return (
    <>
      <div className="empty enter welcome">
        <div className="wl-mark">
          <IconEmptyMark />
        </div>
        <h2 className="wl-title">{t('welcome.title')}</h2>
        <p className="wl-sub">{t('welcome.sub')}</p>

        <div className="wl-box">
          <input
            className="wl-input"
            type="text"
            value={goal}
            placeholder={t('welcome.placeholder')}
            aria-label={t('welcome.title')}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') start(); }}
          />
          <button type="button" className="wl-go" onClick={start}>
            {t('welcome.go')}
          </button>
        </div>

        <div className="wl-grp">{t('welcome.seeds')}</div>
        <div className="wl-cards">
          {SEEDS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="wl-card"
              onClick={() => setGoal(t(s.key))}
            >
              <span className="wl-card-t">{t(s.key)}</span>
              <span className="wl-card-k">{t(s.kindKey)}</span>
            </button>
          ))}
        </div>
      </div>
      <NewProjectModal open={open} onClose={() => setOpen(false)} initialName={goal.trim()} />
    </>
  );
};

export default EmptyState;
