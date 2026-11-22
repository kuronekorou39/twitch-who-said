import { getDb } from '../db/db';
import { decodeStream, estimateExportBytes, exportFileName, exportLines, importChunks } from '../db/export';
import { loadDiag } from '../shared/diag';
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

/** 完了の直前まで 100% にしない(件数は処理中の取り込みで増えることがある) */
const percentOf = (done: number, total: number) => (total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0);

function setProgress(id: string, pct: number | null): void {
  const bar = $<HTMLProgressElement>(id);
  bar.hidden = pct === null;
  if (pct !== null) bar.value = pct;
}

async function refreshExportEstimate(messages: number): Promise<void> {
  const el = $('export-estimate');
  if (messages === 0) {
    el.textContent = '';
    return;
  }
  try {
    const bytes = await estimateExportBytes(await getDb(), messages);
    el.textContent = `${fmtNum(messages)} 件 · 約 ${fmtBytes(bytes)}`;
  } catch {
    el.textContent = `${fmtNum(messages)} 件`;
  }
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
  void refreshExportEstimate(st.messages);
  const diag = await loadDiag();
  const diagEl = $('ws-diag');
  diagEl.hidden = !diag || diag.ok;
  if (diag && !diag.ok) {
    diagEl.textContent = `取得できていません: ${diag.page} で行は見えているのに 1 件も抽出できませんでした(${fmtDate(diag.at)})。Twitch の DOM が変わった可能性があります`;
  }
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
  // 0 は「無制限」を意味するので、空欄を 0 にしない。空欄の項目は変更しない
  const nums: Partial<Settings> = {};
  for (const k of ['retentionDays', 'maxPerUser', 'maxTotal'] as const) {
    const raw = String(fd.get(k) ?? '').trim();
    if (raw !== '') nums[k] = Number(raw);
  }
  return {
    ...nums,
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
  const button = $<HTMLButtonElement>('btn-export');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '書き出し中…';
  setProgress('export-progress', 0);
  setStatus('export-status', '書き出しを準備しています…');
  try {
    const db = await getDb();
    const total = await db.count('messages');
    // 文字列のまま貯めず Blob にしていく(Blob の中身は JS ヒープの外に置かれる)
    const chunks: Blob[] = [];
    let lines = 0;
    let bytes = 0;
    for await (const chunk of exportLines(db)) {
      const part = new Blob([chunk]);
      chunks.push(part);
      bytes += part.size;
      lines += chunk.split('\n').length - 1;
      const pct = percentOf(lines, total);
      const estimate = fmtBytes(Math.round((bytes / lines) * Math.max(total, lines)));
      setProgress('export-progress', pct);
      setStatus('export-status', `${pct}% · ${fmtNum(lines)} / ${fmtNum(total)} 件 · ${fmtBytes(bytes)} / 約 ${estimate}`);
    }
    setStatus('export-status', 'ファイルを作成しています…');
    const blob = new Blob(chunks, { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus('export-status', `${fmtNum(lines)} 件を書き出しました (${fmtBytes(blob.size)})。ブラウザのダウンロードを確認してください`);
  } finally {
    setProgress('export-progress', null);
    button.disabled = false;
    button.textContent = label;
  }
}

async function doImport(file: File): Promise<void> {
  const input = $<HTMLInputElement>('file-import');
  input.disabled = true;
  setProgress('import-progress', 0);
  setStatus('import-status', `読み込み中… ${file.name} (${fmtBytes(file.size)})`);
  try {
    const db = await getDb();
    let readBytes = 0;
    const counted = file.stream().pipeThrough(
      new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          readBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    const r = await importChunks(db, decodeStream(counted), (p) => {
      const pct = percentOf(readBytes, file.size);
      setProgress('import-progress', pct);
      setStatus('import-status', `${pct}% · ${fmtBytes(readBytes)} / ${fmtBytes(file.size)} · ${fmtNum(p.imported)} 件を追加`);
    });
    const invalid = r.invalid ? `、不正な行 ${fmtNum(r.invalid)}` : '';
    setStatus('import-status', `${fmtNum(r.read)} 行を読み、${fmtNum(r.imported)} 件を追加しました(重複は除外${invalid})`);
    await refreshStats();
  } finally {
    setProgress('import-progress', null);
    input.disabled = false;
  }
}

async function doPrune(): Promise<void> {
  setStatus('prune-status', '実行中…');
  const r = await rpc({ type: 'ws:prune' });
  setStatus(
    'prune-status',
    `${fmtNum(r.deleted)} 件を削除しました(期間 ${fmtNum(r.byRetention)} / ユーザー上限 ${fmtNum(r.byPerUser)} / 全体上限 ${fmtNum(r.byTotal)} / 重複 ${fmtNum(r.byDuplicate)})`,
    10_000,
  );
  await refreshStats();
}

async function main(): Promise<void> {
  const form = $<HTMLFormElement>('form-settings');

  // 初期表示に失敗してもエクスポートは使えるよう、ボタンの処理を先に登録する
  $('btn-refresh').addEventListener('click', () => void refreshStats().catch(showBackgroundError));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const prev = await rpc({ type: 'ws:getSettings' });
      const saved = await rpc({ type: 'ws:setSettings', patch: readForm(form) });
      fillForm(form, saved);
      setStatus('save-status', '保存しました', 2000);
      // 除外は今後の取り込みを止めるだけなので、保存済みの発言を消すかは確認して決める
      const added = saved.excludeUsers.filter((u) => !prev.excludeUsers.includes(u));
      if (added.length > 0 && confirm(`除外に追加した ${added.join(', ')} の保存済みの発言も削除しますか?元に戻せません。`)) {
        const { deleted } = await rpc({ type: 'ws:deleteUsers', users: added });
        setStatus('save-status', `保存し、${fmtNum(deleted)} 件を削除しました`, 5000);
        await refreshStats();
      }
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
    void rpc({ type: 'ws:clear' }).then(refreshStats).catch(showBackgroundError);
  });

  try {
    fillForm(form, await rpc({ type: 'ws:getSettings' }));
    await refreshStats();
  } catch (e) {
    // 設定を読めていないフォームを保存すると、既定値でない設定を空で上書きしてしまう
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = true;
    showBackgroundError(e);
  }
}

function showBackgroundError(e: unknown): void {
  console.error('[Who Said] options init failed', e);
  const el = $('ws-diag');
  el.textContent = '拡張機能の内部処理と通信できません。chrome://extensions で再読み込みしてください(エクスポートは実行できます)';
  el.hidden = false;
}

void main();
