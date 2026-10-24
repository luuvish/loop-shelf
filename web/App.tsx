import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, errorMessage, session, signIn, signOut, type User } from "./api.ts";
import { Brand, Icon } from "./icons.tsx";
import { ConnectionBlocked } from "./connection.ts";
import { PwaInfo } from "./PwaInfo.tsx";
import { Library } from "./Library.tsx";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [connection, setConnection] = useState<"online" | "offline" | "checking" | "unavailable">(navigator.onLine ? "online" : "offline");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const checkSession = useCallback(async (clear = false) => {
    const request = ++sequence.current;
    if (clear) setUser(undefined);
    setError("");
    if (!navigator.onLine) { setConnection("offline"); return; }
    try { const value = await session(); if (request === sequence.current) { setUser(value); setConnection("online"); } }
    catch (cause) { if (request === sequence.current) { setConnection("unavailable"); setError(errorMessage(cause)); } }
  }, []);
  useEffect(() => {
    void checkSession();
    const expired = () => { sequence.current++; setUser(null); setNotice("로그인이 만료되거나 계정이 변경되었습니다. 다시 로그인해 주세요."); };
    const offline = () => { sequence.current++; setConnection("offline"); };
    const online = () => { setConnection("checking"); void checkSession(); };
    window.addEventListener("offline", offline); window.addEventListener("online", online);
    const focus = () => { void checkSession(); };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) void checkSession(true); };
    window.addEventListener("loopshelf:session-expired", expired);
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageshow);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("loopshelf-auth");
      channel.current.onmessage = () => { void checkSession(true); };
    }
    return () => {
      sequence.current++; channel.current?.close(); channel.current = null;
      window.removeEventListener("offline", offline); window.removeEventListener("online", online);
      window.removeEventListener("loopshelf:session-expired", expired);
      window.removeEventListener("focus", focus); window.removeEventListener("pageshow", pageshow);
    };
  }, [checkSession]);
  async function loggedIn() { setNotice(""); channel.current?.postMessage("changed"); await checkSession(true); }
  async function logout() {
    await signOut();
    sequence.current++; setUser(null); setNotice("로그아웃했습니다."); channel.current?.postMessage("changed");
  }
  const blocked = connection !== "online";
  return <ConnectionBlocked value={blocked}>
    {blocked && <main className="boot connection-gate"><Brand /><h1>{connection === "checking" ? "연결을 확인하는 중…" : "연결이 필요해요"}</h1>
      <p>내 라이브러리를 보거나 저장하려면 서버에 연결해야 합니다.</p>
      <p className="muted">작성 중인 내용은 이 창에 잠시 유지됩니다. 창을 닫거나 새로고침하면 저장하지 않은 내용은 사라집니다.</p>
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={connection === "checking"} onClick={() => { setConnection("checking"); void checkSession(); }}>연결 다시 확인</button>
    </main>}
    <div hidden={blocked} inert={blocked}>
      {user === undefined ? <main className="boot"><Brand /><div role="status">나의 음악 선반을 불러오는 중…</div></main>
        : user ? <Library key={user.sessionId} user={user} onLogout={logout} /> : <Login notice={notice} onSuccess={loggedIn} />}
    </div>
  </ConnectionBlocked>;
}

function Login({ notice, onSuccess }: { notice: string; onSuccess: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const data = new FormData(event.currentTarget);
    pending.current = true; setBusy(true); setError("");
    try { await signIn(String(data.get("email")).trim(), String(data.get("password"))); await onSuccess(); }
    catch (cause) { setError(cause instanceof ApiError && cause.status === 401 ? "이메일 또는 비밀번호가 올바르지 않습니다." : errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <main className="login-layout">
    <section className="login-story"><Brand /><div className="story-body"><span className="eyebrow">YOUR PERSONAL SOUNDTRACK ARCHIVE</span><h1>게임이 끝나도,<br />음악은 남으니까.</h1><p>다시 만나고 싶은 게임 음악을<br />나만의 선반에 차곡차곡.</p><div className="record-art" aria-hidden="true"><div className="record"><div className="record-label"><Icon name="shelf" /></div></div><span className="sleeve-mark">LOOP / 01<br />KEEP YOUR MOMENTS</span></div></div><p className="story-footer">게임 음악을 발견하고, 나만의 선반에.</p></section>
    <section className="login-panel"><div className="login-form"><span className="eyebrow">WELCOME TO LOOPSHELF</span><h2>나의 선반으로</h2><p className="muted">로그인하고 모아 둔 음악을 만나 보세요.</p>
      {notice && <p className="notice" role="status">{notice}</p>}
      <form onSubmit={(event) => { void submit(event); }}><fieldset disabled={busy}>
        <label htmlFor="email">이메일</label><input id="email" name="email" type="email" autoComplete="username" required placeholder="you@example.com" />
        <label htmlFor="password">비밀번호</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} placeholder="비밀번호 입력" />
      </fieldset>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary login-submit" disabled={busy}>{busy ? "로그인 중…" : "로그인"}<span aria-hidden="true">→</span></button></form>
      <div className="login-help"><Icon name="info" /><p>운영자가 만든 계정으로 이용할 수 있습니다.<br />계정 생성·비밀번호 재설정은 운영자에게 요청해 주세요.</p></div>
      <p className="login-footnote">내 북마크와 메모는 나에게만 보입니다.</p><PwaInfo />
    </div></section>
  </main>;
}
