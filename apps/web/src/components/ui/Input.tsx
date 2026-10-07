import { useId, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

const EyeIcon = ({ off }: { off: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </svg>
);

/**
 * Labelled text field with accessible error/hint wiring (aria-invalid, aria-describedby).
 * Password fields get a show/hide button and a Caps Lock warning, so people can check what they typed.
 */
export function Input({ label, error, hint, id, className = "", type, onKeyUp, onBlur, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const isPassword = type === "password";
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const describedBy = error ? `${inputId}-error` : caps && isPassword ? `${inputId}-caps` : hint ? `${inputId}-hint` : undefined;

  const checkCaps = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isPassword) setCaps(e.getModifierState?.("CapsLock") ?? false);
    onKeyUp?.(e);
  };

  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="relative">
        <input
          {...rest}
          id={inputId}
          type={isPassword && shown ? "text" : type}
          onKeyUp={checkCaps}
          onBlur={(e) => {
            setCaps(false);
            onBlur?.(e);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`block h-11 w-full rounded-xl bg-white px-3.5 text-sm text-slate-900 ring-1 transition duration-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 ${isPassword ? "pr-11" : ""} ${
            error ? "ring-red-400 focus:ring-red-500" : "ring-slate-300 hover:ring-slate-400 focus:ring-brand-600"
          }`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            aria-pressed={shown}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-slate-500 transition hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            <EyeIcon off={shown} />
          </button>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="mt-1.5 text-sm text-red-700">
          {error}
        </p>
      ) : caps && isPassword ? (
        <p id={`${inputId}-caps`} className="mt-1.5 text-sm text-amber-700">
          Caps Lock is on.
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
