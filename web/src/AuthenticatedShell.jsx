import { Link, Outlet, useLocation } from "react-router-dom";

export function AuthenticatedShell({ user, authBusy, onLogout, subtitle, sidebar }) {
  const loc = useLocation();
  const p = loc.pathname;
  const hideSidebar = p.startsWith("/rag") || p.startsWith("/settings");
  const tab = p.startsWith("/rag") ? "rag" : p.startsWith("/settings") ? "settings" : "chat";

  return (
    <div className="app app--shell">
      <header className="header">
        <div className="titleRow">
          <div className="titleRowLeft">
            <div className="title">DeepResearch</div>
            <nav className="tabs" aria-label="主功能">
              <Link to="/" className={`tab ${tab === "chat" ? "tab--active" : ""}`}>
                对话
              </Link>
              <Link to="/rag" className={`tab ${tab === "rag" ? "tab--active" : ""}`}>
                知识库
              </Link>
              <Link to="/settings" className={`tab ${tab === "settings" ? "tab--active" : ""}`}>
                设置
              </Link>
            </nav>
          </div>
          <div className="headerRight">
            <div className="userBar">
              <span className="userName">{user.username}</span>
              <button className="ghost ghost--small" type="button" onClick={onLogout} disabled={authBusy}>
                退出
              </button>
            </div>
            <div className="badge">联网研究</div>
          </div>
        </div>
        <div className="subtitle">{subtitle}</div>
      </header>

      <div className={`appBody ${hideSidebar ? "appBody--ragFull" : ""}`}>
        {!hideSidebar ? sidebar : null}
        <main className={hideSidebar ? "main main--ragFull" : "main main--withSidebar"}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
