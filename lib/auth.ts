import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-admin";

async function findSupabaseId(email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("admin_user_id_by_email", { p_email: email });
  if (!error && typeof data === "string") return data;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data.users.length) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

export const authOptions: NextAuthOptions = {
  providers: [GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! })],
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;
      const id = await findSupabaseId(user.email);
      if (!id) return "/unauthorized";
      const { data: profile, error } = await supabaseAdmin.from("profiles").select("is_superadmin, is_banned").eq("id", id).single();
      return !error && profile?.is_superadmin === true && profile?.is_banned !== true;
    },
    async jwt({ token, user }) {
      if (user?.email) token.supabaseId = await findSupabaseId(user.email);
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.supabaseId) (session.user as any).supabaseId = token.supabaseId;
      return session;
    },
  },
  pages: { signIn: "/login", error: "/login" },
};

export async function getSuperadmin() {
  const session = await getServerSession(authOptions);
  const id = (session?.user as any)?.supabaseId as string | undefined;
  if (!session?.user?.email || !id) return { session: null, authorized: false, supabase: supabaseAdmin };
  const { data: profile, error } = await supabaseAdmin.from("profiles").select("is_superadmin, is_banned").eq("id", id).single();
  return { session, authorized: !error && profile?.is_superadmin === true && profile?.is_banned !== true, supabase: supabaseAdmin };
}

export async function requireApiSuperadmin() {
  const result = await getSuperadmin();
  if (!result.session) return { ...result, response: NextResponse.json({ error: "Please sign in." }, { status: 401 }) };
  if (!result.authorized) return { ...result, response: NextResponse.json({ error: "Superadmin access required." }, { status: 403 }) };
  return { ...result, response: null };
}

export async function requirePageSuperadmin() {
  const result = await getSuperadmin();
  if (!result.session) redirect("/login");
  if (!result.authorized) redirect("/unauthorized");
  return { user: result.session.user, supabase: result.supabase };
}
