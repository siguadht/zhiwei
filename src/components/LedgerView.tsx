/**
 * [v1.0.40] LedgerView — 交付台账（只读）。
 *
 * 位置：左栏 Rail「台账」→ activeView==='ledger' → 本组件。
 * 数据：GET /ledger?project_id=，后端 backend/deliverables.py 现算，无缓存无写路径。
 *
 * 版式是**故意做土**的：一列东西、点开看版本，配色只用一个强调色。
 * 前端大改时这张表整个换皮即可——值钱的口径都在后端那份 JSON 里，不在这里。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runtimeFetch } from '../shared/runtimeFetch';
import { runtimeHttpBase } from '../shared/runtimeEndpoints';
import { useKnoweStore } from '../store/store';
import { selectActiveProjectId, selectActiveConvName } from '../store/selectors';
import { PLATFORM_PROJECT_ID, pickAvatar } from '../store/avatar';
import { Avatar, glyphOf, palOf } from './Avatar';

interface QaEntry {
  report: string;
  order: number;
  agent_id: string;
  role: string;
  ts: string;
  link: string;
  verdict: string | null;
  detail: string;
}

interface LedgerRow {
  file: string;
  ext: string;
  bytes: number;
  mtime: string;
  sha256: string | null;
  category: string;
  produced_by: string;
  role: string;
  produced_at: string;
  delivery_status: string;
  order: number | null;
  stage: string;
  qa: QaEntry[];
  qa_verdict?: string | null;
  qa_detail: string;
  qa_link: string;
  checked?: string[];
}

interface LedgerGroup {
  name: string;
  ext: string;
  version_count: number;
  rework_rounds: number;
  latest_file: string;
  latest_bytes: number | null;
  latest_role: string;
  latest_verdict: string | null;
  orders: number[];
  files: string[];
}

interface LedgerPayload {
  project_id: string;
  project_dir: string;
  project_dir_exists: boolean;
  generated_at: string;
  rows: LedgerRow[];
  groups: LedgerGroup[];
  qa_unlinked: QaEntry[];
  stats: {
    files: number;
    deliverables: number;
    groups: number;
    with_provenance: number;
    orphans: string[];
  };
}

type Filter = 'all' | 'deliverable' | 'report' | 'orphan';

function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

export const LedgerView: React.FC = () => {
  const { t } = useTranslation();
  const activeId = useKnoweStore(selectActiveProjectId);
  // __platform__ 是知微的平台私聊，不是项目，台账没有它可数的东西。
  const projectId = activeId === PLATFORM_PROJECT_ID ? '' : activeId;
  const projectName = useKnoweStore(selectActiveConvName);
  const [data, setData] = useState<LedgerPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const res = await runtimeFetch(
        `${runtimeHttpBase()}/ledger?project_id=${encodeURIComponent(projectId)}`,
      );
      if (!res.ok) {
        setError(`${t('ledger.errLoad')}（HTTP ${res.status}）`);
        setData(null);
        return;
      }
      setData((await res.json()) as LedgerPayload);
    } catch (exc) {
      setError(`${t('ledger.errLoad')}（${String(exc)}）`);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rowsByFile = React.useMemo(() => {
    const map = new Map<string, LedgerRow>();
    (data?.rows ?? []).forEach((r) => map.set(r.file, r));
    return map;
  }, [data]);

  const groups = React.useMemo(() => {
    const all = data?.groups ?? [];
    if (filter === 'deliverable') return all.filter((g) => g.latest_role !== '');
    if (filter === 'report') return all;
    if (filter === 'orphan') return all.filter((g) => g.latest_role === '');
    return all;
  }, [data, filter]);

  const reports = (data?.rows ?? []).filter((r) => r.category === '质检报告' || r.category === '交付报告');

  if (!projectId) {
    return (
      <div className="ledger">
        <div className="ledger-blank">{t('ledger.noProject')}</div>
      </div>
    );
  }

  return (
    <div className="ledger">
      <div className="ledger-head">
        <div className="ledger-title">
          <span className="ledger-name">{projectName || t('ledger.noProject')}</span>
          <span className="ledger-dir" title={data?.project_dir || ''}>{data?.project_dir || ''}</span>
        </div>
        <button className="ledger-btn" onClick={() => void load()} disabled={loading}>
          {loading ? t('ledger.loading') : t('ledger.refresh')}
        </button>
      </div>

      {error ? <div className="ledger-error">{error}</div> : null}
      {data && !data.project_dir_exists ? (
        <div className="ledger-warn">{t('ledger.dirMissing')}</div>
      ) : null}

      {data ? (
        <div className="ledger-stats">
          <span>{t('ledger.statTotal')} <b>{data.stats.deliverables}</b></span>
          <span>{t('ledger.statGroups')} <b>{data.stats.groups}</b></span>
          <span>{t('ledger.statTraced')} <b>{data.stats.with_provenance}</b></span>
          <span>{t('ledger.statOrphan')} <b>{data.stats.orphans.length}</b></span>
        </div>
      ) : null}

      <div className="ledger-filters">
        {(['all', 'deliverable', 'orphan', 'report'] as Filter[]).map((f) => (
          <button
            key={f}
            className={'ledger-chip' + (filter === f ? ' on' : '')}
            onClick={() => setFilter(f)}
          >
            {t(`ledger.filter.${f}`)}
          </button>
        ))}
      </div>

      <div className="ledger-body">
        {!data && !loading ? <div className="ledger-blank">{t('ledger.empty')}</div> : null}

        {filter !== 'report' ? (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t('ledger.colThing')}</th>
                <th>{t('ledger.colVersion')}</th>
                <th>{t('ledger.colSize')}</th>
                <th>{t('ledger.colMaker')}</th>
                <th>{t('ledger.colVerdict')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const latest = rowsByFile.get(g.latest_file);
                return (
                  <tr key={g.name} className="ledger-group-row">
                    <td className="c-thing">
                      <span className="ledger-fname">{g.name}</span>
                      <span className="ledger-ext">.{g.ext}</span>
                      {g.orders.length ? (
                        <span className="ledger-order">
                          {t('ledger.order')} {g.orders.join('/')}
                        </span>
                      ) : null}
                    </td>
                    <td className="c-ver">
                      {g.version_count}
                      {g.rework_rounds > 0 ? (
                        <span className="ledger-rework">
                          {t('ledger.rework')} {g.rework_rounds}
                        </span>
                      ) : null}
                    </td>
                    <td className="c-num">{fmtBytes(g.latest_bytes)}</td>
                    <td className="c-who">
                      {latest?.produced_by ? (
                        <span className="c-who-in">
                          {/* [v1.0.42] 同一张脸：台账里「谁做的」用运行时那套分配算法，和气泡/花名册对得上 */}
                          <Avatar
                            glyph={glyphOf(latest.role || latest.produced_by)}
                            pal={palOf(latest.produced_by)}
                            size={28}
                            src={pickAvatar(latest.produced_by, projectId)}
                          />
                          <span className="c-who-tx">{latest.role || latest.produced_by}</span>
                        </span>
                      ) : <i>{t('ledger.untraced')}</i>}
                    </td>
                    <td className="c-verdict">
                      <Verdict row={latest} verdict={g.latest_verdict} />
                    </td>
                  </tr>
                );
              })}
              {!groups.length ? (
                <tr><td colSpan={5} className="ledger-blank">{t('ledger.empty')}</td></tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {filter === 'report' ? (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t('ledger.colReport')}</th>
                <th>{t('ledger.colMaker')}</th>
                <th>{t('ledger.colTime')}</th>
                <th>{t('ledger.colVerdict')}</th>
                <th>{t('ledger.colTarget')}</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.file}>
                  <td className="c-thing"><span className="ledger-fname">{r.file}</span></td>
                  <td className="c-who">{r.role || r.produced_by}</td>
                  <td className="c-num">{fmtTime(r.produced_at || r.mtime)}</td>
                  <td className="c-verdict"><Verdict row={r} verdict={r.qa_verdict} /></td>
                  <td className="c-target">{r.checked?.join('、') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {data?.qa_unlinked?.length ? (
          <div className="ledger-note">
            {t('ledger.qaUnlinked')}：{data.qa_unlinked.map((q) => q.report).join('、')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const Verdict: React.FC<{ row?: LedgerRow; verdict?: string | null }> = ({ row, verdict }) => {
  const { t } = useTranslation();
  if (!row) return <span className="v none">—</span>;
  if (verdict === '通过') {
    return <span className="v pass" title={row.qa_detail}>{verdict}</span>;
  }
  if (verdict === '打回') {
    return (
      <span className="v fail" title={row.qa_detail}>
        {verdict}
        {row.qa_detail ? <em className="v-detail">{row.qa_detail}</em> : null}
      </span>
    );
  }
  if (row.delivery_status === 'SYSTEM_ERROR') {
    return <span className="v none">{t('ledger.failed')}</span>;
  }
  return <span className="v none">{t('ledger.notChecked')}</span>;
};

export default LedgerView;
