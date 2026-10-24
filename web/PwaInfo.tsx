import { useState } from "react";
import { checkUpdate, installApp, usePwa } from "./pwa.ts";

export function PwaUpdateNotice() {
  const state = usePwa();
  return state.update ? <p className="notice pwa-update" role="status">새 버전이 준비됐습니다. 입력을 저장한 뒤 모든 LoopShelf 창을 닫고 다시 열어 주세요.</p> : null;
}

export function PwaInfo() {
  const state = usePwa();
  const [checking, setChecking] = useState(false);
  if (import.meta.env.DEV) return <p className="field-help">개발 모드에서는 앱 설치와 오프라인 캐시를 사용하지 않습니다.</p>;
  return <details className="pwa-info"><summary>앱 설치·업데이트</summary>
    <p>{state.standalone ? "앱 창에서 이용 중입니다." : "브라우저의 ‘앱 설치’ 또는 ‘홈 화면에 추가’ 메뉴로 LoopShelf를 열 수 있습니다. 지원 여부와 메뉴 이름은 브라우저에 따라 다릅니다."}</p>
    {state.installable && !state.standalone && <button className="secondary small" onClick={() => { void installApp(); }}>LoopShelf 설치</button>}
    <p>{!state.supported ? "이 환경에서는 오프라인 안내를 사용할 수 없습니다." : state.ready ? "오프라인 안내가 준비되었습니다." : state.failed ? "오프라인 안내가 아직 준비되지 않았습니다." : "오프라인 안내를 준비 중입니다."} 북마크 조회와 저장에는 인터넷 연결이 필요합니다. 개인 데이터와 음악은 오프라인으로 저장하지 않습니다.</p>
    <PwaUpdateNotice />
    {state.failed && <p role="status">앱 준비 또는 업데이트 확인에 실패했습니다. 연결 후 다시 확인해 주세요.</p>}
    {state.supported && <button className="secondary small" disabled={checking} onClick={async () => { setChecking(true); await checkUpdate(); setChecking(false); }}>{checking ? "확인 중…" : "업데이트 확인"}</button>}
  </details>;
}
