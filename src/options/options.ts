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

async function refreshStats(): Promise<void> {
  const st = await rpc({ type: 'ws:stats' });
  $('st-messages').textContent = fmtNum(st.messages);
  $('st-users').textContent = fmtNum(st.users);
  $('st-channels').textContent = fmtNum(st.channels);
  $('st-oldest').textContent = fmtDate(st.oldestTs);
  $('st-newest').textContent = fmtDate(st.newestTs);
  $('st-last-ingest').textContent = fmtDate(st.lastIngestAt);
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
      const status = $('save-status');
      status.textContent = '保存しました';
      setTimeout(() => (status.textContent = ''), 2000);
    })();
  });

  $('btn-clear').addEventListener('click', () => {
    if (!confirm('保存済みのチャット履歴をすべて削除します。元に戻せません。よろしいですか?')) return;
    void rpc({ type: 'ws:clear' }).then(refreshStats);
  });
}

void main();
