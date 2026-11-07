import { NextResponse } from 'next/server';
import { requireApiSuperadmin } from '@/lib/auth';
type Ctx = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Ctx) {
 const auth = await requireApiSuperadmin(); if (auth.response) return auth.response; const { id } = await params;
 const { data, error } = await auth.supabase.from('prompt_chain_steps').select('*').eq('chain_id', id).order('step_order');
 if (error) return NextResponse.json({ error: error.message }, { status: 500 }); return NextResponse.json(data);
}
export async function POST(request: Request, { params }: Ctx) {
 const auth = await requireApiSuperadmin(); if (auth.response) return auth.response; const { id } = await params; const body = await request.json();
 const name = String(body.name || '').trim(); const prompt_template = String(body.prompt_template || '').trim();
 if (!name || !prompt_template) return NextResponse.json({ error: 'Step name and prompt template are required.' }, { status: 400 });
 const { data: existing } = await auth.supabase.from('prompt_chain_steps').select('step_order').eq('chain_id', id).order('step_order', { ascending: false }).limit(1).maybeSingle();
 const { data, error } = await auth.supabase.from('prompt_chain_steps').insert({ chain_id: id, name, prompt_template, enabled: body.enabled ?? true, step_order: (existing?.step_order ?? 0) + 1 }).select().single();
 if (error) return NextResponse.json({ error: error.message }, { status: 500 }); return NextResponse.json(data, { status: 201 });
}
