import type { Req, ResMap } from '../shared/messages';
import { buildExcludeSet, loadSettings, saveSettings } from '../shared/settings';
import { clearAll, getDb, getMeta, getStats, getUserStats, ingestBatch, queryMessages, setMeta } from './db';

const VOD_START_META_PREFIX = 'vodStart:';

async function handle(req: Req): Promise<ResMap[Req['type']]> {
  const db = await getDb();
  switch (req.type) {
    case 'ws:ingest': {
      const settings = await loadSettings();
      return ingestBatch(db, req.items, buildExcludeSet(settings));
    }
    case 'ws:query':
      return queryMessages(db, req);
    case 'ws:userStats':
      return getUserStats(db, req.user);
    case 'ws:getVodStart':
      return { ts: (await getMeta<number>(db, VOD_START_META_PREFIX + req.vodId)) ?? null };
    case 'ws:setVodStart':
      await setMeta(db, VOD_START_META_PREFIX + req.vodId, req.ts);
      return { ok: true };
    case 'ws:stats':
      return getStats(db);
    case 'ws:clear':
      await clearAll(db);
      return { ok: true };
    case 'ws:getSettings':
      return loadSettings();
    case 'ws:setSettings':
      return saveSettings(req.patch);
    case 'ws:prune':
      return { deleted: 0 }; // M4 で実装
    case 'ws:export':
      return { lines: [] }; // M4 で実装
    case 'ws:import':
      return { imported: 0 }; // M4 で実装
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!isReq(msg)) return false;
  handle(msg).then(sendResponse, (err: unknown) => {
    console.error('[Who Said] handler error', msg.type, err);
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
