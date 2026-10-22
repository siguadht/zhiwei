/**
 * [v1.0.40] PricingView — 版本 / 定价（商业化那一屏）。
 *
 * 位置：左栏 Rail「版本」→ activeView==='pricing' → 本组件。
 * 数据：GET /usage?project_id=（模型成本、成员数）+ GET /ledger?project_id=（交付物数），
 *       两个都是后端现算的只读接口。
 *
 * 版式走应用内那种（当前版本卡 + 用量条 + 一档一行），不做网页三栏大卡片：
 * 桌面窗口窄，三栏一挤就显廉价。
 *
 * 哪些数字是真的：用量那一排全是现取，一个没编。假的只有一件——「升级」这个动作，
 * 它只写本机 localStorage（knowe.plan.v1，带 source=local_mock 记号），不接支付、
 * 不锁任何功能。界面上不放 DEMO 角标；要查自己有没有升过，读那个键。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runtimeFetch } from '../shared/runtimeFetch';
import { runtimeHttpBase } from '../shared/runtimeEndpoints';
import { useKnoweStore } from '../store/store';
import { selectActiveProjectId, selectActiveConvName } from '../store/selectors';
import { PLATFORM_PROJECT_ID } from '../store/avatar';

type PlanId = 'free' | 'pro' | 'team';

const PLAN_KEY = 'knowe.plan.v1';
const PLAN_ORDER: PlanId[] = ['free', 'pro', 'team'];
/** 每档的模型成本月配额（元）。用量条只拿它当分母，不是硬闸。 */
const QUOTA_CNY: Record<PlanId, number> = { free: 200, pro: 800, team: 3000 };

function readPlan(): PlanId {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    if (!raw) return 'free';
    const parsed = JSON.parse(raw) as { plan?: string };
    return PLAN_ORDER.includes(parsed.plan as PlanId) ? (parsed.plan as PlanId) : 'free';
  } catch {
    return 'free';
  }
}

function writePlan(plan: PlanId): void {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({
      plan,
      source: 'local_mock',
      at: new Date().toISOString(),
    }));
  } catch {
    // 隐私模式写不进去就算了，页面照常显示 free
  }
}

interface UsagePayload {
  days: number;
  member_count: number;
  totals?: {
    total_tokens?: number;
    total_calls?: number;
    estimated_cost_cny?: number | null;
    priced_cost_cny?: number;
    cost_complete?: boolean;
  };
}

interface LedgerStats {
  deliverables: number;
  groups: number;
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `¥${n.toFixed(n < 10 ? 2 : 0)}`;
}

function fmtTokens(n: number | null | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export const PricingView: React.FC = () => {
  const { t } = useTranslation();
  const activeId = useKnoweStore(selectActiveProjectId);
  const projectId = activeId === PLATFORM_PROJECT_ID ? '' : activeId;
  const projectName = useKnoweStore(selectActiveConvName);

  const [plan, setPlan] = useState<PlanId>(() => readPlan());
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [stats, setStats] = useState<LedgerStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    const base = runtimeHttpBase();
    const q = `project_id=${encodeURIComponent(projectId)}`;
    try {
      const [u, l] = await Promise.all([
        runtimeFetch(`${base}/usage?${q}&days=30`),
        runtimeFetch(`${base}/ledger?${q}`),
      ]);
      if (!u.ok || !l.ok) {
        setError(`${t('pricing.errLoad')}（HTTP ${u.ok ? l.status : u.status}）`);
        setUsage(null);
        setStats(null);
        return;
      }
      const uj = (await u.json()) as UsagePayload;
      const lj = (await l.json()) as { stats?: LedgerStats };
      setUsage(uj);
      setStats(lj.stats ?? null);
    } catch (exc) {
      setError(`${t('pricing.errLoad')}（${String(exc)}）`);
      setUsage(null);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchPlan = (next: PlanId) => {
    writePlan(next);
    setPlan(next);
  };

  if (!projectId) {
    return (
      <div className="pricing">
        <div className="pricing-blank">{t('pricing.noProject')}</div>
      </div>
    );
  }

  const cost = usage?.totals?.priced_cost_cny ?? usage?.totals?.estimated_cost_cny ?? null;
  const quota = QUOTA_CNY[plan];
  const ratio = cost === null ? 0 : Math.min(1, cost / quota);
  const isTop = plan === 'team';
  const nextPlan: PlanId = plan === 'free' ? 'pro' : 'team';

  return (
    <div className="pricing">
      <div className="pricing-head">
        <span className="pricing-title">{t('pricing.nav')}</span>
        <span className="pricing-sub">{projectName}</span>
        <button className="pricing-btn" onClick={() => void load()} disabled={loading}>
          {loading ? t('pricing.loading') : t('pricing.refresh')}
        </button>
      </div>

      {error ? <div className="pricing-error">{error}</div> : null}

      <div className="pricing-current">
        <div className="pc-left">
          <div className="pc-plan">{t(`pricing.plan.${plan}`)}</div>
          <div className="pc-desc">{t(`pricing.desc.${plan}`)}</div>
          <div className="pc-meta">
            {t('pricing.seat')} {usage ? usage.member_count : '—'}
            <span className="pc-dot">·</span>
            {t('pricing.renewal')} {t(`pricing.renewal.${plan}`)}
          </div>
        </div>
        <div className="pc-right">
          <button
            className="pricing-cta"
            onClick={() => switchPlan(nextPlan)}
            disabled={isTop}
          >
            {isTop ? t('pricing.isTop') : t('pricing.upgradeTo', { plan: t(`pricing.plan.${nextPlan}`) })}
          </button>
          {plan !== 'free' ? (
            <button className="pricing-link" onClick={() => switchPlan('free')}>
              {t('pricing.cancel')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="pricing-usage">
        <div className="pu-cell">
          <span className="pu-label">{t('pricing.usage.cost')}</span>
          <span className="pu-value">{fmtMoney(cost)}</span>
        </div>
        <div className="pu-cell">
          <span className="pu-label">{t('pricing.usage.tokens')}</span>
          <span className="pu-value">{fmtTokens(usage?.totals?.total_tokens)}</span>
        </div>
        <div className="pu-cell">
          <span className="pu-label">{t('pricing.usage.calls')}</span>
          <span className="pu-value">{usage?.totals?.total_calls ?? '—'}</span>
        </div>
        <div className="pu-cell">
          <span className="pu-label">{t('pricing.usage.deliverables')}</span>
          <span className="pu-value">{stats ? stats.deliverables : '—'}</span>
        </div>
        <div className="pu-bar">
          <div className="pu-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <div className="pu-note">
          {t('pricing.usage.quota', { used: fmtMoney(cost), quota: fmtMoney(quota) })}
        </div>
      </div>

      <div className="pricing-plans">
        {PLAN_ORDER.map((id) => {
          const current = id === plan;
          return (
            <div key={id} className={'pricing-row' + (current ? ' current' : '')}>
              <div className="pr-name">
                {t(`pricing.plan.${id}`)}
                {current ? <span className="pr-tag">{t('pricing.current')}</span> : null}
              </div>
              <div className="pr-price">
                <b>{t(`pricing.price.${id}`)}</b>
                <span className="pr-unit">{t(`pricing.unit.${id}`)}</span>
              </div>
              <ul className="pr-feats">
                {([1, 2, 3, 4] as const).map((n) => (
                  <li key={n}>{t(`pricing.feat.${id}.${n}`)}</li>
                ))}
              </ul>
              <div className="pr-act">
                <button
                  className={'pricing-btn' + (current ? ' ghost' : '')}
                  onClick={() => switchPlan(id)}
                  disabled={current}
                >
                  {current ? t('pricing.current') : t('pricing.pick')}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pricing-foot">{t('pricing.foot')}</div>
    </div>
  );
};

export default PricingView;
