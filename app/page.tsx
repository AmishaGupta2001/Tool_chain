export const instant = false;
import { redirect } from 'next/navigation';
import { requirePageSuperadmin } from '@/lib/auth';
export default async function HomePage(){await requirePageSuperadmin();redirect('/dashboard')}
