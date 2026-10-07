import { TUTOR_MODES, TUTOR_MODE_INFO, type TutorMode } from "@copilot/shared";

interface ModeBarProps {
  armed: TutorMode | null;
  disabled: boolean;
  onSelect: (mode: TutorMode) => void;
}

/**
 * Tutoring modes. Each one changes how the tutor responds (server-side instructions); they are
 * not decorative. Selecting one either acts immediately on the conversation so far, or arms the
 * mode for the next message - see ChatPane.
 */
export function ModeBar({ armed, disabled, onSelect }: ModeBarProps) {
  return (
    <div role="group" aria-label="Tutoring modes" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
      {TUTOR_MODES.map((mode) => {
        const info = TUTOR_MODE_INFO[mode];
        const active = armed === mode;
        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            title={info.hint}
            onClick={() => onSelect(mode)}
            className={`h-9 shrink-0 whitespace-nowrap rounded-full px-3.5 text-sm font-medium ring-1 transition disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "bg-brand-600 text-white ring-brand-600"
                : "bg-white text-slate-700 ring-slate-200 hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-100"
            }`}
          >
            {active && <span aria-hidden="true">✓ </span>}
            {info.label}
          </button>
        );
      })}
    </div>
  );
}
