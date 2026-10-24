export const UNDO_WINDOW_MS = 60_000;
export interface DeletionReceipt {
  id: string;
  bookmarkId: string;
  expiresAt: string;
  remainingMs: number;
  state: "deleted" | "restored";
}
export interface UndoResult { bookmarkId: string; restored: boolean }
