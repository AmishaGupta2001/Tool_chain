"use client";
import { signIn } from "next-auth/react";
export default function LoginPage() {
  return <main className="flex min-h-screen items-center justify-center bg-gray-950 px-6 text-white"><div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 p-8 text-center"><h1 className="text-2xl font-bold">NYC Unhinged Prompt Chain Tool</h1><p className="my-5 text-sm text-gray-400">Sign in with your authorized Google account.</p><button onClick={() => signIn("google", { callbackUrl: "/" })} className="w-full rounded-lg bg-blue-600 p-3 font-semibold hover:bg-blue-500">Continue with Google</button></div></main>;
}
