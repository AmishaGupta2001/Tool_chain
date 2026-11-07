
import { requirePageSuperadmin } from "@/lib/auth";
import Dashboard from "./ui";

export const instant = false;

export default async function DashboardPage() {
    const { user } = await requirePageSuperadmin();

    return <Dashboard email={user?.email || ""} />;
}
