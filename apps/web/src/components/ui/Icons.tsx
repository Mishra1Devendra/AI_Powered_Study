import type { ReactElement, SVGProps } from "react";

function make(paths: ReactElement) {
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5" {...props}>
        {paths}
      </svg>
    );
  };
}

export const HomeIcon = make(<path d="M3 11l9-8 9 8M5 10v10h14V10" />);
export const TutorIcon = make(<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z" />);
export const NotesIcon = make(<path d="M7 3h8l4 4v14H7zM14 3v5h5M10 13h6M10 17h6" />);
export const QuizIcon = make(<path d="M9 9a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.1-1.5 2.4M12 18h.01M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z" />);
export const PlanIcon = make(<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" />);
export const ProgressIcon = make(<path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />);
export const VivaIcon = make(<path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />);
export const SettingsIcon = make(<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2.2.6-1.6-1.2L14.8 4h-5.6l-.4 2.4-1.6 1.2L5 7l-2 4 2 1v1.6L3 15l2 4 2.2-.6 1.6 1.2.4 2.4h5.6l.4-2.4 1.6-1.2L19 19l2-4-2-1z" />);
export const MenuIcon = make(<path d="M4 7h16M4 12h16M4 17h16" />);
export const LogoutIcon = make(<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />);
export const SparkIcon = make(<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" />);
export const ArrowRightIcon = make(<path d="M5 12h14M13 6l6 6-6 6" />);
export const CheckIcon = make(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const ClockIcon = make(<path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />);
export const UploadIcon = make(<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4" />);
export const FlameIcon = make(<path d="M12 22c4 0 7-2.8 7-7 0-3-1.8-5-3.5-7-.4 1.4-1.2 2.3-2.2 2.8C13.5 8 12.6 4.8 10 2c0 3.5-5 6-5 13 0 4.2 3 7 7 7z" />);
export const TargetIcon = make(<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12h.01" />);
export const BookIcon = make(<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16" />);
export const SearchIcon = make(<path d="M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM16 16l4 4" />);
export const ShieldIcon = make(<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6zM9 12l2 2 4-4" />);
export const BugIcon = make(<path d="M9 7a3 3 0 0 1 6 0M8 9h8v5a4 4 0 0 1-8 0zM4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2M12 11v8" />);
export const KeyIcon = make(<path d="M14.5 9.5a4 4 0 1 1-2.8 3.8L4 21v-3l2-.5.5-2 2-.5 3.2-3.2a4 4 0 0 1 2.8-2.3zM16.5 8h.01" />);
export const HistoryIcon = make(<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />);
export const ChevronUpDownIcon = make(<path d="M8 9l4-4 4 4M8 15l4 4 4-4" />);
export const SunIcon = make(<path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />);
export const MoonIcon = make(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />);
export const CardsIcon = make(<path d="M7 7V5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2M4 9a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM8 13h4M8 16h3" />);
export const MindmapIcon = make(<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM10.4 10.6L6.4 5.4M13.6 10.6l4-5.2M10.4 13.4l-4 5.2M13.6 13.4l4 5.2" />);
