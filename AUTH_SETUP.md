# Google sign-in setup

This build uses the same NextAuth v4 + Google OAuth pattern as the supplied NYC Unhinged Admin source. It does not use Supabase email/password sign-in.

1. Copy `.env.example` to `.env.local`.
2. Set the Supabase project URL, anon key, and **service-role key** from the existing Supabase project. The service-role key is server-only; never prefix it with `NEXT_PUBLIC_` or commit it.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the same Google OAuth client used by the Admin app.
4. Generate `NEXTAUTH_SECRET` with `openssl rand -base64 32`. Set `NEXTAUTH_URL=http://localhost:3000` locally.
5. In Google Cloud Console, add `http://localhost:3000/api/auth/callback/google` to Authorized redirect URIs. For deployment, add `https://YOUR-VERCEL-DOMAIN/api/auth/callback/google` too.
6. Start with `npm install` then `npm run dev`.

Google accounts are matched to existing Supabase Auth users by email. Only profiles with `is_superadmin=true` and not banned are accepted. The server re-checks the profile on protected page and API requests.

Note: This project uses Next.js 16 and NextAuth v4. Verify `npm run build` locally before deploying. The Supabase service-role key is required because NextAuth sessions are separate from Supabase Auth sessions; database and storage operations run server-side after verifying the NextAuth session.
