import { Metadata } from "next";
import { CampaignSearch } from "@/components/modules/campaigns/CampaignSearch";

export const metadata: Metadata = {
  title: "Explore Campaigns | Fundable Protocol",
  description: "Search and filter campaigns by tree species, planting location, region, and creator with real-time impact metrics.",
};

export default function CampaignsPage() {
  return (
    <div
      className="container mx-auto py-8 px-4"
      data-testid="campaigns-page"
      data-e2e-page="campaigns"
    >
      <div className="mb-6" data-testid="campaigns-header">
        <h1
          className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-white"
          data-testid="campaigns-heading"
        >
          Explore Impact Campaigns
        </h1>
        <p
          className="mt-2 text-zinc-600 dark:text-zinc-400"
          data-testid="campaigns-description"
        >
          Find and back environmental campaigns with full-text search by tree species, geographic location, and verified creator.
        </p>
      </div>

      <div data-testid="campaigns-search-region" data-e2e-region="campaign-discovery">
        <CampaignSearch />
      </div>
    </div>
  );
}