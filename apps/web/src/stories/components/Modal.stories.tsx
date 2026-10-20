import React, { useState } from 'react';
import type { Meta } from '@storybook/react';
import { AlertTriangle, CheckCircle2, Inbox, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';

const meta: Meta = {
  title: 'Components/Modal',
};

export default meta;

export const Default = () => {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="modal-story-default">
      <Button type="button" onClick={() => setOpen(true)}>
        Open Modal
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Example Modal</DialogTitle>
            <DialogDescription>This is a simple modal example for Storybook.</DialogDescription>
          </DialogHeader>
          <div className="py-4">Modal body content goes here.</div>
          <div className="flex gap-2 justify-end">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="button">Confirm</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export const Loading = () => (
  <div data-testid="modal-story-loading">
    <Dialog open={true}>
      <DialogContent aria-busy="true">
        <DialogHeader>
          <DialogTitle>Submitting On-Chain Contribution</DialogTitle>
          <DialogDescription>
            Waiting for Soroban ledger confirmation…
          </DialogDescription>
        </DialogHeader>
        <div role="status" className="flex items-center gap-3 py-6 text-sm text-zinc-300">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-400" aria-hidden="true" />
          <span>Broadcasting signed transaction to Stellar Testnet…</span>
        </div>
        <div className="flex gap-2 justify-end">
          <Button type="button" disabled aria-busy="true">
            Processing…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
);

export const Empty = () => (
  <div data-testid="modal-story-empty">
    <Dialog open={true}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pending Milestone Proofs</DialogTitle>
          <DialogDescription>
            Review uploaded field verification evidence before releasing tranche funds.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-zinc-400">
          <Inbox className="h-8 w-8 text-zinc-500" aria-hidden="true" />
          <p className="text-sm font-medium text-zinc-300">No evidence items queued</p>
          <p className="text-xs text-zinc-500">
            All milestone verification proofs have been processed.
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  </div>
);

export const Error = () => (
  <div data-testid="modal-story-error">
    <Dialog open={true}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-300">
            <AlertTriangle className="h-5 w-5 text-rose-400" aria-hidden="true" />
            Simulation Failed
          </DialogTitle>
          <DialogDescription>
            The Soroban contract rejected the transaction simulation.
          </DialogDescription>
        </DialogHeader>
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          HostError: Error(Contract, #4) — Insufficient token allowance for campaign escrow.
        </div>
        <div className="flex gap-2 justify-end">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive">
            Retry simulation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
);

export const Disabled = () => (
  <div data-testid="modal-story-disabled">
    <Button type="button" disabled aria-disabled="true">
      Open Modal (Wallet Required)
    </Button>
  </div>
);

export const Success = () => (
  <div data-testid="modal-story-success">
    <Dialog open={true}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-emerald-300">
            <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            Disbursement Complete
          </DialogTitle>
          <DialogDescription>
            Milestone funds have been released to the verified planting partner.
          </DialogDescription>
        </DialogHeader>
        <div
          role="status"
          className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200"
        >
          Verified on Stellar ledger #5120026 · 250 XLM transferred.
        </div>
        <div className="flex gap-2 justify-end">
          <DialogClose asChild>
            <Button type="button">Done</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  </div>
);
