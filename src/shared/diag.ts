/** content script の自己診断結果。chrome.storage.local に保存し、設定画面がバッジ表示に使う */
export interface Diag {
  /** 判定日時 epoch ms */
  at: number;
  /** 判定したページ("live:<channel>" / "vod:<id>") */
  page: string;
  /** 行らしき要素を見た数 / 抽出できた数 */
  seen: number;
  extracted: number;
  /** false ならセレクタ破損の疑い */
  ok: boolean;
}

export const DIAG_STORAGE_KEY = 'diag';

export async function saveDiag(d: Diag): Promise<void> {
  try {
    await chrome.storage.local.set({ [DIAG_STORAGE_KEY]: d });
  } catch {
    /* 拡張が更新直後などで context が無効なときは無視 */
  }
}

export async function loadDiag(): Promise<Diag | null> {
  const raw = await chrome.storage.local.get(DIAG_STORAGE_KEY);
  return (raw[DIAG_STORAGE_KEY] as Diag | undefined) ?? null;
}
