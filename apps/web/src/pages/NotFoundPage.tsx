import { Link } from "react-router";
import { EmptyState } from "../components/ui/EmptyState";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <EmptyState title="Page not found">
        That page does not exist.{" "}
        <Link to="/dashboard" className="font-medium text-brand-600 hover:text-brand-700">
          Go to your dashboard
        </Link>
      </EmptyState>
    </main>
  );
}
