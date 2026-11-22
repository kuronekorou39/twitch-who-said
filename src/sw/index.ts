import {
  clearAll,
  countMessages,
  getDb,
  getEmotes,
  getMeta,
  getStats,
  getUserStats,
  ingestBatch,
  META_LAST_PRUNE,
  META_VOD_START_PREFIX,
  putEmotes,
  queryChanges,
  queryMessages,
  setMeta,
} from '../db/db';
import { deleteUsers, prune } from '../db/prune';
import type { Req, ResMap } from '../shared/messages';
import { buildExcludeSet, loadSettings, saveSettings } from '../shared/settings';
import { viewerUrl } from '../shared/viewer-url';
import { isAllowedSender, sanitizeReq } from './guard';

const PRUNE_ALARM = 'ws-prune';
/** 定期 prune の間隔(分)と、起動時に prune を走らせる「前回からの経過」しきい値 */
const PRUNE_PERIOD_MIN = 24 * 60;
const PRUNE_STALE_MS = 12 * 60 * 60 * 1000;

let pruneRunning: Promise<ResMap['ws:prune']> | null = null;

/** prune は同時に 1 つだけ走らせる */
function runPrune(): Promise<ResMap['ws:prune']> {
  pruneRunning ??= (async () => {
    try {
      const [db, settings] = await Promise.all([getDb(), loadSettings()]);
      const r = await prune(db, settings);
      return { deleted: r.deleted, byRetention: r.byRetention, byPerUser: r.byPerUser, byTotal: r.byTotal, byDuplicate: r.byDuplicate };
    } finally {
      pruneRunning = null;
    }
  })();
  return pruneRunning;
}

async function pruneIfStale(): Promise<void> {
  const db = await getDb();
  const last = (await getMeta<number>(db, META_LAST_PRUNE)) ?? 0;
  if (Date.now() - last >= PRUNE_STALE_MS) await runPrune();
}

async function handle(req: Req): Promise<ResMap[Req['type']]> {
  const db = await getDb();
  switch (req.type) {
    case 'ws:ingest': {
      const settings = await loadSettings();
      if (req.emotes) await putEmotes(db, req.emotes);
      return ingestBatch(db, req.items, buildExcludeSet(settings, req.self));
    }
    case 'ws:emotes':
      return getEmotes(db, req.names);
    case 'ws:query':
      return queryMessages(db, req);
    case 'ws:changes':
      return queryChanges(db, req);
    case 'ws:count':
      return countMessages(db, req);
    case 'ws:userStats':
      return getUserStats(db, req.user);
    case 'ws:openViewer':
      await chrome.tabs.create({ url: viewerUrl(req) });
      return { ok: true };
    case 'ws:getVodStart':
      return { ts: (await getMeta<number>(db, META_VOD_START_PREFIX + req.vodId)) ?? null };
    case 'ws:setVodStart':
      await setMeta(db, META_VOD_START_PREFIX + req.vodId, req.ts);
      return { ok: true };
    case 'ws:stats':
      return getStats(db);
    case 'ws:clear':
      await clearAll(db);
      return { ok: true };
    case 'ws:deleteUsers':
      return { deleted: await deleteUsers(db, req.users) };
    case 'ws:getSettings':
      return loadSettings();
    case 'ws:setSettings':
      return saveSettings(req.patch);
    case 'ws:prune':
      return runPrune();
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!isReq(msg)) return false;
  const req = isAllowedSender(msg.type, sender, chrome.runtime.id, chrome.runtime.getURL('')) ? sanitizeReq(msg) : null;
  if (!req) {
    console.warn('[Who Said] rejected request', msg.type);
    sendResponse(undefined);
    return false;
  }
  handle(req).then(sendResponse, (err: unknown) => {
    console.error('[Who Said] handler error', req.type, err);
    sendResponse(undefined);
  });
  return true; // 非同期応答
});

function isReq(msg: unknown): msg is Req {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { type?: unknown }).type === 'string' &&
    (msg as { type: string }).type.startsWith('ws:')
  );
}

// ---- 定期 prune ----
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: PRUNE_PERIOD_MIN });
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.get(PRUNE_ALARM).then((a) => {
    if (!a) void chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: PRUNE_PERIOD_MIN });
  });
  void pruneIfStale().catch((e: unknown) => console.error('[Who Said] prune failed', e));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) void runPrune().catch((e: unknown) => console.error('[Who Said] prune failed', e));
});
