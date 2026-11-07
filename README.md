# NYC Unhinged Prompt Chain Tool — Week 8

Next.js 16 app for superadmin-only prompt-chain management, Gemini execution, and generated-media review.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in the Supabase URL, Supabase publishable/anon key, and Gemini API key.
3. In the existing NYC Unhinged Supabase project, run `supabase/week8_setup.sql` in the SQL Editor. This adds the `generated_media` table, a private Storage bucket, and superadmin RLS policies for the prompt-chain tables.
4. Run locally: `npm run dev`
5. Sign in at `/login` with an existing Supabase account whose `profiles.is_superadmin` is `true`.

## Gemini

The app runs enabled prompt steps in `step_order`. Templates support:
- `{{input}}` — the initial user brief
- `{{previous_output}}` — output from the previous step
- `{{chain_name}}` — current chain name

After the text steps, the app asks the configured Gemini image model to generate an image from the final output. Configure `GEMINI_TEXT_MODEL` and `GEMINI_IMAGE_MODEL` if your Google AI Studio project uses different available models. Image generation requires a Gemini model/API tier that supports image output. The default image model is a configurable starting point; if Google has retired or restricted it for your project, set `GEMINI_IMAGE_MODEL` to an image-capable model enabled for your API key.

## Deploy to Vercel

Add all four environment variables from `.env.example` to the Vercel project (use real values, not placeholders), then redeploy. Disable Vercel Deployment Protection if the assignment requires Incognito access. Keep `GEMINI_API_KEY` server-side; do not prefix it with `NEXT_PUBLIC_`.

## Security

Every application API route checks the Supabase session and `profiles.is_superadmin` on the server. Do not expose a service-role key in the browser or commit `.env.local`. The SQL script adds named superadmin policies; review any older permissive policies already attached to these tables, because PostgreSQL combines permissive policies with OR semantics.
