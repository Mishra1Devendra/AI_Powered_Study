import { AiUsageBadge } from "../../features/ai-usage/AiUsageBadge";
import { screenUsesAi } from "../../lib/aiUsageEvents";
import { TileSpotlight } from "../ui/TileSpotlight";
import { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../../auth/AuthProvider";
import { ContinueBar } from "../../features/continue/ContinueBar";
import { clearResume } from "../../features/continue/resumeStore";
import { NotificationsMenu } from "../../features/notifications/NotificationsMenu";
import { SearchPalette } from "../../features/search/SearchPalette";
import { BugIcon, ChevronUpDownIcon, LogoutIcon, MenuIcon, SearchIcon } from "../ui/Icons";
import { LoadingState } from "../ui/LoadingState";
import { ThemeToggle } from "../ui/ThemeToggle";
import { Logo } from "../ui/Logo";
import { useRole } from "../../features/access/AccessGate";
import { UserMenu } from "../../features/account/UserMenu";
import { BugReportDialog } from "../../features/account/BugReportDialog";
import { ADMIN_NAV_ITEMS, NAV_GROUPS, NAV_ITEMS } from "./nav";
import { OfflineBanner } from "./OfflineBanner";

const linkBase = "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition";
const linkClass = ({ isActive }: { isActive: boolean }) =>
  `${linkBase} relative md:min-h-9 md:py-1.5 ${isActive ? "bg-white font-semibold text-brand-700 shadow-sm ring-1 ring-slate-200 before:absolute before:bottom-2.5 before:left-0 before:top-2.5 before:w-[3px] before:rounded-full before:bg-accent-500" : "text-slate-600 hover:bg-white/70 hover:text-slate-900"}`;

function useSignOut() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return async () => {
    clearResume();
    await signOut();
    navigate("/login", { replace: true });
  };
}

const SIDEBAR_KEY = "copilot-sidebar";

/** Wide or icon-only sidebar. The choice is remembered on this device (display preference only; never throws if storage is blocked). */
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, c ? "expanded" : "collapsed");
      } catch {
        /* storage blocked: applies until the page closes */
      }
      return !c;
    });
  return [collapsed, toggle];
}

function Sidebar({ collapsed, onToggle, onReportBug }: { collapsed: boolean; onToggle: () => void; onReportBug: () => void }) {
  const role = useRole();
  const byRoute = new Map(NAV_ITEMS.map((i) => [i.to, i]));
  const groups = NAV_GROUPS.map((g) => ({ label: g.label, items: g.routes.map((r) => byRoute.get(r)).filter((i): i is (typeof NAV_ITEMS)[number] => Boolean(i)) }));
  if (role === "admin") groups.push({ label: "Admin", items: ADMIN_NAV_ITEMS });
  const settings = byRoute.get("/settings");
  // Icon-only rail: the label stays in the DOM for screen readers and shows as a tooltip.
  const rail = collapsed ? "justify-center px-0" : "";
  const text = collapsed ? "sr-only" : "";
  return (
    <aside className={`fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-slate-200 bg-slate-100/70 py-4 transition-[width] duration-200 md:flex ${collapsed ? "w-[4.5rem] px-2" : "w-64 px-4"}`}>
      <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between px-2"}`}>
        <Logo iconOnly={collapsed} />
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={`mt-2 flex h-9 items-center gap-2 rounded-lg text-xs text-slate-500 transition hover:bg-white/70 hover:text-slate-900 ${collapsed ? "justify-center" : "px-3"}`}
      >
        <ChevronUpDownIcon className="h-4 w-4 rotate-90" />
        {!collapsed && <span>Collapse</span>}
      </button>
      <nav aria-label="Main" className="mt-2 flex flex-1 flex-col gap-3 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            {collapsed ? <div aria-hidden="true" className="mx-3 mb-1 border-t border-slate-200" /> : <p className="mb-1.5 px-3 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-slate-500">{g.label}</p>}
            <div className="flex flex-col gap-0.5">
              {g.items.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} title={collapsed ? label : undefined} className={({ isActive }) => `${linkClass({ isActive })} ${rail}`}>
                  <Icon />
                  <span className={text}>{label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="mt-3 border-t border-slate-200 pt-3">
        {!collapsed && <ContinueBar variant="sidebar" />}
        {settings && (
          <NavLink to={settings.to} title={collapsed ? settings.label : undefined} className={({ isActive }) => `${linkClass({ isActive })} ${rail}`}>
            <settings.icon />
            <span className={text}>{settings.label}</span>
          </NavLink>
        )}
        <button type="button" onClick={onReportBug} title={collapsed ? "Report a bug" : undefined} className={`${linkBase} w-full text-slate-600 hover:bg-white/70 hover:text-slate-900 md:min-h-9 md:py-1.5 ${rail}`}>
          <BugIcon />
          <span className={text}>Report a bug</span>
        </button>
        <div className="mt-1 border-t border-slate-200 pt-2">
          <UserMenu variant={collapsed ? "rail" : "sidebar"} />
        </div>
      </div>
    </aside>
  );
}

function MobileNav({ onReportBug }: { onReportBug: () => void }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  const signOut = useSignOut();
  const menuRef = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const primary = NAV_ITEMS.filter((i) => i.primary);
  const role = useRole();
  const more = [...NAV_ITEMS.filter((i) => !i.primary), ...(role === "admin" ? ADMIN_NAV_ITEMS : [])];

  useEffect(() => setMoreOpen(false), [location.pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    menuRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMoreOpen(false);
      moreButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  const moreActive = more.some((i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`));

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-30 md:hidden" onClick={() => setMoreOpen(false)} aria-hidden="true">
          <div className="absolute inset-0 bg-slate-900/20" />
        </div>
      )}
      {moreOpen && (
        <div ref={menuRef} id="more-menu" role="menu" aria-label="More" className="animate-fade-up fixed inset-x-3 bottom-20 z-40 rounded-2xl bg-white p-2 shadow-xl ring-1 ring-slate-200 md:hidden">
          <div className="px-1 pt-1">
            <ContinueBar variant="sidebar" role="menuitem" />
          </div>
          {more.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} role="menuitem" className={({ isActive }) => `${linkBase} ${isActive ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}>
              <Icon />
              {label}
            </NavLink>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMoreOpen(false);
              onReportBug();
            }}
            className={`${linkBase} w-full text-slate-700 hover:bg-slate-100`}
          >
            <BugIcon />
            Report a bug
          </button>
          <button type="button" role="menuitem" onClick={signOut} className={`${linkBase} w-full text-slate-700 hover:bg-slate-100`}>
            <LogoutIcon />
            Sign out
          </button>
        </div>
      )}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ul className="mx-auto flex max-w-md items-stretch justify-around">
          {primary.map(({ to, label, icon: Icon }) => (
            <li key={to} className="min-w-0 flex-1">
              <NavLink to={to} className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 text-xs font-medium ${isActive ? "text-brand-600" : "text-slate-600"}`}>
                <Icon />
                <span className="max-w-full truncate">{label}</span>
              </NavLink>
            </li>
          ))}
          <li className="min-w-0 flex-1">
            <button
              ref={moreButton}
              type="button"
              aria-expanded={moreOpen}
              aria-controls="more-menu"
              onClick={() => setMoreOpen((o) => !o)}
              className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-xs font-medium ${moreOpen || moreActive ? "text-brand-600" : "text-slate-600"}`}
            >
              <MenuIcon />
              More
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

/** The slim bar above every screen: global search (Ctrl/Cmd+K) and notifications. */
/** The name of the current screen, taken from the same navigation list the sidebar uses. */
function usePageTitle(): string {
  const { pathname } = useLocation();
  const clean = pathname.replace(/^\/dev(?=\/)/, "");
  const all = [...ADMIN_NAV_ITEMS, ...NAV_ITEMS].sort((a, b) => b.to.length - a.to.length);
  return all.find((i) => clean === i.to || clean.startsWith(`${i.to}/`))?.label ?? "";
}

function TopBar({ onSearch, onReportBug }: { onSearch: () => void; onReportBug: () => void }) {
  const title = usePageTitle();
  const { pathname } = useLocation();
  return (
    <header className="relative z-30 flex h-16 shrink-0 items-center gap-2 border-b border-slate-200/70 bg-slate-50/80 px-3 backdrop-blur-md sm:px-4 md:sticky md:top-0 md:px-8">
      <Logo compact className="md:hidden" />
      <p aria-hidden="true" className="hidden font-display text-xl font-semibold tracking-tight text-slate-900 md:block">{title}</p>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        aria-keyshortcuts="Control+K Meta+K"
        className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm text-slate-600 ring-0 transition hover:bg-slate-100 hover:text-slate-900 md:w-72 md:justify-start md:bg-white md:shadow-sm md:ring-1 md:ring-slate-200"
      >
        <SearchIcon className="h-5 w-5 shrink-0" />
        <span className="hidden md:inline">Search…</span>
        <kbd className="ml-auto hidden rounded bg-white px-1.5 py-0.5 font-sans text-xs text-slate-600 ring-1 ring-slate-200 md:inline">Ctrl K</kbd>
      </button>
      {/* Live "AI uses left today", only on the screens that ask the AI for something. */}
      {screenUsesAi(pathname) && <AiUsageBadge />}
      <NotificationsMenu />
      <button type="button" onClick={onReportBug} aria-label="Report a bug" title="Report a bug" className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 sm:flex">
        <BugIcon />
      </button>
      {/* On a phone these two live in the account menu, which keeps room in the bar for the AI-uses pill. */}
      <div className="hidden sm:block">
        <ThemeToggle />
      </div>
      <div className="md:hidden">
        <UserMenu variant="compact" />
      </div>
    </header>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  const [bugOpen, setBugOpen] = useState(false);
  // The tutor and a note workspace are full-height app screens (own scrolling areas + pinned composer), not a page.
  const fullHeight = /^\/(dev\/)?(tutor(\/|$)|notes\/[^/]+)/.test(pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={fullHeight ? "h-dvh overflow-hidden" : "min-h-screen"}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow">
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} onReportBug={() => setBugOpen(true)} />
      <div className={`${collapsed ? "md:pl-[4.5rem]" : "md:pl-64"} transition-[padding] duration-200 ${fullHeight ? "flex h-full flex-col" : ""}`}>
        <TopBar onSearch={() => setSearchOpen(true)} onReportBug={() => setBugOpen(true)} />
        <OfflineBanner />
        <main
          id="main"
          className={
            fullHeight
              ? "min-h-0 flex-1 px-3 pb-[calc(3.75rem+env(safe-area-inset-bottom)+0.75rem)] pt-3 sm:px-4 md:pb-4"
              : "mx-auto max-w-7xl px-4 pb-28 pt-6 sm:px-6 lg:px-8 md:pb-12 md:pt-8"
          }
        >
          <Suspense fallback={<LoadingState label="Loading…" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <MobileNav onReportBug={() => setBugOpen(true)} />
      <TileSpotlight />
      {bugOpen && <BugReportDialog onClose={() => setBugOpen(false)} />}
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
