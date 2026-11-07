import { NextResponse } from 'next/server';
import { requireApiSuperadmin } from '@/lib/auth';

export async function GET() {
  const auth = await requireApiSuperadmin(); if (auth.response) return auth.response;
  const { data, error } = await auth.supabase.from('prompt_chains').select('*').order('updated_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const auth = await requireApiSuperadmin(); if (auth.response) return auth.response;
  const body = await request.json();
  const name = String(body.name || '').trim();
  if (!name) return NextResponse.json({ error: 'A chain name is required.' }, { status: 400 });
  const { data, error } = await auth.supabase.from('prompt_chains').insert({ name, description: String(body.description || ''), enabled: body.enabled ?? true }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
