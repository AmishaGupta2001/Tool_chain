import { NextResponse } from 'next/server';
import { requireApiSuperadmin } from '@/lib/auth';
type Ctx = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Ctx) {
  const auth = await requireApiSuperadmin(); if (auth.response) return auth.response;
  const { id } = await params; const body = await request.json();
  const patch: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'enabled']) if (key in body) patch[key] = body[key];
  const { data, error } = await auth.supabase.from('prompt_chains').update(patch).eq('id', id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 }); return NextResponse.json(data);
}
export async function DELETE(_: Request, { params }: Ctx) {
  const auth = await requireApiSuperadmin(); if (auth.response) return auth.response;
  const { id } = await params;
  const { error: stepError } = await auth.supabase.from('prompt_chain_steps').delete().eq('chain_id', id);
  if (stepError) return NextResponse.json({ error: stepError.message }, { status: 500 });
  const { error } = await auth.supabase.from('prompt_chains').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 }); return NextResponse.json({ ok: true });
}
