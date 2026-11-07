
import { NextResponse } from "next/server";
import { requireApiSuperadmin } from "@/lib/auth";

type Ctx = {
 params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Ctx) {
 const auth = await requireApiSuperadmin();

 if (auth.response) return auth.response;

 const { id } = await params;

 let body: { orderedIds?: unknown };

 try {
  body = await request.json();
 } catch {
  return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
  );
 }

 const { orderedIds } = body;

 if (
     !Array.isArray(orderedIds) ||
     !orderedIds.every(
         (stepId): stepId is string =>
             typeof stepId === "string" &&
             /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                 stepId
             )
     )
 ) {
  return NextResponse.json(
      { error: "orderedIds must be an array of valid step IDs." },
      { status: 400 }
  );
 }

 if (new Set(orderedIds).size !== orderedIds.length) {
  return NextResponse.json(
      { error: "Duplicate step IDs are not allowed." },
      { status: 400 }
  );
 }

 const { error } = await auth.supabase.rpc(
     "reorder_prompt_chain_steps",
     {
      p_chain_id: id,
      p_ordered_ids: orderedIds,
     }
 );

 if (error) {
  console.error("[Step Reorder Error]", error);

  return NextResponse.json(
      { error: error.message },
      { status: 500 }
  );
 }

 return NextResponse.json({ ok: true });
}
