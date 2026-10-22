"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Recycle } from "lucide-react";

import { CampaignDonationPanel } from "@/components/modules/campaign/donation/CampaignDonationPanel";
import { CarbonTradingPanel } from "@/components/modules/campaign/carbon/CarbonTradingPanel";
import { SimulationReview } from "@/components/modules/transaction/SimulationReview";

/**
 * One-time charitable donation page (issue #1001).
 *
 * Unlike the tree-selection sponsorship flow, a donation here is handed to the
 * campaign creator's discretion so it can be spent on project costs.
 *
 * This page also exposes the secondary market for trading carbon credits
 * earned from campaigns, where sponsors can sell earned credits to other
 * participants.
 *
 * Before any funding transaction is signed, the `SimulationReview` surface
 * (issue #71) shows the amount, destination, fees, and contract effects. It
 * handles stale simulations (the underlying state changed since the preview was
 * generated) and rejected simulations so the user can re-run or abort.
 */
export default function CampaignDonatePage() {
  const { id } = useParams<{ id: string }>();
  const campaignId = String(id);

  return (
    <main className="container mx-auto max-w-5xl px-4 py-10">
      <Link
        href={`/campaigns/${campaignId}`}
        className="inline-flex items-center text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Back to campaign
      </Link>

      <header className="mt-6">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Make a one-time donation</h1>
        <p className="mt-3 max-w-2xl text-sm text-zinc-400">
          Contribute to this campaign without buying specific trees. Your donation is placed at the
          creator&apos;s discretion to cover project costs, and you&apos;ll receive a receipt to keep.
        </p>
      </header>

      <div className="mt-8">
        <CampaignDonationPanel campaignId={campaignId} />
      </div>

      <section className="mt-10" aria-labelledby="donation-simulation-heading">
        <h2 id="donation-simulation-heading" className="text-lg font-semibold tracking-tight text-zinc-100">
          Review before signing
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Confirm the amount, destination, fees, and contract effects for your funding transaction.
          If the preview is stale or the simulation is rejected, re-run it before signing.
        </p>
        <div className="mt-4">
          <SimulationReview flow="funding" campaignId={campaignId} />
        </div>
      </section>

      <section className="mt-12 border-t border-zinc-800 pt-10">
        <div className="flex items-center gap-2">
          <Recycle className="h-5 w-5 text-emerald-400" />
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100">
            Carbon credit secondary market
          </h2>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-zinc-400">
          Sponsors can list carbon credits earned from this campaign and trade them
          with other participants. Browse open listings or sell your own credits.
        </p>
        <div className="mt-6">
          <CarbonTradingPanel campaignId={campaignId} />
        </div>
      </section>
    </main>
  );
}

export const dynamic = "force-dynamic";