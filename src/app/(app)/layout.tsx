import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Header } from "@/components/header";
import { CleanProgressWatcher } from "@/components/clean-progress";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session || session.error) redirect("/login");

  return (
    <>
      <Header
        name={session.user?.name ?? "You"}
        image={session.user?.image ?? null}
      />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
      <CleanProgressWatcher />
    </>
  );
}
