import { NextResponse } from "next/server";
import { fetchLatestRelease } from "@local/lib/self-update";

export const revalidate = 3600;

const RELEASE_CACHE_SECONDS = 3600;

const CACHE_HEADERS = {
  "Cache-Control": `public, max-age=${RELEASE_CACHE_SECONDS}, stale-while-revalidate=${RELEASE_CACHE_SECONDS}`,
};

export async function GET() {
  const payload = await fetchLatestRelease();
  return NextResponse.json(payload, { headers: CACHE_HEADERS });
}
