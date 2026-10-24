import { useEffect, useRef, useState } from "react";
import { ARCHIVE_MAX_BYTES } from "../src/shared/transfer.ts";
import type { ImportConflictReason, ImportPreview } from "../src/shared/transfer.ts";
import type { BookmarkArchive } from "../src/shared/transfer.ts";
import type { CatalogArchive } from "../src/shared/catalog-transfer.ts";
import { errorMessage, type BookmarkApi } from "./api.ts";
import { Dialog } from "./dialogs.tsx";

const conflictNames: Record<ImportConflictReason, string> = {
  id_conflict: "그대로 복원할 수 없는 ID", source_conflict: "같은 주소를 다른 ID로 저장한 항목",
  content_conflict: "현재 내용이나 날짜가 다른 항목", connection_conflict: "현재 출처 연결이 다른 항목",
};
export function TransferDialog({ api, onClose, onChanged }: { api: BookmarkApi; onClose: () => void; onChanged: () => void }) {
  const [file, setFile] = useState<{ name: string; archive: unknown } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const urls = useRef(new Set<string>());
  useEffect(() => () => { controller.current?.abort(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); }, []);

  function download(archive: BookmarkArchive | CatalogArchive) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(archive) + "\n"], { type: "application/json" }));
    urls.current.add(url);
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `${archive.format === "loopshelf-catalog" ? "loopshelf-catalog" : "loopshelf"}-${archive.exportedAt.slice(0, 10)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
    setNotice("JSON 다운로드를 시작했습니다. 브라우저의 다운로드 목록에서 파일을 확인해 주세요.");
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    const read = new AbortController(); controller.current = read;
    try { await action(read.signal); }
    catch (cause) { if (!read.signal.aborted) setError(errorMessage(cause)); }
    finally {
      locked.current = false;
      if (!read.signal.aborted) { setBusy(false); requestAnimationFrame(() => feedback.current?.focus()); }
    }
  }
  async function selectFile(selected: File | undefined) {
    setFile(null); setPreview(null); setError(""); setNotice("");
    if (!selected) return;
    await run(async (signal) => {
      if (selected.size > ARCHIVE_MAX_BYTES) { setError("8 MiB 이하의 JSON 파일을 선택해 주세요."); return; }
      const text = await selected.text();
      if (signal.aborted) return;
      try { setFile({ name: selected.name, archive: JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown }); }
      catch { setError("JSON 파일을 읽을 수 없습니다. LoopShelf에서 내보낸 파일을 선택해 주세요."); }
    });
  }
  return <Dialog title="데이터 내보내기·가져오기" onClose={onClose} busy={busy}>
    <p className="dialog-description">내 북마크와 저장한 카탈로그를 각각 JSON 파일로 보관하고 복원합니다. 파일에는 개인 메모가 포함됩니다.</p>
    <p className="field-help">북마크 JSON과 카탈로그 JSON은 별도 파일입니다. 두 종류를 모두 보관하려면 각각 내보내세요. 카탈로그는 자료 종류를 담은 v2로 내보내며 기존 v1도 가져올 수 있습니다. 계정 정보·비밀번호·음원·공용 음악 메타데이터는 포함하지 않습니다.</p>
    <div className="transfer-feedback" ref={feedback} tabIndex={-1}>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}</div>
    <section className="transfer-section"><h3>내 북마크 보관하기</h3><p>검색·즐겨찾기 필터와 관계없이 직접 입력한 북마크와 그 출처 연결을 모두 담습니다. 계정 정보·비밀번호·음원은 포함하지 않습니다.</p>
      <button className="secondary" disabled={busy} onClick={() => { void run(async (signal) => {
        const archive = await api.exportArchive(signal);
        if (signal.aborted) return;
        download(archive);
      }); }}>JSON 내보내기</button>
    </section>
    <section className="transfer-section"><h3>내 카탈로그 보관하기</h3><p>개인 제목·메모·즐겨찾기·출처 판단과 참조 ID를 담습니다. 다른 설치에 같은 원본이 없으면 원본 미연결 항목으로 복원하며 개인 내용은 편집·삭제·다시 내보낼 수 있습니다.</p>
      <button className="secondary" disabled={busy} onClick={() => { void run(async (signal) => {
        const archive = await api.exportCatalogArchive(signal); if (!signal.aborted) download(archive);
      }); }}>카탈로그 JSON 내보내기</button>
    </section>
    <section className="transfer-section"><h3>파일에서 가져오기</h3><p>원래 ID·제목·메모·즐겨찾기·출처 연결을 복원합니다. 현재 선반과 완전히 같은 항목은 건너뛰고, 내용이나 ID가 충돌하면 전체 가져오기를 중단합니다.</p>
      <label htmlFor="archive-file">LoopShelf JSON 파일</label><input ref={input} id="archive-file" type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { void selectFile(event.target.files?.[0]); }} />
      <p className="field-help">파일당 최대 8 MiB · 해당 종류 5,000개. 선택한 파일은 검사할 때 서버로 전송되며, 가져오기를 확인해야 선반에 저장됩니다.</p>
      {file && <><p className="transfer-filename">선택한 파일: {file.name}</p><button className="secondary" disabled={busy} onClick={() => {
        setPreview(null); void run(async (signal) => { const result = await api.previewImport(file.archive, signal); if (!signal.aborted) setPreview(result); });
      }}>파일 검사</button></>}
      {preview && <section className="transfer-preview" aria-label="가져오기 검사 결과"><h4>가져오기 전에 확인하세요</h4>
        <p>{preview.scope === "catalog" ? "카탈로그 개인 자료" : "직접 입력 북마크"}</p>
        <dl className="transfer-counts"><div><dt>추가</dt><dd>{preview.addCount}개</dd></div><div><dt>동일 항목</dt><dd>{preview.skipCount}개</dd></div><div><dt>충돌</dt><dd>{preview.conflictCount}개</dd></div></dl>
        <p>새로 복원할 출처 연결: {preview.connectionCount}개</p>
        {preview.scope === "catalog" && <p className="notice">원본 미연결로 복원: {preview.unresolvedCount}개. 원본을 추측해서 연결하거나 음악 정보를 생성하지 않습니다. 나의 제목·메모·즐겨찾기와 출처 판단은 보존됩니다.</p>}
        {preview.conflictCount ? <><p role="alert">충돌이 있어 아무것도 가져올 수 없습니다. 파일과 현재 선반을 확인해 주세요.</p><ul className="transfer-conflicts">{preview.conflicts.map((conflict) => <li key={conflict.index}><strong>{conflict.title}</strong><span>{conflict.index + 1}번째 항목 · {conflictNames[conflict.reason]}</span></li>)}</ul>{preview.conflictCount > preview.conflicts.length && <p className="field-help">처음 50개 충돌을 표시합니다.</p>}</> : <>
          <p className="field-help">기존 항목을 삭제하거나 덮어쓰지 않습니다. 검사 결과는 10분 동안 유효하며 선반이 바뀌면 다시 검사합니다.</p>
          <button className="primary" disabled={busy || !preview.token} onClick={() => {
            const token = preview.token;
            if (!file || !token) return;
            setPreview(null);
            void run(async (signal) => {
              const result = await api.importArchive(file.archive, token, signal);
              if (signal.aborted) return;
              setNotice(`${result.scope === "catalog" ? "카탈로그 개인 항목" : "북마크"} ${result.added}개와 출처 연결 ${result.connectionsAdded}개를 복원했습니다. 동일한 ${result.skipped}개는 유지했습니다.${result.scope === "catalog" ? ` 원본 미연결 ${result.unresolved}개입니다.` : ""}`);
              setFile(null); if (input.current) input.current.value = ""; onChanged();
            });
          }}>확인하고 가져오기</button>
        </>}
      </section>}
    </section>
    <footer className="dialog-actions"><button className="secondary" onClick={onClose} disabled={busy}>완료</button></footer>
  </Dialog>;
}
