import React from 'react';
import type { Meta } from '@storybook/react';
import FeatureCard from '../../components/modules/dashboard/FeatureCard';

const meta: Meta<typeof FeatureCard> = {
  title: 'Components/ProductCard',
  component: FeatureCard,
};

export default meta;

export const Default = () => (
  <div style={{ width: 360 }} data-testid="productcard-story-default">
    <FeatureCard
      title="Awesome Product"
      linkText="View Details"
      description="A short description of the product highlighting its main benefits and features."
      link="#details"
    />
  </div>
);

export const Loading = () => (
  <div style={{ width: 360 }} data-testid="productcard-story-loading">
    <FeatureCard
      title="Amazon Canopy Restoration"
      linkText="Loading campaign…"
      description="Fetching live tree count and escrow ledger state."
      link="#loading"
      state="loading"
    />
  </div>
);

export const Empty = () => (
  <div style={{ width: 360 }} data-testid="productcard-story-empty">
    <FeatureCard
      title="No Active Campaigns"
      linkText="Create a campaign"
      description="There are no verified reforestation campaigns in this region yet."
      link="/campaigns"
      state="empty"
    />
  </div>
);

export const Error = () => (
  <div style={{ width: 360 }} data-testid="productcard-story-error">
    <FeatureCard
      title="Ledger Sync Error"
      linkText="Retry sync"
      description="Unable to load campaign metrics."
      errorMessage="Soroban RPC node timed out while reading campaign contract state."
      link="#retry"
      state="error"
    />
  </div>
);

export const Disabled = () => (
  <div style={{ width: 360 }} data-testid="productcard-story-disabled">
    <FeatureCard
      title="Carbon Credit Offramp"
      linkText="Temporarily Locked"
      description="Requires a connected Mainnet wallet with verified KYC credentials."
      link="#disabled"
      state="disabled"
      statusBadge="Paused"
    />
  </div>
);

export const Success = () => (
  <div style={{ width: 360 }} data-testid="productcard-story-success">
    <FeatureCard
      title="Mangrove Shield Initiative"
      linkText="View Impact Certificate"
      description="100% of target reached — 7,900 mangrove saplings planted and verified on-chain."
      link="/campaigns"
      state="success"
      statusBadge="Goal Reached"
    />
  </div>
);
