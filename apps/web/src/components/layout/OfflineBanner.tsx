import { OFFLINE_MESSAGE } from "../../lib/errors";
import { useOnlineStatus } from "../../lib/useOnlineStatus";

/** Shown only while the browser says there is no connection. It promises nothing about offline use. */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div role="status" aria-live="polite" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      {OFFLINE_MESSAGE}
    </div>
  );
}
