import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Default: Story = {
  render: (args) => <Button {...args}>Click me</Button>,
};

export const Primary: Story = {
  render: (args) => (
    <Button {...args} variant="gradient">
      Primary
    </Button>
  ),
};

export const Outline: Story = {
  render: (args) => (
    <Button {...args} variant="outline">
      Outline
    </Button>
  ),
};

export const Loading: Story = {
  render: (args) => (
    <Button
      {...args}
      disabled
      aria-busy="true"
      aria-label="Submitting transaction"
      data-testid="button-story-loading"
    >
      <Loader2 className="animate-spin" aria-hidden="true" />
      Submitting transaction…
    </Button>
  ),
};

export const Empty: Story = {
  render: (args) => (
    <Button
      {...args}
      variant="ghost"
      aria-label="No action configured"
      data-testid="button-story-empty"
    >
      No action available
    </Button>
  ),
};

export const Error: Story = {
  render: (args) => (
    <Button
      {...args}
      variant="destructive"
      data-testid="button-story-error"
    >
      <AlertCircle aria-hidden="true" />
      Transaction failed — Retry
    </Button>
  ),
};

export const Disabled: Story = {
  render: (args) => (
    <Button
      {...args}
      disabled
      data-testid="button-story-disabled"
    >
      Wallet disconnected
    </Button>
  ),
};

export const Success: Story = {
  render: (args) => (
    <Button
      {...args}
      variant="default"
      className="bg-emerald-600 text-white hover:bg-emerald-500"
      data-testid="button-story-success"
    >
      <CheckCircle2 aria-hidden="true" />
      Contribution confirmed
    </Button>
  ),
};
