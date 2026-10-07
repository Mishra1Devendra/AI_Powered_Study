import type { ComponentType, SVGProps } from "react";
import {
  HomeIcon,
  NotesIcon,
  PlanIcon,
  ProgressIcon,
  QuizIcon,
  BugIcon,
  CardsIcon,
  MindmapIcon,
  HistoryIcon,
  SettingsIcon,
  ShieldIcon,
  SparkIcon,
  TutorIcon,
  VivaIcon,
} from "../ui/Icons";

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Shown in the bottom bar on mobile; the rest go under "More". */
  primary: boolean;
}

/** Routes whose feature is actually built. Others show a "Soon" tag where they are promoted. */
const BUILT_ROUTES = new Set(["/admin", "/admin/ai", "/admin/bug-reports", "/admin/audit-log", "/dashboard", "/tutor", "/notes", "/quiz", "/flashcards", "/mindmaps", "/study-plan", "/progress", "/viva", "/recommendations", "/settings"]);
export const isBuilt = (to: string): boolean => BUILT_ROUTES.has(to);

/** Shown only to administrators (the API enforces the same rule; hiding the link is just courtesy). */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { to: "/admin", label: "Admin", icon: ShieldIcon, primary: false },
  { to: "/admin/ai", label: "AI status", icon: SparkIcon, primary: false },
  { to: "/admin/bug-reports", label: "Bug reports", icon: BugIcon, primary: false },
  { to: "/admin/audit-log", label: "Audit log", icon: HistoryIcon, primary: false },
];

/** The sidebar groups the same links under small headings (order is unchanged). */
export const NAV_GROUPS: Array<{ label: string; routes: string[] }> = [
  { label: "Overview", routes: ["/dashboard"] },
  { label: "Learn", routes: ["/tutor", "/notes", "/quiz", "/flashcards", "/mindmaps"] },
  { label: "Plan & grow", routes: ["/study-plan", "/progress", "/viva", "/recommendations"] },
];

/** Single source of truth for navigation, used by the sidebar and the mobile bar. */
export const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: HomeIcon, primary: true },
  { to: "/tutor", label: "AI Tutor", icon: TutorIcon, primary: true },
  { to: "/notes", label: "My Notes", icon: NotesIcon, primary: true },
  { to: "/quiz", label: "Quiz", icon: QuizIcon, primary: true },
  { to: "/flashcards", label: "Flashcards", icon: CardsIcon, primary: false },
  { to: "/mindmaps", label: "Mind maps", icon: MindmapIcon, primary: false },
  { to: "/study-plan", label: "Study Plan", icon: PlanIcon, primary: false },
  { to: "/progress", label: "Progress", icon: ProgressIcon, primary: false },
  { to: "/viva", label: "Viva", icon: VivaIcon, primary: false },
  { to: "/recommendations", label: "Recommendations", icon: SparkIcon, primary: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, primary: false },
];
