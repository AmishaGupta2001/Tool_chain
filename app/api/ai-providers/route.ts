import { NextResponse } from "next/server";
import { requireApiSuperadmin } from "@/lib/auth";
import { providerStatus } from "@/lib/ai";

// Tells the dashboard which providers have API keys configured (never returns the keys).
export async function GET() {
  const auth = await requireApiSuperadmin();
  if (auth.response) return auth.response;

  return NextResponse.json(providerStatus());
}