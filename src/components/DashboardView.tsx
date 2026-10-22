/**
 * [v1.0.40] DashboardView — 经营看板（只读）。
 *
 * 位置：左栏 Rail「看板」→ activeView==='dashboard' → 本组件。
 * 数据：GET /usage（成本/tokens/调用/按天/按岗位）+ GET /ledger（交付物与质检结论）。
 *   成本口径和 Token 面板、版本页完全一致：同一个 aggregate_token_usage。
 *   三个地方同一个数，才对得上账。
 *
 * 没有图表库，柱子就是一根 div 按比例撑高——看板要的是数，不是动效。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runtimeFetch } from '../shared/runtimeFetch';
import { runtimeHttpBase } from '../shared/runtimeEndpoints';
import { useKnoweStore } from '../store/store';
import { selectActiveProjectId, selectActiveConvName } from '../store/selectors';
import { PLATFORM_PROJECT_ID } from '../store/avatar';

interface DailyRow {
  date: string;
  total_tokens: number;
  calls: number;
}

interface AgentRow {
  agent_id: string;
  role: string;
  total_tokens: number;
  calls: number;
  cost_cny: number;
}

interface UsagePayload {
  days: number;
  member_count: number;
  totals?: {
    total_tokens?: number;
    total_calls?: number;
    estimated_cost_cny?: number | null;
    priced_cost_cny?: number;
  };
  daily?: DailyRow[];
  by_agent?: AgentRow[];
}

interface LedgerGroup {
  name: string;
  ext: string;
  version_count: number;
  rework_rounds: number;
  latest_verdict?: string | null;
}

interface LedgerPayload {
  stats?: { deliverables: number; groups: number; with_provenance: number; orphans: string[] };
  groups?: LedgerGroup[];
}

const RANGES = [7, 30, 365] as const;

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

function fmtDay(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}` : iso;
}

export const DashboardView: React.FC = () => {
  const { t } = useTranslation();
  const activeId = useKnoweStore(selectActiveProjectId);
  const projectId = activeId === PLATFORM_PROJECT_ID ? '' : activeId;
  const projectName = useKnoweStore(selectActiveConvName);

  const [days, setDays] = useState<number>(30);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [ledger, setLedger] = useState<LedgerPayload | null>(null);
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
        runtimeFetch(`${base}/usage?${q}&days=${days}`),
        runtimeFetch(`${base}/ledger?${q}`),
      ]);
      if (!u.ok || !l.ok) {
        setError(`${t('dash.errLoad')}（HTTP ${u.ok ? l.status : u.status}）`);
        return;
      }
      setUsage((await u.json()) as UsagePayload);
      setLedger((await l.json()) as LedgerPayload);
    } catch (exc) {
      setError(`${t('dash.errLoad')}（${String(exc)}）`);
    } finally {
      setLoading(false);
    }
  }, [projectId, days, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!projectId) {
    return (
      <div className="dash">
        <div className="dash-blank">{t('dash.noProject')}</div>
      </div>
    );
  }

  const cost = usage?.totals?.priced_cost_cny ?? usage?.totals?.estimated_cost_cny ?? null;
  const daily = usage?.daily ?? [];
  const maxTokens = daily.reduce((m, d) => Math.max(m, d.total_tokens), 0);
  const agents = usage?.by_agent ?? [];
  const groups = ledger?.groups ?? [];
  const qa = groups.reduce((acc, g) => {
    if (g.latest_verdict === '通过') acc.pass += 1;
    else if (g.latest_verdict === '打回') acc.fail += 1;
    else acc.none += 1;
    return acc;
  }, { pass: 0, fail: 0, none: 0 });
  const rework = groups.reduce((s, g) => s + (g.rework_rounds || 0), 0);
  const firstDay = daily[0]?.date ?? '';
  const lastDay = daily[daily.length - 1]?.date ?? '';

  return (
    <div className="dash">
      <div className="dash-head">
        <div className="dash-title">
          <span className="dash-name">{t('dash.nav')}</span>
          <span className="dash-sub">{projectName}</span>
        </div>
        <div className="dash-ranges">
          {RANGES.map((r) => (
            <button
              key={r}
              className={'dash-chip' + (days === r ? ' on' : '')}
              onClick={() => setDays(r)}
            >
              {t(`dash.range.${r}`)}
            </button>
          ))}
        </div>
        <button className="dash-btn" onClick={() => void load()} disabled={loading}>
          {loading ? t('dash.loading') : t('dash.refresh')}
        </button>
      </div>

      {error ? <div className="dash-error">{error}</div> : null}

      <div className="dash-kpis">
        <div className="kpi">
          <span className="kpi-label">{t('dash.kpi.cost')}</span>
          <span className="kpi-value">{fmtMoney(cost)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t('dash.kpi.tokens')}</span>
          <span className="kpi-value">{fmtTokens(usage?.totals?.total_tokens)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t('dash.kpi.calls')}</span>
          <span className="kpi-value">{usage?.totals?.total_calls ?? '—'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">{t('dash.kpi.deliverables')}</span>
          <span className="kpi-value">{ledger?.stats ? ledger.stats.deliverables : '—'}</span>
        </div>
      </div>

      <div className="dash-panel">
        <div className="dp-title">{t('dash.daily')}</div>
        {daily.length ? (
          <>
            <div className="dash-bars">
              {daily.map((d) => (
                <div
                  key={d.date}
                  className="dash-bar"
                  style={{ height: `${maxTokens ? Math.max(3, (d.total_tokens / maxTokens) * 100) : 3}%` }}
                  title={`${d.date} · ${fmtTokens(d.total_tokens)} tokens · ${d.calls} ${t('dash.unit.calls')}`}
                />
              ))}
            </div>
            <div className="dash-axis">
              <span>{fmtDay(firstDay)}</span>
              <span>{fmtDay(lastDay)}</span>
            </div>
          </>
        ) : (
          <div className="dp-empty">{t('dash.daily.empty')}</div>
        )}
      </div>

      <div className="dash-cols">
        <div className="dash-panel">
          <div className="dp-title">{t('dash.agents')}</div>
          {agents.length ? (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>{t('dash.col.role')}</th>
                  <th>{t('dash.col.calls')}</th>
                  <th>{t('dash.col.tokens')}</th>
                  <th>{t('dash.col.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agent_id}>
                    <td>{a.role || a.agent_id}</td>
                    <td className="c-num">{a.calls}</td>
                    <td className="c-num">{fmtTokens(a.total_tokens)}</td>
                    <td className="c-num">{fmtMoney(a.cost_cny)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dp-empty">{t('dash.agents.empty')}</div>
          )}
        </div>

        <div className="dash-panel">
          <div className="dp-title">{t('dash.quality')}</div>
          <div className="dq-rows">
            <div className="dq-row pass">
              <span>{t('dash.qa.pass')}</span><b>{qa.pass}</b>
            </div>
            <div className="dq-row fail">
              <span>{t('dash.qa.fail')}</span><b>{qa.fail}</b>
            </div>
            <div className="dq-row">
              <span>{t('dash.qa.none')}</span><b>{qa.none}</b>
            </div>
            <div className="dq-sep" />
            <div className="dq-row">
              <span>{t('dash.rework')}</span><b>{rework}</b>
            </div>
            <div className="dq-row">
              <span>{t('dash.orphan')}</span>
              <b>{ledger?.stats ? ledger.stats.orphans.length : '—'}</b>
            </div>
            <div className="dq-row">
              <span>{t('dash.member')}</span>
              <b>{usage ? usage.member_count : '—'}</b>
            </div>
          </div>
          <div className="dp-foot">{t('dash.quality.foot')}</div>
        </div>
      </div>
    </div>
  );
};

export default DashboardView;
