import { getAdminAnalyticsDashboard } from "@/services/admin-analytics-dashboard.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request?: Request) {
  let maxStalenessMs: number | undefined;
  let forceMissingAuthority = false;

  if (request?.url) {
    try {
      const url = new URL(request.url);
      const stalenessParam = url.searchParams.get("maxStalenessMs");
      if (stalenessParam !== null && !Number.isNaN(Number(stalenessParam))) {
        maxStalenessMs = Number(stalenessParam);
      }
      if (url.searchParams.get("authority") === "missing") {
        forceMissingAuthority = true;
      }
    } catch {
      // Ignore malformed request URL in synthetic test environments
    }
  }

  const data = await getAdminAnalyticsDashboard(undefined, Date.now(), {
    maxStalenessMs,
    ...(forceMissingAuthority ? { authoritySource: null } : {}),
  });

  return Response.json(
    { data },
    {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    }
  );
}