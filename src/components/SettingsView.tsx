/**
 * SettingsView.tsx — [v0.44] 设置视图
 *
 * 摆放位置：src/components/SettingsView.tsx
 *
 * 挂载点：App.tsx 的 .view-alt（activeView === 'settings'）。
 * 布局：[v1.0.41.3] 不再走 ContactsView / FavoritesView / KnowledgeView 那套「左 .side + 右 .stage」，
 * 而是 .stage > .stage-card > (.set-tabs 顶部横排五段 + .set-pane 正文)——
 * 目录横过来之后正文吃满整宽。排版骨架仍照参考 HTML 的设置区域
 * （.set-pane / .set-block / .set-item / .switch / .field / .test-btn / .test-res，
 * 样式在 settings-view.css），**内容按 v0.44 README 定制**：
 *
 *   导航五项（README §一：Agent 与项目 / 隐私与数据 / 快捷键 三项删除）：
 *     账户与身份 · 模型与提供方 · 通知 · 外观 · 关于
 *
 *   §2.2 温度设置本版本不做——UI 里没有任何温度相关控件（README §四 约束）。
 *   §2.4 深色只留接口（store.appearance → App 挂 theme-dark 类，CSS 暂空）。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { BackendStatus, UpdateStatus } from '../shared/bridge';
import { useKnoweStore } from '../store/store';
import { useAuthStore } from '../store/auth';
import { useSettingsStore, testModelConnection, testBinding,
  APPROVAL_TIMEOUT_OPTIONS, type ModelApplyResult,
  type ModelBinding,
} from '../store/settings';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import ModelBindingModule from './ModelBindingModule';
import PrimaryLanguageModule from './PrimaryLanguageModule'; // [v1.0.21.3]
import MSetSelect from './MSetSelect'; // [v1.0.24.1] 设置内下拉统一为 mset 样式
import { toast } from './ContextMenu';
import './settings-view.css';

const SECTIONS = ['账户与身份', '模型与提供方', '通知', '外观', '关于'] as const;
export type SettingsSection = (typeof SECTIONS)[number];

export interface SettingsSearchFocus {
  section: SettingsSection;
  requestId: number;
}

/** [v1.0.25.4] window.knowe 的类型化访问（老 preload 缺字段时全部 ?. 容错）。 */
function bridge(): Window['knowe'] | undefined {
  return (window as unknown as { knowe?: Window['knowe'] }).knowe;
}

function toastApplyResult(result: ModelApplyResult): void {
  if (!result.ok || result.restartRequired) toast(result.message, 'warn');
  else toast(result.message);
}

function restartSettled(status: BackendStatus): boolean {
  return status.phase === 'ready'
    || status.phase === 'failed'
    || status.phase === 'crashed'
    || status.phase === 'stopped';
}

/** IPC restart returns the immediate `starting` state; wait for the already-whitelisted status channel. */
function waitForRestartResult(
  bridge: NonNullable<Window['knowe']>,
  initial: BackendStatus,
): Promise<BackendStatus> {
  if (restartSettled(initial)) return Promise.resolve(initial);
  return new Promise((resolve) => {
    let latest = initial;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (status: BackendStatus): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(status);
    };
    const observe = (status: BackendStatus): void => {
      latest = status;
      if (restartSettled(status)) finish(status);
    };
    const timeout = window.setTimeout(() => finish(latest), 45_000);
    unsubscribe = bridge.onBackendStatus(observe);
    void bridge.getBackendStatus().then(observe).catch(() => undefined);
  });
}

// ═══════════════════════════════════════════════════════════════
// 小构件
// ═══════════════════════════════════════════════════════════════

/** 参考 HTML 的 switchEl：.switch(.on)，点击翻转。 */
const Switch: React.FC<{ on: boolean; onToggle: (on: boolean) => void; label: string }> = ({
  on, onToggle, label,
}) => (
  <div
    className={'switch' + (on ? ' on' : '')}
    role="switch"
    aria-checked={on}
    aria-label={label}
    tabIndex={0}
    onClick={() => onToggle(!on)}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(!on); } }}
  />
);

/** 参考 HTML 的 setItem：.set-item > .si-body(.si-t + .si-d) + .set-ctrl。 */
const SetItem: React.FC<{ t: string; d?: string; children?: React.ReactNode }> = ({ t, d, children }) => (
  <div className="set-item">
    <div className="si-body">
      <div className="si-t">{t}</div>
      {d && <div className="si-d">{d}</div>}
    </div>
    {children && <div className="set-ctrl">{children}</div>}
  </div>
);

// ═══════════════════════════════════════════════════════════════
// §2.1 账户与身份
// ═══════════════════════════════════════════════════════════════

/**
 * 头像上传：解码图片 → canvas 缩到 256px 内 → PNG dataURL（localStorage 装得下）。
 *
 * [v0.44.1 Bug1] 老实现走 `FileReader.readAsDataURL → img.src = dataURL` 这条链：
 *   在 Electron（webSecurity:true）里，把一条 data: URL 塞给 <img> 解码，最容易踩两个坑——
 *     ① CSP 的 img-src 若没放行 data:（默认回落 default-src 'self' 就会这样），<img> 直接
 *        触发 onerror；
 *     ② 部分格式/大图在 <img> 这条解码路径上时好时坏。
 *   两者最终都落到 `img.onerror → toast('图片读取失败')`，也就是用户看到的现象。
 *
 * 改用 createImageBitmap(file) 直接解码 Blob：不经过 <img>、不碰 img-src，解码更稳、
 *   也省掉一次「先编码成 dataURL 再解码」的来回。只有在没有 createImageBitmap 的老环境
 *   才回落到 objectURL + <img>（用 blob: 而非 data:，并用完即撤）。
 */
function readAvatarFile(file: File, onDone: (dataUrl: string) => void): void {
  if (!file.type.startsWith('image/')) {
    toast(i18n.t('settings.view.pickImage'), 'warn');
    return;
  }

  const MAX = 256;

  /** 把已解码的图源画进 canvas，缩到 MAX 内，导出 PNG dataURL；失败返回 null。 */
  const toScaledDataUrl = (src: CanvasImageSource, w: number, h: number): string | null => {
    if (!w || !h) return null;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, cw, ch);
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  };

  /** 兜底：老环境没有 createImageBitmap → objectURL + <img>（blob:，非 data:）。 */
  const fallbackViaImg = (): void => {
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const url = toScaledDataUrl(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
      URL.revokeObjectURL(objUrl);
      if (url) onDone(url);
      else toast('图片读取失败', 'warn');
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      toast(i18n.t('settings.view.imageReadFailed'), 'warn');
    };
    img.src = objUrl;
  };

  if (typeof createImageBitmap === 'function') {
    createImageBitmap(file)
      .then((bmp) => {
        const url = toScaledDataUrl(bmp, bmp.width, bmp.height);
        bmp.close?.();
        if (url) onDone(url);
        else fallbackViaImg();     // 解码成了但 canvas 导出失败 → 再试一条路
      })
      .catch(() => fallbackViaImg());
    return;
  }

  fallbackViaImg();
}

const AccountPane: React.FC = () => {
  const { t } = useTranslation();
  const userName = useSettingsStore((s) => s.userName);
  const avatarDataUrl = useSettingsStore((s) => s.avatarDataUrl);
  const setUserName = useSettingsStore((s) => s.setUserName);
  const setAvatar = useSettingsStore((s) => s.setAvatar);
  const pushToBackend = useSettingsStore((s) => s.pushToBackend);
  const account = useAuthStore((s) => s.account);
  const signOut = useAuthStore((s) => s.signOut);
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(userName);

  useEffect(() => { setDraft(userName); }, [userName]);

  const commitName = async (): Promise<void> => {
    const name = draft.trim();
    if (!name) { setDraft(userName); return; }
    if (name !== userName) {
      setUserName(name);
      toastApplyResult(await pushToBackend());
    }
  };

  return (
    <>
      <div className="set-block">
        <h4>{t('global.search.04')}</h4>
        <div className="set-item">
          <div className="si-body set-acct-row">
            <button
              type="button"
              className="set-avatar"
              onClick={() => fileRef.current?.click()}
              title={t('settings.view.23')}
              aria-label={t('settings.view.04')}
            >
              {avatarDataUrl
                ? <img src={avatarDataUrl} alt={t('settings.view.26')} />
                : <span className="set-avatar-glyph">{(userName || '我').slice(0, 1)}</span>}
            </button>
            <div>
              <div className="si-t">{userName}</div>
              <div className="si-d">{t('settings.view.24')}</div>
            </div>
          </div>
          <div className="set-ctrl">
            {avatarDataUrl && (
              <button type="button" className="test-btn" onClick={() => setAvatar(null)}>
                {t('settings.view.removeAvatar')}
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) readAvatarFile(f, (url) => { setAvatar(url); toast(t('settings.view.avatarUpdated')); });
            e.target.value = '';   // 允许连选同一张
          }}
        />
      </div>

      <div className="set-block">
        <h4>{t('settings.view.28')}</h4>
        <SetItem t={t('settings.view.27')} d={t('settings.view.07')}>
          {/* [v1.0.24.1] 右侧加【确认】按钮：点击 = 提交（同回车/失焦）；回车仍走 blur → commitName */}
          <div className="mset-testrow">
            <input
              className="field mset-field"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { void commitName(); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              maxLength={24}
              aria-label={t('settings.view.27')}
            />
            <button
              type="button"
              className="test-btn"
              onClick={() => { void commitName(); }}
              aria-label={t('settings.view.27') + t('common.20')}
            >
              {t('common.20')}
            </button>
          </div>
        </SetItem>
      </div>

      <div className="set-block">
        <h4>{t('settings.account.session')}</h4>
        <SetItem t={t('settings.account.email')} d={t('settings.account.emailD')}>
          <div className="mset-testrow">
            <span className="set-account-mail">{account?.email ?? '—'}</span>
            <button type="button" className="test-btn" onClick={() => { signOut(); }}>
              {t('settings.account.signout')}
            </button>
          </div>
        </SetItem>
      </div>

      {/* [v1.0.23.4] 主要语言模块：从模型与提供方移到账户与身份（语言是个人账户偏好） */}
      <div className="set-block">
        <PrimaryLanguageModule />
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════════════════════
// §2.2 模型与提供方
// ═══════════════════════════════════════════════════════════════

const ModelsPane: React.FC = () => {
  const { t } = useTranslation();
  // [v1.0.39.3] 多模型预存：清单 + 主/辅池
  const modelProfiles = useSettingsStore((s) => s.modelProfiles);
  const mainPoolIdxs = useSettingsStore((s) => s.mainPoolIdxs);
  const auxPoolIdxs = useSettingsStore((s) => s.auxPoolIdxs);
  const addModelProfile = useSettingsStore((s) => s.addModelProfile);
  const updateModelProfile = useSettingsStore((s) => s.updateModelProfile);
  const removeModelProfile = useSettingsStore((s) => s.removeModelProfile);
  const moveModelProfile = useSettingsStore((s) => s.moveModelProfile);
  const toggleProfilePool = useSettingsStore((s) => s.toggleProfilePool);
  const connState = useSettingsStore((s) => s.connState);
  const testingAll = useSettingsStore((s) => s.testingAll);
  const testAllConnections = useSettingsStore((s) => s.testAllConnections);
  const pushToBackend = useSettingsStore((s) => s.pushToBackend);

  const [draft, setDraft] = useState<Omit<ModelBinding, 'sealed'> | null>(null);
  const [testing, setTesting] = useState(false);
  const testRunId = useRef(0);

  const invalidateTestResult = (): void => {
    testRunId.current += 1;
    setTesting(false);
  };

  // 保存一条（新增/编辑）：先测连接 —— 通过才加入清单，失败则不加入并提示原因。
  const handleSave = async (b: { provider: string; model: string; apiKey: string; baseUrl?: string }): Promise<void> => {
    if (testing) return;
    const hasKey = Boolean(b.apiKey && b.apiKey.trim());
    if (!hasKey) {
      toast(i18n.t('settings.07'), 'warn');
      return;
    }
    setTesting(true);
    try {
      // [v1.0.39.3] API Key 连接失败的模型不进列表：先测连接，通过才加入。
      const test = await testBinding(b, 'main');
      if (!test.ok) {
        toast(test.message || i18n.t('settings.07'), 'warn');
        return;
      }
      if (draft && draft.provider && draft.model) {
        const idx = modelProfiles.findIndex((x) => x.provider === draft.provider && x.model === draft.model);
        if (idx >= 0) updateModelProfile(idx, b);
        else addModelProfile({ ...b, hasApiKey: hasKey });
      } else {
        addModelProfile({ ...b, hasApiKey: hasKey });
      }
      setDraft(null);
      invalidateTestResult();
      await pushToBackend().then((r) => {
        toastApplyResult(r);
        if (r.ok) void runTest();
      });
      // [v1.0.39.3] 模型刚加入/编辑成功后，自动对全列表做一次连接测试并刷新符号。
      void testAllConnections();
    } finally {
      setTesting(false);
    }
  };

  const applySaved = async (): Promise<void> => {
    const r = await pushToBackend();
    toastApplyResult(r);
    if (r.ok) void runTest();
  };

  const runTest = async (): Promise<void> => {
    if (testing) return;
    const runId = testRunId.current + 1;
    testRunId.current = runId;
    setTesting(true);
    try {
      await testModelConnection('main');
    } finally {
      if (runId === testRunId.current) setTesting(false);
    }
  };

  const mainPool = mainPoolIdxs
    .map((i) => modelProfiles[i])
    .filter((x): x is ModelBinding => Boolean(x));
  const auxPool = auxPoolIdxs
    .map((i) => modelProfiles[i])
    .filter((x): x is ModelBinding => Boolean(x));

  const poolLabel = (b: ModelBinding): string => `${b.provider}·${b.model}`;

  // [v1.0.39.3] 连接状态列：绿勾=正常，红叉=有问题，灰点=待测/测试中。
  const renderConnStatus = (state?: 'ok' | 'fail' | 'testing'): React.ReactNode => {
    if (state === 'ok') {
      return <span className="conn-dot ok" title={t('model.binding.module.preset.connOk')}>{'✓'}</span>;
    }
    if (state === 'fail') {
      return <span className="conn-dot fail" title={t('model.binding.module.preset.connFail')}>{'✕'}</span>;
    }
    if (state === 'testing') {
      return <span className="conn-dot testing" title={t('model.binding.module.preset.connTesting')}>{'…'}</span>;
    }
    // 未测过
    return <span className="conn-dot idle" title={t('model.binding.module.preset.connIdle')}>{'·'}</span>;
  };

  // [v1.0.39.3] 路由池子项渲染：每个模型一个胶囊 + 间隔箭头（demo 一致）
  const renderPool = (items: ModelBinding[]): React.ReactNode =>
    items.length === 0 ? (
      <span className="pool-empty">{t('model.binding.module.preset.empty')}</span>
    ) : (
      items.map((b, i) => (
        <React.Fragment key={`${b.provider}-${b.model}-${i}`}>
          {i > 0 && <span className="pool-arrow">→</span>}
          <span className="pool-item">{poolLabel(b)}</span>
        </React.Fragment>
      ))
    );

  // [v1.0.39.3] 路由池提示语：主/辅都空与有内容两种状态（demo 一致）
  const poolEmpty = mainPool.length === 0 && auxPool.length === 0;

  return (
    <>
      {/* [v1.0.39.3] 填配置卡：新增一条模型配置（进入模型清单）*/}
      <div className="set-block set-block-pool">
        <h4>{t('model.binding.module.preset.add')}</h4>
        <div className="set-note">{t('model.binding.module.preset.note')}</div>
        <ModelBindingModule
          binding={draft ? { ...draft, sealed: false } : null}
          onSave={handleSave}
          onEdit={() => { /* 新增态始终可编辑 */ }}
        />
      </div>

      {/* [v1.0.39.3] 路由池条 */}
      <div className="set-block set-block-pool">
        <div className="pool-bar">
          <h4>{t('model.binding.module.preset.poolTitle')}</h4>
          <div className="pool-row">
            <span className="pool-label">{t('global.search.01')}</span>
            <span id="pool-main" className="pool-items">
              {renderPool(mainPool)}
            </span>
          </div>
          <div className="pool-row">
            <span className="pool-label">{t('global.search.13')}</span>
            <span id="pool-aux" className="pool-items">
              {renderPool(auxPool)}
            </span>
          </div>
          <div className="pool-note">{poolEmpty ? t('model.binding.module.preset.alertEmpty') : t('model.binding.module.preset.routeHint')}</div>
        </div>
      </div>

      {/* [v1.0.39.3] 已存清单表格 */}
      <div className="set-block set-block-pool">
        <div className="table-card">
          <div className="tc-head">
            <h4>{t('model.binding.module.preset.list')}</h4>
            <span className="tc-count">{t('model.binding.module.preset.count', { n: modelProfiles.length })}</span>
            <button
              type="button"
              className="check-all"
              disabled={testingAll}
              onClick={() => { void testAllConnections(); }}
            >
              {t('model.binding.module.preset.checkAll')}
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: 'center' }}>{t('model.binding.module.preset.conn')}</th>
                  <th>{t('model.binding.module.provider')}</th>
                  <th>{t('model.binding.module.model')}</th>
                  <th>{t('model.binding.custom.baseUrl')}</th>
                  <th>{t('model.binding.module.preset.apikey')}</th>
                  <th style={{ textAlign: 'center' }}>{t('global.search.01')}</th>
                  <th style={{ textAlign: 'center' }}>{t('global.search.13')}</th>
                  <th style={{ textAlign: 'center' }}>{t('model.binding.module.ops')}</th>
                </tr>
              </thead>
              <tbody id="profile-tbody">
                {modelProfiles.length === 0 ? (
                  <tr><td colSpan={8}><div className="empty-row">{t('model.binding.module.preset.noList')}</div></td></tr>
                ) : modelProfiles.map((b, idx) => (
                  <tr key={`${b.provider}-${b.model}-${idx}`}>
                    <td className="conn-cell">
                      {renderConnStatus(connState[`${b.provider}|${b.model}`])}
                    </td>
                    <td className="provider">{b.provider}</td>
                    <td className="model">{b.model}</td>
                    <td className="baseurl">{b.baseUrl ?? '—'}</td>
                    <td className="apikey">{b.apiKeyMask || (b.hasApiKey ? t('model.binding.module.preset.mask') : t('model.binding.module.preset.noKey'))}</td>
                    <td className="sw-cell">
                      <button
                        type="button"
                        className={'sw-pill ' + (mainPoolIdxs.includes(idx) ? 'on' : 'off')}
                        onClick={() => toggleProfilePool(idx, 'main')}
                      >
                        <span className="dot" />
                        {mainPoolIdxs.includes(idx) ? t('model.binding.module.preset.on') : t('model.binding.module.preset.off')}
                      </button>
                    </td>
                    <td className="sw-cell">
                      <button
                        type="button"
                        className={'sw-pill ' + (auxPoolIdxs.includes(idx) ? 'on' : 'off')}
                        onClick={() => toggleProfilePool(idx, 'aux')}
                      >
                        <span className="dot" />
                        {auxPoolIdxs.includes(idx) ? t('model.binding.module.preset.on') : t('model.binding.module.preset.off')}
                      </button>
                    </td>
                    <td>
                      <div className="actions">
                        <button type="button" className="icon-btn" disabled={idx === 0} onClick={() => moveModelProfile(idx, -1)}>↑</button>
                        <button type="button" className="icon-btn" disabled={idx === modelProfiles.length - 1} onClick={() => moveModelProfile(idx, 1)}>↓</button>
                        <button type="button" className="icon-btn del" onClick={() => { removeModelProfile(idx); void applySaved(); }}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════════════════════
// §2.3 通知
// ═══════════════════════════════════════════════════════════════

const NotifyPane: React.FC = () => {
  const { t } = useTranslation();
  const notifyDesktop = useSettingsStore((s) => s.notifyDesktop);
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const approvalTimeoutS = useSettingsStore((s) => s.approvalTimeoutS);
  const setNotifyDesktop = useSettingsStore((s) => s.setNotifyDesktop);
  const setCloseToTray = useSettingsStore((s) => s.setCloseToTray);
  const setApprovalTimeout = useSettingsStore((s) => s.setApprovalTimeout);
  const pushToBackend = useSettingsStore((s) => s.pushToBackend);

  return (
    <>
      <div className="set-block">
        <h4>{t('settings.view.21')}</h4>
        <SetItem t={t('global.search.06')} d={t('settings.view.05')}>
          <Switch on={notifyDesktop} onToggle={setNotifyDesktop} label={t('global.search.06')} />
        </SetItem>
        <SetItem t={t('settings.view.10')} d={t('settings.view.25')}>
          <Switch on={closeToTray} onToggle={setCloseToTray} label={t('settings.view.10')} />
        </SetItem>
      </div>

      <div className="set-block">
        <h4>{t('knowledge.view.02')}</h4>
        <SetItem t={t('contacts.view.09')} d={t('settings.view.08')}>
          <MSetSelect
            value={approvalTimeoutS}
            options={APPROVAL_TIMEOUT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
            onChange={(v) => {
              setApprovalTimeout(v);
              void pushToBackend().then(toastApplyResult);
            }}
            ariaLabel={t('contacts.view.09')}
          />
        </SetItem>
      </div>
    </>
  );
};

// ═══════════════════════════════════════════════════════════════
// §2.4 外观
// ═══════════════════════════════════════════════════════════════

const AppearancePane: React.FC = () => {
  const { t } = useTranslation();
  const appearance = useSettingsStore((s) => s.appearance);
  const fontScale = useSettingsStore((s) => s.fontScale);
  const setAppearance = useSettingsStore((s) => s.setAppearance);
  const setFontScale = useSettingsStore((s) => s.setFontScale);

  return (
    <div className="set-block">
      <h4>{t('global.search.03')}</h4>
      <SetItem t={t('settings.view.11')} d={t('settings.view.22')}>
        <MSetSelect
          value={appearance}
          options={[
            { value: 'light' as const, label: t('global.search.09') },
            { value: 'dark' as const, label: t('global.search.10') },
          ]}
          onChange={(v) => setAppearance(v)}
          ariaLabel={t('settings.view.11')}
        />
      </SetItem>
      <SetItem t={t('global.search.05')} d={t('settings.view.03')}>
        <MSetSelect
          value={fontScale}
          options={[
            { value: 'small' as const, label: t('settings.view.sizeSmall') },
            { value: 'large' as const, label: t('settings.view.sizeLarge') },
          ]}
          onChange={(v) => setFontScale(v)}
          ariaLabel={t('global.search.05')}
        />
      </SetItem>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// §2.7 关于
// ═══════════════════════════════════════════════════════════════

const AboutPane: React.FC = () => {
  const { t } = useTranslation();
  // [v1.0.25.4] 产品版本号由主进程注入（package.json productVersion），不再写死
  const shellVersion = bridge()?.version;
  // [v1.0.28 R5] 大版本号 = 版本号前两段（如 1.0.28 → 1.0），「桌面版」固定字样写死
  const majorVersion = shellVersion?.split('.').slice(0, 2).join('.');
  // [v1.0.25.4] 自动更新状态：挂载时查一次 + 订阅主进程推送
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: 'idle', progress: 0 });

  useEffect(() => {
    const b = bridge();
    if (!b?.onUpdateStatusChanged) return;
    const unsubscribe = b.onUpdateStatusChanged(setUpdateStatus);
    void b.getUpdateStatus?.().then((s) => setUpdateStatus(s));
    return unsubscribe;
  }, []);

  // [v1.0.25.4] 升级完成后由安装器 --updated 拉起 → toast 提示
  useEffect(() => {
    const b = bridge();
    if (!b?.onJustUpdated) return;
    const unsubscribe = b.onJustUpdated(() => toast(t('settings.view.autoUpdateJustUpdated'), 'info'));
    return unsubscribe;
  }, [t]);

  const checkNow = (): void => {
    const b = bridge();
    if (!b?.checkForUpdates) return;
    setUpdateStatus({ state: 'checking', progress: 0 });
    void b.checkForUpdates();
  };

  const installNow = (): void => {
    const b = bridge();
    if (!b?.installUpdate) return;
    void b.installUpdate();
  };

  return (
    <div className="set-block about-pane">
      <h4>{t('settings.view.09')}</h4>
      {/* [v1.0.28 R5] 标题下方显示大版本号（桌面版v1.0），右侧 tag 显示详细小版本号 v1.0.28 */}
      <SetItem t={t('global.search.11')} d={majorVersion ? t('settings.view.desktopVersion', { version: majorVersion }) : undefined}>
        <span className="navrow-tag">{shellVersion ? `v${shellVersion}` : ''}</span>
      </SetItem>
      {/* [v1.0.43] 关于页原来挂着上游骨架作者的四条联系方式（官网 / GitHub 仓库 /
          邮箱 / 微信号），整块摘掉。MIT 的署名义务用「开源许可」这一行履行。 */}
      <SetItem t={t('settings.view.copyrightTitle')}>
        <span className="navrow-tag">{t('settings.view.copyright')}</span>
      </SetItem>
      <SetItem t={t('settings.view.licenseTitle')}>
        <span className="navrow-tag">{t('settings.view.license')}</span>
      </SetItem>

      {/* [v1.0.25.4] 自动更新（PRD）：手动检查 + 有新版下载完成时出现「重启安装更新」 */}
      <SetItem t={t('settings.view.15')} d={t('settings.view.30')}>
        <div className="set-update-row">
          <button
            type="button"
            className="test-btn"
            disabled={updateStatus.state === 'checking'}
            onClick={checkNow}
          >
            {t('settings.view.15')}
          </button>
          {updateStatus.state === 'ready' && (
            <button type="button" className="test-btn set-update-install" onClick={installNow}>
              {t('settings.view.restartInstall')}
            </button>
          )}
        </div>
        {updateStatus.state === 'downloading' && (
          <div className="set-update-hint">
            {t('settings.view.autoUpdateDownloading', { percent: Math.round(updateStatus.progress) })}
          </div>
        )}
        {/* [v1.0.26.2] 手动检查无新版 → 「当前已是最新版本」提示（主进程 2.5 秒后自动回 idle） */}
        {updateStatus.state === 'up-to-date' && (
          <div className="set-update-hint set-update-up-to-date">{t('settings.view.autoUpdateUpToDate')}</div>
        )}
        {updateStatus.state === 'error' && (
          <div className="set-update-hint set-update-error">{t('settings.view.autoUpdateError')}</div>
        )}
      </SetItem>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// 视图外壳：.stage > .stage-card > .set-tabs + .set-pane
// ═══════════════════════════════════════════════════════════════

export interface SettingsViewProps {
  searchFocus?: SettingsSearchFocus | null;
  onSearchFocusDone?: (requestId: number) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  searchFocus = null, onSearchFocusDone,
}) => {
  const { t } = useTranslation();
  const [section, setSection] = useState<SettingsSection>('账户与身份');
  const [restartBusy, setRestartBusy] = useState(false);

  // 分区显示名映射：SECTIONS 值是内部协议（与其他文件 switch 匹配），展示时才翻译。
  const SECTION_LABELS: Record<SettingsSection, string> = {
    '账户与身份': t('global.search.12'),
    '模型与提供方': t('global.search.07'),
    '通知': t('global.search.14'),
    '外观': t('global.search.03'),
    '关于': t('global.search.02'),
  };

  // 开机 / 进设置页先以后端持久状态对账；GET 只返回 has_api_key，不回传明文。
  const reconcileFromBackend = useSettingsStore((s) => s.reconcileFromBackend);
  const clearRestartRequired = useSettingsStore((s) => s.clearRestartRequired);
  const restartRequired = useSettingsStore((s) => s.restartRequired);
  const connected = useKnoweStore((s) => s.conn);
  useEffect(() => {
    if (connected === 'live') void reconcileFromBackend();
  }, [connected, reconcileFromBackend]);

  // 全局搜索从外部指定分区时，直接复用本组件已有的 section 状态。
  useEffect(() => {
    if (!searchFocus) return;
    setSection(searchFocus.section);
    onSearchFocusDone?.(searchFocus.requestId);
  }, [onSearchFocusDone, searchFocus]);

  const restartBackend = async (): Promise<void> => {
    if (restartBusy) return;
    const bridge = window.knowe;
    if (!bridge?.restartBackend) {
      toast(t('settings.view.restartDesktopOnly'), 'warn');
      return;
    }
    setRestartBusy(true);
    try {
      const immediate = await bridge.restartBackend();
      const status = await waitForRestartResult(bridge, immediate);
      if (status.phase === 'ready') {
        clearRestartRequired();
        await reconcileFromBackend();
        toast(t('settings.view.restartOk'));
      } else if (status.phase === 'failed' || status.phase === 'crashed') {
        toast(status.message || t('settings.view.02'), 'warn');
      } else {
        toast(status.message || t('settings.view.18'), 'info');
      }
    } catch {
      toast(t('settings.view.restartFailed'), 'warn');
    } finally {
      setRestartBusy(false);
    }
  };

  return (
    <>
      {/*
        [v1.0.41.3 台面收敛] 原来这里是一根 220px 的 .side 目录柱，右边才 716px 的正文——
        五个短标签的目录竖着排，占了整页 1/4 宽度，正文里的表单被挤得一行放不下。
        真站的设置页都不这么排：Linear/Cursor 的设置是顶部一行文字 tab，正文吃满整宽。
        现在目录横过来变成 .set-tabs，五段还在，只是不再单独占一栏。
      */}
      <div className="stage">
        <div className="stage-card">
          <div className="set-tabs" role="tablist" aria-label={t('common.12')}>
            {SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={section === s}
                className={'set-tab' + (section === s ? ' active' : '')}
                onClick={() => setSection(s)}
              >
                {SECTION_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="set-pane">
            {restartRequired && (
              <div className="set-restart-banner" role="status" aria-live="polite">
                <div className="set-restart-copy">
                  <strong>{t('settings.view.31')}</strong>
                  <span>{t('settings.view.32')}</span>
                </div>
                <button
                  type="button"
                  className="test-btn set-restart-btn"
                  onClick={() => { void restartBackend(); }}
                  disabled={restartBusy}
                >
                  {restartBusy ? t('settings.view.17') : t('settings.view.29')}
                </button>
              </div>
            )}
            {section === '账户与身份' && <AccountPane />}
            {section === '模型与提供方' && <ModelsPane />}
            {section === '通知' && <NotifyPane />}
            {section === '外观' && <AppearancePane />}
            {section === '关于' && <AboutPane />}
          </div>
        </div>
      </div>
    </>
  );
};

export default SettingsView;
