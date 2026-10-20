import React from 'react';
import type { Meta } from '@storybook/react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';

const meta: Meta = {
  title: 'Components/FormField',
};

export default meta;

export const Default = () => (
  <div className="space-y-3 w-80" data-testid="formfield-story-default">
    <div className="space-y-1">
      <Label htmlFor="default-name">Full name</Label>
      <Input id="default-name" placeholder="Jane Doe" defaultValue="Jane Doe" />
    </div>
    <div className="space-y-1">
      <Label htmlFor="default-email">Email address</Label>
      <Input id="default-email" placeholder="jane@example.com" defaultValue="jane@example.com" />
    </div>
    <div className="pt-2">
      <Button type="button">Submit</Button>
    </div>
  </div>
);

export const Loading = () => (
  <div
    className="space-y-3 w-80"
    aria-busy="true"
    data-testid="formfield-story-loading"
  >
    <div className="space-y-1">
      <Label htmlFor="loading-name">Full name</Label>
      <Input id="loading-name" value="Jane Doe" disabled readOnly />
    </div>
    <div className="space-y-1">
      <Label htmlFor="loading-email">Email address</Label>
      <Input id="loading-email" value="jane@example.com" disabled readOnly />
    </div>
    <div className="pt-2">
      <Button type="button" disabled aria-busy="true">
        <Loader2 className="animate-spin" aria-hidden="true" />
        Verifying identity…
      </Button>
    </div>
  </div>
);

export const Empty = () => (
  <div className="space-y-3 w-80" data-testid="formfield-story-empty">
    <div className="space-y-1">
      <Label htmlFor="empty-name">Full name</Label>
      <Input id="empty-name" placeholder="Enter your full name" value="" readOnly />
      <p className="text-xs text-zinc-400">No profile details entered yet.</p>
    </div>
    <div className="space-y-1">
      <Label htmlFor="empty-email">Email address</Label>
      <Input id="empty-email" placeholder="Enter your email address" value="" readOnly />
    </div>
    <div className="pt-2">
      <Button type="button" variant="outline">
        Save draft
      </Button>
    </div>
  </div>
);

export const Error = () => (
  <div className="space-y-3 w-80" data-testid="formfield-story-error">
    <div className="space-y-1">
      <Label htmlFor="error-amount">Contribution amount (XLM)</Label>
      <Input
        id="error-amount"
        defaultValue="0"
        aria-invalid="true"
        aria-describedby="error-amount-message"
      />
      <p
        id="error-amount-message"
        role="alert"
        className="flex items-center gap-1.5 text-xs text-rose-400 pt-1"
      >
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Amount must be a positive whole number of at least 1 XLM.
      </p>
    </div>
    <div className="pt-2">
      <Button type="button" variant="destructive">
        Fix errors to continue
      </Button>
    </div>
  </div>
);

export const Disabled = () => (
  <div className="space-y-3 w-80 opacity-75" data-testid="formfield-story-disabled">
    <div className="space-y-1">
      <Label htmlFor="disabled-wallet">Recipient Stellar address</Label>
      <Input
        id="disabled-wallet"
        value="GAAA...AAAAA"
        disabled
        readOnly
      />
      <p className="text-xs text-zinc-500">
        Recipient address is locked while campaign escrow is active.
      </p>
    </div>
    <div className="pt-2">
      <Button type="button" disabled>
        Update locked
      </Button>
    </div>
  </div>
);

export const Success = () => (
  <div className="space-y-3 w-80" data-testid="formfield-story-success">
    <div className="space-y-1">
      <Label htmlFor="success-email">Verified creator email</Label>
      <Input
        id="success-email"
        defaultValue="creator@reforest.org"
        readOnly
        className="border-emerald-500/60"
      />
      <p
        role="status"
        className="flex items-center gap-1.5 text-xs text-emerald-400 pt-1"
      >
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        Domain and nonprofit verification complete.
      </p>
    </div>
    <div className="pt-2">
      <Button type="button">Continue to milestone setup</Button>
    </div>
  </div>
);
