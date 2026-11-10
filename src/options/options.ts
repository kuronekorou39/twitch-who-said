import { getDb } from '../db/db';
import { exportFileName, exportLines, importLines } from '../db/export';
import { rpc } from '../shared/messages';
import type { Settings } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const fmtDate = (ts: number | null) => (ts === null ? '–' : new Date(ts).toLocaleString());
const fmtNum = (n: number) => n.toLocaleString();
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function setStatus(id: string, text: string, clearAfterMs = 0): void {
  const el = $(id);
  el.textContent = text;
  if (clearAfterMs > 0) setTimeout(() => (el.textContent = ''), clearAfterMs);
}

async function refreshStats(): Promise<void> {
  const st = await rpc({ type: 'ws:stats' });
  $('st-messages').textContent = fmtNum(st.messages);
  $('st-users').textContent = fmtNum(st.users);
  $('st-channels').textContent = fmtNum(st.channels);
  $('st-oldest').textContent = fmtDate(st.oldestTs);
  $('st-newest').textContent = fmtDate(st.newestTs);
  $('st-last-ingest').textContent = fmtDate(st.lastIngestAt);
  $('st-last-prune').textContent = fmtDate(st.lastPruneAt);
  $('ws-no-data').hidden = st.messages > 0;
  try {
    const est = await navigator.storage.estimate();
    $('st-usage').textContent = est.usage !== undefined ? fmtBytes(est.usage) : '不明';
  } catch {
    $('st-usage').textContent = '不明';
  }
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(form: HTMLFormElement, name: string): T {
  return form.elements.namedItem(name) as T;
}

function fillForm(form: HTMLFormElement, s: Settings): void {
  field(form, 'retentionDays').value = String(s.retentionDays);
  field(form, 'maxPerUser').value = String(s.maxPerUser);
  field(form, 'maxTotal').value = String(s.maxTotal);
  field(form, 'excludeUsers').value = s.excludeUsers.join('\n');
  field<HTMLInputElement>(form, 'knownBotsPreset').checked = s.knownBotsPreset;
  field<HTMLInputElement>(form, 'excludeSelf').checked = s.excludeSelf;
  field<HTMLInputElement>(form, 'showOnModView').checked = s.showOnModView;
}

function readForm(form: HTMLFormElement): Partial<Settings> {
  const fd = new FormData(form);
  const num = (k: string) => Number(fd.get(k) ?? 0);
  return {
    retentionDays: num('retentionDays'),
    maxPerUser: num('maxPerUser'),
    maxTotal: num('maxTotal'),
    excludeUsers: String(fd.get('excludeUsers') ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    knownBotsPreset: fd.has('knownBotsPreset'),
    excludeSelf: fd.has('excludeSelf'),
    showOnModView: fd.has('showOnModView'),
  };
}

/** 全件を JSON Lines にして <a download> で保存する(chrome.downloads 権限は使わない) */
async function doExport(): Promise<void> {
  setStatus('export-status', '書き出し中…');
  const db = await getDb();
  const chunks: string[] = [];
  let lines = 0;
  for await (const chunk of exportLines(db)) {
    chunks.push(chunk);
    lines += chunk.split('\n').length - 1;
    setStatus('export-status', `書き出し中… ${fmtNum(lines)} 件`);
  }
  const blob = new Blob(chunks, { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus('export-status', `${fmtNum(lines)} 件を書き出しました (${fmtBytes(blob.size)})`, 8000);
}

async function doImport(file: File): Promise<void> {
  setStatus('import-status', `読み込み中… ${file.name}`);
  const text = await file.text();
  const db = await getDb();
  const r = await importLines(db, text, (p) => setStatus('import-status', `取り込み中… ${fmtNum(p.imported)} / ${fmtNum(p.read)} 件`));
  const invalid = r.invalid ? `、不正な行 ${fmtNum(r.invalid)}` : '';
  setStatus('import-status', `${fmtNum(r.read)} 行を読み、${fmtNum(r.imported)} 件を追加しました(重複は除外${invalid})`, 10_000);
  await refreshStats();
}

async function doPrune(): Promise<void> {
  setStatus('prune-status', '実行中…');
  const r = await rpc({ type: 'ws:prune' });
  setStatus(
    'prune-status',
    `${fmtNum(r.deleted)} 件を削除しました(期間 ${fmtNum(r.byRetention)} / ユーザー上限 ${fmtNum(r.byPerUser)} / 全体上限 ${fmtNum(r.byTotal)})`,
    10_000,
  );
  await refreshStats();
}

async function main(): Promise<void> {
  const form = $<HTMLFormElement>('form-settings');
  fillForm(form, await rpc({ type: 'ws:getSettings' }));
  await refreshStats();

  $('btn-refresh').addEventListener('click', () => void refreshStats());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const saved = await rpc({ type: 'ws:setSettings', patch: readForm(form) });
      fillForm(form, saved);
      setStatus('save-status', '保存しました', 2000);
    })();
  });

  $('btn-prune').addEventListener('click', () => void doPrune().catch((e: unknown) => setStatus('prune-status', `失敗: ${String(e)}`)));
  $('btn-export').addEventListener('click', () => void doExport().catch((e: unknown) => setStatus('export-status', `失敗: ${String(e)}`)));
  $<HTMLInputElement>('file-import').addEventListener('change', (e) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void doImport(file).catch((err: unknown) => setStatus('import-status', `失敗: ${String(err)}`));
  });

  $('btn-clear').addEventListener('click', () => {
    if (!confirm('保存済みのチャット履歴をすべて削除します。元に戻せません。よろしいですか?')) return;
    void rpc({ type: 'ws:clear' }).then(refreshStats);
  });
}

void main();
